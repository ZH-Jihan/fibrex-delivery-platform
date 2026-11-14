/**
 * Party identifiers API: QID, passport, Falcon ID, ... (PLAN 5.7).
 *
 *   /party-identifiers                  CRUD factory (value is write-only; lists show a mask)
 *   GET  /party-identifiers/lookup      who holds this identifier (exact match, on a date)
 *   POST /party-identifiers/{id}/reveal the real value; needs its own permission; audited
 *
 * Rules, and why:
 *   1. The value is stored encrypted, with a keyed hash and a mask (./vault.ts). Responses
 *      carry the mask, and the plain value only for non-sensitive platform ids.
 *   2. The same identifier can move between people over time but never be held by two
 *      parties on the same day: the database refuses it (party_identifier_no_overlap) and
 *      this layer turns that into a clear 409. To move an id, end the first holder's
 *      period (valid_to) and add it to the new holder.
 *   3. Looking up a sensitive id is an exact match on the hash; there is no "contains"
 *      search over QIDs or passports.
 *   4. Revealing is a deliberate act with its own permission, written to the audit log.
 *
 * Depends on: express, zod, kernel/http, kernel/db, kernel/audit, ./vault.ts, ./common.ts.
 * Used by: ./index.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { Router } from 'express';
import { z } from 'zod';
import type { AuditService } from '../../kernel/audit/audit-service.js';
import type { Db } from '../../kernel/db/prisma.js';
import { createRepository, type Repository } from '../../kernel/db/repository.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { createCrudRouter } from '../../kernel/http/crud-router.js';
import { NotFoundError } from '../../kernel/http/errors.js';
import { registerRoute } from '../../kernel/http/openapi.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import { fromDate, guardExclusion, toDate, withDates } from './common.js';
import {
  isSensitiveIdentifierType,
  maskValue,
  normaliseSecretValue,
  type PartyVault,
} from './vault.js';

export type IdentifierRow = NonNullable<Awaited<ReturnType<Db['partyIdentifier']['findFirst']>>>;

const date = z.iso.date();
const type = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,39}$/, 'lower-case letters, digits and underscores');
const value = z.string().trim().min(2).max(64);
const create = z.strictObject({
  partyId: z.uuid(),
  type,
  value,
  clientPlatformId: z.uuid().nullable().optional(),
  validFrom: date.optional(),
  validTo: date.nullable().optional(),
});
const update = z.strictObject({
  value: value.optional(),
  clientPlatformId: z.uuid().nullable().optional(),
  validFrom: date.optional(),
  validTo: date.nullable().optional(),
});
const filter = z.object({ partyId: z.uuid().optional(), type: type.optional() });
const item = z
  .object({
    id: z.uuid(),
    partyId: z.uuid(),
    type: z.string(),
    clientPlatformId: z.uuid().nullable(),
    valueMasked: z.string(),
    valuePlain: z.string().nullable(),
    validFrom: date,
    validTo: date.nullable(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'PartyIdentifier' });
const lookupQuery = z.object({
  type,
  value,
  asOf: date.optional(),
  clientPlatformId: z.uuid().optional(),
});
const lookupResponse = z.object({
  items: z.array(
    z.object({
      identifierId: z.uuid(),
      partyId: z.uuid(),
      displayName: z.string(),
      validFrom: date,
      validTo: date.nullable(),
    }),
  ),
});
const revealResponse = z.object({ value: z.string() }).meta({ id: 'RevealedValue' });
const idParams = z.object({ id: z.uuid() });

export function toIdentifierItem(row: IdentifierRow) {
  return {
    id: row.id,
    partyId: row.partyId,
    type: row.type,
    clientPlatformId: row.clientPlatformId,
    valueMasked: row.valueMasked,
    valuePlain: row.valuePlain,
    validFrom: fromDate(row.validFrom),
    validTo: fromDate(row.validTo),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

/** The columns that hold one identifier value, from the plain input (rule 1). */
function valueColumns(vault: PartyVault, tenantId: string, identifierType: string, raw: string) {
  const normalised = normaliseSecretValue(raw);
  return {
    valueEncrypted: vault.seal(normalised, 'party.identifier'),
    valueHash: vault.hash(tenantId, `identifier:${identifierType}`, normalised),
    valueMasked: maskValue(normalised),
    valuePlain: isSensitiveIdentifierType(identifierType) ? null : normalised,
  };
}

export function createIdentifierRepository(vault: PartyVault): Repository<IdentifierRow> {
  const base = createRepository<IdentifierRow>({ model: 'partyIdentifier', scope: 'company' });
  const dates = ['validFrom', 'validTo'] as const;
  return {
    ...base,
    create: (data) => {
      const { tenantId } = currentUnit().context;
      const { value: raw, ...rest } = data;
      return guardExclusion(() =>
        base.create(
          withDates(
            { ...rest, ...valueColumns(vault, tenantId, String(data.type), String(raw)) },
            dates,
          ),
        ),
      );
    },
    update: async (id, version, changes) => {
      const { value: raw, ...rest } = changes;
      let next: Record<string, unknown> = rest;
      if (typeof raw === 'string') {
        const current = await base.get(id);
        const { tenantId } = currentUnit().context;
        next = { ...rest, ...valueColumns(vault, tenantId, current.type, raw) };
      }
      return guardExclusion(() => base.update(id, version, withDates(next, dates)));
    },
    restore: (id, version) => guardExclusion(() => base.restore(id, version)),
  };
}

export interface IdentifierRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  audit: AuditService;
  vault: PartyVault;
  repository: Repository<IdentifierRow>;
}

export function createIdentifierRouter(deps: IdentifierRouterDeps): Router {
  const { uow, registry, permissions, audit, vault, repository } = deps;
  const router = Router();

  // Registered before the factory so "lookup" is not read as an id.
  router.get('/party-identifiers/lookup', async (req, res) => {
    const query = lookupQuery.parse(req.query);
    const items = await uow.run(async (db) => {
      await permissions.require('party.identifier.read');
      const { tenantId } = currentUnit().context;
      const asOf = query.asOf === undefined ? new Date() : toDate(query.asOf);
      const rows = await db.partyIdentifier.findMany({
        where: {
          type: query.type,
          valueHash: vault.hash(
            tenantId,
            `identifier:${query.type}`,
            normaliseSecretValue(query.value),
          ),
          ...(query.clientPlatformId === undefined
            ? {}
            : { clientPlatformId: query.clientPlatformId }),
          validFrom: { lte: asOf },
          OR: [{ validTo: null }, { validTo: { gte: asOf } }],
        },
        include: { party: { select: { displayName: true } } },
        orderBy: { validFrom: 'desc' },
        take: 20,
      });
      return rows.map((row) => ({
        identifierId: row.id,
        partyId: row.partyId,
        displayName: row.party.displayName,
        validFrom: fromDate(row.validFrom),
        validTo: fromDate(row.validTo),
      }));
    });
    res.json({ items });
  });

  router.post('/party-identifiers/:id/reveal', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const revealed = await uow.run(async (db) => {
      await permissions.require('party.identifier.reveal');
      const row = await db.partyIdentifier.findFirst({ where: { id } });
      if (row === null) throw new NotFoundError();
      // The audit row is written in the same transaction: no reveal without a record.
      await audit.record({
        action: 'reveal',
        moduleKey: 'party',
        entityType: 'party.party_identifier',
        entityId: row.id,
        companyId: row.companyId,
        meta: { type: row.type, partyId: row.partyId },
      });
      return vault.open(row.valueEncrypted, 'party.identifier');
    });
    res.json({ value: revealed });
  });

  router.use(
    createCrudRouter(
      { uow, authorize: permissions.authorize, registry },
      {
        path: '/party-identifiers',
        resource: 'party.identifier',
        tag: 'Party identifiers',
        repository,
        schemas: { create, update, item, filter },
        toItem: toIdentifierItem,
        toWhere: (f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)),
      },
    ),
  );

  const tags = ['Party identifiers'];
  registerRoute(registry, {
    method: 'get',
    path: '/party-identifiers/lookup',
    tags,
    summary: 'Who holds this identifier (exact match)',
    request: { query: lookupQuery },
    responses: {
      200: { description: 'Holders', content: { 'application/json': { schema: lookupResponse } } },
    },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/party-identifiers/{id}/reveal',
    tags,
    summary: 'Show the real value (audited)',
    request: { params: idParams },
    responses: {
      200: {
        description: 'The value',
        content: { 'application/json': { schema: revealResponse } },
      },
    },
  });
  return router;
}
