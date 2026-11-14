/**
 * Party merge: preview and execute.
 *
 * Purpose: when two parties turn out to be one person, everything that pointed at the
 * duplicate must point at the survivor, and the duplicate must stay on record as history.
 * Rules, and why:
 *   1. Same company, same kind (a person is never merged into an organisation), neither
 *      already merged. The two rows are locked first, so two merges cannot cross.
 *   2. Nothing is deleted. The merged party is soft-deleted with `merged_into_id` set; a
 *      snapshot of it and its children is stored in party_merge. It cannot be restored
 *      from the recycle bin (see party-router.ts), because its data now lives elsewhere.
 *   3. This module's own children (roles, identifiers, contacts, addresses, bank accounts,
 *      relationships) are moved. A contact or bank account the survivor already has is
 *      soft-deleted instead of duplicated; a primary contact never displaces the
 *      survivor's. A relationship between the two parties would point at itself, so it is
 *      closed.
 *   4. Other modules' references are moved through the reference registry: each module
 *      declares "this column holds a party_id" once (src/main.ts), so the party module
 *      never imports another module (SPEC 2.13) and a new module cannot be forgotten.
 *   5. The survivor keeps its own values and only fills gaps from the merged party.
 *   6. The merge itself is audited as a 'merge' event on the survivor.
 *
 * Depends on: kernel/db, kernel/audit, kernel/permissions, ./duplicates.ts.
 * Used by: ./index.ts, src/main.ts (reference registration).
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { Router } from 'express';
import { z } from 'zod';
import type { AuditService } from '../../kernel/audit/audit-service.js';
import type { Db } from '../../kernel/db/prisma.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../kernel/http/errors.js';
import { registerRoute } from '../../kernel/http/openapi.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import { detectDuplicates } from './duplicates.js';

/** A column in another module that holds a party id and must follow a merge. */
export interface PartyReference {
  schema: string;
  table: string;
  column: string;
  /** Shown in the preview, for example "Login accounts". */
  label: string;
  /** Trusted SQL fragment that narrows the rows, for example "entity_type = 'party.party'". */
  where?: string;
}

/** A copy of a row without one (secret) column. */
function without<T extends object>(row: T, key: keyof T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([name]) => name !== key));
}

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

export class PartyReferenceRegistry {
  private readonly references: PartyReference[] = [];

  register(reference: PartyReference): void {
    // These names are put into SQL text, so only plain identifiers are accepted.
    for (const part of [reference.schema, reference.table, reference.column]) {
      if (!IDENTIFIER.test(part)) throw new Error(`Invalid party reference name: ${part}`);
    }
    this.references.push(reference);
  }

  all(): readonly PartyReference[] {
    return this.references;
  }
}

const mergeRequest = z.strictObject({ survivorId: z.uuid(), mergedId: z.uuid() });
const mergeExecute = mergeRequest.extend({ reason: z.string().trim().min(3).max(500) });
const countMap = z.record(z.string(), z.number().int());
const previewResponse = z
  .object({
    survivor: z.object({ id: z.uuid(), displayName: z.string() }),
    merged: z.object({ id: z.uuid(), displayName: z.string() }),
    moves: countMap,
    closed: countMap,
    references: countMap,
  })
  .meta({ id: 'PartyMergePreview' });
const mergeResponse = z
  .object({ mergeId: z.uuid(), survivorId: z.uuid() })
  .meta({ id: 'PartyMerge' });

interface Counts {
  moves: Record<string, number>;
  closed: Record<string, number>;
  references: Record<string, number>;
}

export class PartyMergeService {
  private readonly deps: {
    permissions: PermissionService;
    audit: AuditService;
    references: PartyReferenceRegistry;
  };

  constructor(deps: {
    permissions: PermissionService;
    audit: AuditService;
    references: PartyReferenceRegistry;
  }) {
    this.deps = deps;
  }

  /** Both parties, locked, after the rule 1 checks. */
  private async load(db: Db, survivorId: string, mergedId: string, lock: boolean) {
    if (survivorId === mergedId) {
      throw new UnprocessableError('same_party', 'A party cannot be merged into itself.');
    }
    if (lock) {
      // Lock in id order so two opposite merges cannot wait for each other.
      const ids = [survivorId, mergedId].sort();
      await db.$queryRaw`SELECT id FROM party.party WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
    }
    const survivor = await db.party.findFirst({ where: { id: survivorId } });
    const merged = await db.party.findFirst({ where: { id: mergedId } });
    if (survivor === null || merged === null) throw new NotFoundError();
    if (survivor.companyId !== merged.companyId) {
      throw new UnprocessableError('different_company', 'Both parties must belong to one company.');
    }
    if (survivor.kind !== merged.kind) {
      throw new UnprocessableError(
        'different_kind',
        'A person cannot be merged with an organisation.',
      );
    }
    if (survivor.mergedIntoId !== null || merged.mergedIntoId !== null) {
      throw new ConflictError('already_merged', 'One of these parties was already merged.');
    }
    return { survivor, merged };
  }

  private async referenceCount(
    db: Db,
    reference: PartyReference,
    mergedId: string,
  ): Promise<number> {
    const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM "${reference.schema}"."${reference.table}"
        WHERE "${reference.column}" = $1::uuid${reference.where === undefined ? '' : ` AND ${reference.where}`}`,
      mergedId,
    );
    return Number(rows[0]?.n ?? 0);
  }

  async preview(survivorId: string, mergedId: string) {
    await this.deps.permissions.require('party.party.merge');
    const { db } = currentUnit();
    const { survivor, merged } = await this.load(db, survivorId, mergedId, false);
    const counts = await this.count(db, survivor.id, merged.id);
    return {
      survivor: { id: survivor.id, displayName: survivor.displayName },
      merged: { id: merged.id, displayName: merged.displayName },
      ...counts,
    };
  }

  /** What a merge would move, close and repoint. Used by both preview and execute. */
  private async count(db: Db, survivorId: string, mergedId: string): Promise<Counts> {
    const survivorContacts = await db.partyContact.findMany({
      where: { partyId: survivorId },
      select: { kind: true, value: true },
    });
    const survivorBanks = await db.partyBankAccount.findMany({
      where: { partyId: survivorId },
      select: { ibanHash: true },
    });
    const contacts = await db.partyContact.findMany({ where: { partyId: mergedId } });
    const banks = await db.partyBankAccount.findMany({ where: { partyId: mergedId } });
    const sameContact = contacts.filter((c) =>
      survivorContacts.some((s) => s.kind === c.kind && s.value === c.value),
    ).length;
    const sameBank = banks.filter((b) =>
      survivorBanks.some((s) => s.ibanHash === b.ibanHash),
    ).length;
    const between = await db.partyRelationship.count({
      where: {
        OR: [
          { fromPartyId: mergedId, toPartyId: survivorId },
          { fromPartyId: survivorId, toPartyId: mergedId },
        ],
      },
    });
    const references: Record<string, number> = {};
    for (const reference of this.deps.references.all()) {
      references[reference.label] = await this.referenceCount(db, reference, mergedId);
    }
    return {
      moves: {
        roles: await db.partyRole.count({ where: { partyId: mergedId } }),
        identifiers: await db.partyIdentifier.count({ where: { partyId: mergedId } }),
        contacts: contacts.length - sameContact,
        addresses: await db.partyAddress.count({ where: { partyId: mergedId } }),
        bankAccounts: banks.length - sameBank,
        relationships:
          (await db.partyRelationship.count({
            where: { OR: [{ fromPartyId: mergedId }, { toPartyId: mergedId }] },
          })) - between,
      },
      closed: {
        duplicateContacts: sameContact,
        duplicateBankAccounts: sameBank,
        relationshipsBetweenThem: between,
      },
      references,
    };
  }

  async execute(survivorId: string, mergedId: string, reason: string) {
    await this.deps.permissions.require('party.party.merge');
    const { db, context } = currentUnit();
    const { survivor, merged } = await this.load(db, survivorId, mergedId, true);
    const counts = await this.count(db, survivor.id, merged.id);
    const stamp = { deletedAt: new Date(), deletedBy: context.userId ?? null };
    const dupReason = `Duplicate of a record of ${survivor.displayName}, merged`;

    // Rule 2: the snapshot, taken before anything moves.
    const snapshot = JSON.parse(
      JSON.stringify({
        party: merged,
        roles: await db.partyRole.findMany({ where: { partyId: mergedId } }),
        contacts: await db.partyContact.findMany({ where: { partyId: mergedId } }),
        addresses: await db.partyAddress.findMany({ where: { partyId: mergedId } }),
        relationshipsFrom: await db.partyRelationship.findMany({
          where: { fromPartyId: mergedId },
        }),
        relationshipsTo: await db.partyRelationship.findMany({ where: { toPartyId: mergedId } }),
        // Sensitive values stay encrypted: the snapshot keeps hashes and masks only.
        identifiers: (await db.partyIdentifier.findMany({ where: { partyId: mergedId } })).map(
          (row) => without(row, 'valueEncrypted'),
        ),
        bankAccounts: (await db.partyBankAccount.findMany({ where: { partyId: mergedId } })).map(
          (row) => without(row, 'ibanEncrypted'),
        ),
      }),
      (_key, value: unknown) => (typeof value === 'bigint' ? Number(value) : value),
    ) as object;

    // Rule 3: relationships between the two close; contacts and bank accounts not new close.
    await db.partyRelationship.updateMany({
      where: {
        OR: [
          { fromPartyId: mergedId, toPartyId: survivorId },
          { fromPartyId: survivorId, toPartyId: mergedId },
        ],
      },
      data: { ...stamp, deleteReason: 'Both sides are now the same party' },
    });
    const survivorContacts = await db.partyContact.findMany({ where: { partyId: survivorId } });
    for (const contact of await db.partyContact.findMany({ where: { partyId: mergedId } })) {
      const same = survivorContacts.some(
        (s) => s.kind === contact.kind && s.value === contact.value,
      );
      if (same) {
        await db.partyContact.update({
          where: { id: contact.id },
          data: { ...stamp, deleteReason: dupReason },
        });
      } else {
        const hasPrimary = survivorContacts.some((s) => s.kind === contact.kind && s.isPrimary);
        await db.partyContact.update({
          where: { id: contact.id },
          data: { partyId: survivorId, ...(hasPrimary ? { isPrimary: false } : {}) },
        });
      }
    }
    const survivorBanks = await db.partyBankAccount.findMany({ where: { partyId: survivorId } });
    for (const bank of await db.partyBankAccount.findMany({ where: { partyId: mergedId } })) {
      if (survivorBanks.some((s) => s.ibanHash === bank.ibanHash)) {
        await db.partyBankAccount.update({
          where: { id: bank.id },
          data: { ...stamp, deleteReason: dupReason },
        });
      } else {
        await db.partyBankAccount.update({ where: { id: bank.id }, data: { partyId: survivorId } });
      }
    }
    await db.partyRole.updateMany({ where: { partyId: mergedId }, data: { partyId: survivorId } });
    await db.partyIdentifier.updateMany({
      where: { partyId: mergedId },
      data: { partyId: survivorId },
    });
    await db.partyAddress.updateMany({
      where: { partyId: mergedId },
      data: { partyId: survivorId },
    });
    await db.partyRelationship.updateMany({
      where: { fromPartyId: mergedId },
      data: { fromPartyId: survivorId },
    });
    await db.partyRelationship.updateMany({
      where: { toPartyId: mergedId },
      data: { toPartyId: survivorId },
    });

    // Rule 4: other modules' references.
    for (const reference of this.deps.references.all()) {
      await db.$executeRawUnsafe(
        `UPDATE "${reference.schema}"."${reference.table}" SET "${reference.column}" = $1::uuid
          WHERE "${reference.column}" = $2::uuid${reference.where === undefined ? '' : ` AND ${reference.where}`}`,
        survivorId,
        mergedId,
      );
    }

    // Rule 5: gaps only.
    await db.party.update({
      where: { id: survivorId },
      data: {
        dateOfBirth: survivor.dateOfBirth ?? merged.dateOfBirth,
        gender: survivor.gender ?? merged.gender,
        nationalityCode: survivor.nationalityCode ?? merged.nationalityCode,
        photoFileId: survivor.photoFileId ?? merged.photoFileId,
        names: { ...(merged.names as object), ...(survivor.names as object) },
        customFields: { ...(merged.customFields as object), ...(survivor.customFields as object) },
      },
    });
    await db.party.update({
      where: { id: mergedId },
      data: {
        mergedIntoId: survivorId,
        ...stamp,
        deleteReason: `Merged into ${survivor.displayName}: ${reason}`,
      },
    });

    const record = await db.partyMerge.create({
      data: {
        tenantId: survivor.tenantId,
        companyId: survivor.companyId,
        survivorId,
        mergedId,
        snapshot,
        repointedRefs: { ...counts, reason },
      },
      select: { id: true },
    });

    // Candidates: this pair is merged; pairs with the vanished party are obsolete.
    const [a, b] = survivorId < mergedId ? [survivorId, mergedId] : [mergedId, survivorId];
    await db.partyDuplicateCandidate.updateMany({
      where: { partyAId: a, partyBId: b },
      data: { status: 'merged' },
    });
    await db.partyDuplicateCandidate.updateMany({
      where: { OR: [{ partyAId: mergedId }, { partyBId: mergedId }] },
      data: { ...stamp, deleteReason: 'A party in this pair was merged' },
    });
    // The survivor now has more data: look again.
    await detectDuplicates(db, survivorId);

    await this.deps.audit.record({
      action: 'merge',
      moduleKey: 'party',
      entityType: 'party.party',
      entityId: survivorId,
      companyId: survivor.companyId,
      meta: { mergedId, reason, mergeId: record.id, ...counts },
    });
    return { mergeId: record.id, survivorId };
  }
}

export interface MergeRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  merges: PartyMergeService;
}

export function createMergeRouter({ uow, registry, merges }: MergeRouterDeps): Router {
  const router = Router();
  router.post('/party-merges/preview', async (req, res) => {
    const body = mergeRequest.parse(req.body);
    res.json(await uow.run(() => merges.preview(body.survivorId, body.mergedId)));
  });
  router.post('/party-merges', async (req, res) => {
    const body = mergeExecute.parse(req.body);
    res
      .status(201)
      .json(await uow.run(() => merges.execute(body.survivorId, body.mergedId, body.reason)));
  });
  const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
  registerRoute(registry, {
    method: 'post',
    path: '/party-merges/preview',
    tags: ['Party merge'],
    summary: 'What merging two parties would move and close',
    request: { body: json(mergeRequest) },
    responses: { 200: { description: 'The preview', ...json(previewResponse) } },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/party-merges',
    tags: ['Party merge'],
    summary: 'Merge one party into another',
    request: { body: json(mergeExecute) },
    responses: { 201: { description: 'Merged', ...json(mergeResponse) } },
  });
  return router;
}
