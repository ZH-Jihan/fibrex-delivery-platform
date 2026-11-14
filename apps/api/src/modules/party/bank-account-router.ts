/**
 * Party bank accounts and wallets API (PLAN 5.7, SPEC 5.9 and 6.5).
 *
 *   /party-bank-accounts                     CRUD factory (the number is write-only)
 *   POST /party-bank-accounts/{id}/verify    someone checked the proof document
 *   POST /party-bank-accounts/{id}/approve   a SECOND person approves it for payment
 *   POST /party-bank-accounts/{id}/reject    refuse it, with a note
 *   POST /party-bank-accounts/{id}/reveal    the real number; own permission; audited
 *
 * Rules, and why (a changed payout account is the classic route to payroll fraud):
 *   1. A new account starts `pending`, owned by whoever requested it.
 *   2. ANY change to the number, bank, name, wallet provider or proof document sends the
 *      account back to `pending`, clears every earlier check, and makes the person who
 *      changed it the new requester. An approved account cannot be quietly altered.
 *   3. Approval needs a different person from the requester. The service checks it and the
 *      database refuses it too (party_bank_account_two_person_ck).
 *   4. When a proof document is attached, someone must have checked it (verify) before the
 *      account can be approved.
 *   5. The number is stored encrypted with a keyed hash and a mask; revealing it needs its
 *      own permission and is written to the audit log.
 *   Payments (Phase 7) will pay only accounts whose status is `verified`.
 *
 * Depends on: express, zod, kernel/http, kernel/db, kernel/audit, ./vault.ts.
 * Used by: ./index.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { Router, type Response } from 'express';
import { z } from 'zod';
import type { AuditService } from '../../kernel/audit/audit-service.js';
import type { Db } from '../../kernel/db/prisma.js';
import { createRepository, type Repository } from '../../kernel/db/repository.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { createCrudRouter, parseIfMatch } from '../../kernel/http/crud-router.js';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '../../kernel/http/errors.js';
import { registerRoute } from '../../kernel/http/openapi.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import { maskValue, normaliseSecretValue, type PartyVault } from './vault.js';

export type BankAccountRow = NonNullable<Awaited<ReturnType<Db['partyBankAccount']['findFirst']>>>;

const text = (max: number) => z.string().trim().min(1).max(max);
const fields = {
  kind: z.enum(['bank', 'wallet']),
  bankName: text(200).nullable().optional(),
  number: z.string().trim().min(4).max(64),
  accountName: text(200),
  walletProvider: text(100).nullable().optional(),
  proofFileId: z.uuid().nullable().optional(),
};
const create = z.strictObject({ partyId: z.uuid(), ...fields });
const update = z.strictObject(fields).omit({ kind: true }).partial();
const filter = z.object({
  partyId: z.uuid().optional(),
  status: z.enum(['pending', 'verified', 'rejected']).optional(),
});
const item = z
  .object({
    id: z.uuid(),
    partyId: z.uuid(),
    kind: z.string(),
    bankName: z.string().nullable(),
    numberMasked: z.string(),
    accountName: z.string(),
    walletProvider: z.string().nullable(),
    status: z.string(),
    proofFileId: z.uuid().nullable(),
    requestedBy: z.uuid(),
    proofCheckedBy: z.uuid().nullable(),
    proofCheckedAt: z.iso.datetime().nullable(),
    approvedBy: z.uuid().nullable(),
    approvedAt: z.iso.datetime().nullable(),
    reviewNote: z.string().nullable(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'PartyBankAccount' });
const rejectBody = z.strictObject({ note: text(500) });
const idParams = z.object({ id: z.uuid() });

export function toBankAccountItem(row: BankAccountRow) {
  return {
    id: row.id,
    partyId: row.partyId,
    kind: row.kind,
    bankName: row.bankName,
    numberMasked: row.ibanMasked,
    accountName: row.accountName,
    walletProvider: row.walletProvider,
    status: row.status,
    proofFileId: row.proofFileId,
    requestedBy: row.requestedBy,
    proofCheckedBy: row.proofCheckedBy,
    proofCheckedAt: row.proofCheckedAt?.toISOString() ?? null,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    reviewNote: row.reviewNote,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

/** The signed-in person; an integration key has none and cannot request or approve. */
function actingUser(): string {
  const { userId } = currentUnit().context;
  if (userId === undefined) {
    throw new BadRequestError('user_required', 'A signed-in user is needed for bank accounts.');
  }
  return userId;
}

export interface BankAccountRepository extends Repository<BankAccountRow> {
  /** A review step (verify, approve, reject): written as given, without the rule 2 reset. */
  transition(
    id: string,
    version: number,
    changes: Record<string, unknown>,
  ): Promise<BankAccountRow>;
}

export function createBankAccountRepository(vault: PartyVault): BankAccountRepository {
  const base = createRepository<BankAccountRow>({ model: 'partyBankAccount', scope: 'company' });

  const numberColumns = (raw: string) => {
    const normalised = normaliseSecretValue(raw);
    return {
      ibanEncrypted: vault.seal(normalised, 'party.bank_account'),
      ibanHash: vault.hash(currentUnit().context.tenantId, 'bank', normalised),
      ibanMasked: maskValue(normalised),
    };
  };

  return {
    ...base,
    transition: (id, version, changes) => base.update(id, version, changes),
    // Rule 1.
    create: (data) => {
      const { number, ...rest } = data;
      return base.create({
        ...rest,
        ...numberColumns(String(number)),
        status: 'pending',
        requestedBy: actingUser(),
      });
    },
    // Rule 2.
    update: async (id, version, changes) => {
      const current = await base.get(id);
      const { number, ...rest } = changes;
      const next: Record<string, unknown> = { ...rest };
      if (typeof number === 'string') {
        const columns = numberColumns(number);
        // The same number typed again is not a change (and must not reset the approval).
        if (columns.ibanHash !== current.ibanHash) Object.assign(next, columns);
      }
      const touched = Object.entries(next).some(
        ([key, value]) => (current as unknown as Record<string, unknown>)[key] !== value,
      );
      if (!touched) return base.update(id, version, {});
      return base.update(id, version, {
        ...next,
        status: 'pending',
        requestedBy: actingUser(),
        proofCheckedBy: null,
        proofCheckedAt: null,
        approvedBy: null,
        approvedAt: null,
        reviewNote: null,
      });
    },
  };
}

export interface BankAccountRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  audit: AuditService;
  vault: PartyVault;
  repository: BankAccountRepository;
}

export function createBankAccountRouter(deps: BankAccountRouterDeps): Router {
  const { uow, registry, permissions, audit, vault, repository } = deps;
  const router = Router();

  /** Runs one review step: permission, load, step rules, versioned write, audit event. */
  async function review(
    id: string,
    version: number,
    permission: string,
    action: 'verify' | 'approve' | 'reject',
    step: (row: BankAccountRow, userId: string) => Record<string, unknown>,
  ): Promise<BankAccountRow> {
    return uow.run(async (db) => {
      await permissions.require(permission);
      const userId = actingUser();
      const row = await db.partyBankAccount.findFirst({ where: { id } });
      if (row === null) throw new NotFoundError();
      if (row.status !== 'pending') {
        throw new UnprocessableError(
          'not_pending',
          'Only an account that is waiting for review can be reviewed.',
        );
      }
      const updated = await repository.transition(id, version, step(row, userId));
      await audit.record({
        action,
        moduleKey: 'party',
        entityType: 'party.party_bank_account',
        entityId: id,
        companyId: row.companyId,
      });
      return updated;
    });
  }

  const send = (res: Response, row: BankAccountRow) =>
    res
      .status(200)
      .setHeader('ETag', `"${String(row.version)}"`)
      .json(toBankAccountItem(row));

  router.post('/party-bank-accounts/:id/verify', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const version = parseIfMatch(req.get('If-Match'));
    send(
      res,
      await review(id, version, 'party.bank_account.verify', 'verify', (row, userId) => {
        if (row.proofFileId === null) {
          throw new UnprocessableError('no_proof', 'Attach the proof document first.');
        }
        return { proofCheckedBy: userId, proofCheckedAt: new Date() };
      }),
    );
  });

  router.post('/party-bank-accounts/:id/approve', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const version = parseIfMatch(req.get('If-Match'));
    send(
      res,
      await review(id, version, 'party.bank_account.approve', 'approve', (row, userId) => {
        // Rule 3.
        if (row.requestedBy === userId) {
          throw new ForbiddenError(
            'A second person must approve this account, not the one who requested it.',
          );
        }
        // Rule 4.
        if (row.proofFileId !== null && row.proofCheckedAt === null) {
          throw new UnprocessableError(
            'proof_not_checked',
            'Check the proof document before approving.',
          );
        }
        return { status: 'verified', approvedBy: userId, approvedAt: new Date(), reviewNote: null };
      }),
    );
  });

  router.post('/party-bank-accounts/:id/reject', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const version = parseIfMatch(req.get('If-Match'));
    const { note } = rejectBody.parse(req.body);
    send(
      res,
      await review(id, version, 'party.bank_account.approve', 'reject', () => ({
        status: 'rejected',
        reviewNote: note,
      })),
    );
  });

  router.post('/party-bank-accounts/:id/reveal', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const revealed = await uow.run(async (db) => {
      await permissions.require('party.bank_account.reveal');
      const row = await db.partyBankAccount.findFirst({ where: { id } });
      if (row === null) throw new NotFoundError();
      await audit.record({
        action: 'reveal',
        moduleKey: 'party',
        entityType: 'party.party_bank_account',
        entityId: row.id,
        companyId: row.companyId,
        meta: { partyId: row.partyId },
      });
      return vault.open(row.ibanEncrypted, 'party.bank_account');
    });
    res.json({ value: revealed });
  });

  router.use(
    createCrudRouter(
      { uow, authorize: permissions.authorize, registry },
      {
        path: '/party-bank-accounts',
        resource: 'party.bank_account',
        tag: 'Party bank accounts',
        repository,
        schemas: { create, update, item, filter },
        toItem: toBankAccountItem,
        toWhere: (f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)),
      },
    ),
  );

  const tags = ['Party bank accounts'];
  const ifMatch = z.object({ 'if-match': z.string().describe('The account version, e.g. "3"') });
  const reviewResponses = {
    200: {
      description: 'The account after the step',
      content: { 'application/json': { schema: item } },
    },
  };
  for (const [name, summary] of [
    ['verify', 'Mark the proof document as checked'],
    ['approve', 'Approve for payment (a second person)'],
  ] as const) {
    registerRoute(registry, {
      method: 'post',
      path: `/party-bank-accounts/{id}/${name}`,
      tags,
      summary,
      request: { params: idParams, headers: ifMatch },
      responses: reviewResponses,
    });
  }
  registerRoute(registry, {
    method: 'post',
    path: '/party-bank-accounts/{id}/reject',
    tags,
    summary: 'Refuse the account, with a note',
    request: {
      params: idParams,
      headers: ifMatch,
      body: { content: { 'application/json': { schema: rejectBody } } },
    },
    responses: reviewResponses,
  });
  registerRoute(registry, {
    method: 'post',
    path: '/party-bank-accounts/{id}/reveal',
    tags,
    summary: 'Show the real number (audited)',
    request: { params: idParams },
    responses: {
      200: {
        description: 'The number',
        content: { 'application/json': { schema: z.object({ value: z.string() }) } },
      },
    },
  });
  return router;
}
