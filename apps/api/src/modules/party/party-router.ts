/**
 * Party API: parties, roles, contacts, addresses and relationships (PLAN 5.7).
 *
 * Paths are flat (`/parties`, `/party-roles?partyId=`, `/party-contacts?partyId=` ...) so
 * every resource uses the same CRUD factory, and with it the same permission check,
 * optimistic locking (ETag / If-Match), soft delete with reason, restore and audit.
 *
 * Rules enforced here on top of the factory, and why:
 *   1. A party is found by name, phone, e-mail or a non-sensitive platform id (`q`).
 *      Sensitive ids (QID, passport) are found only by exact lookup (identifier-router).
 *   2. After a party is created or its name or birth date changes, duplicates are looked
 *      for (./duplicates.ts), so a second record of the same person is flagged at once.
 *   3. A merged party cannot be restored: its data now belongs to the survivor.
 *   4. Contacts are stored normalised (phone in international form, e-mail in lower case)
 *      so "+974 5555 1234" and "+97455551234" are the same value; a new primary contact
 *      replaces the old primary of that kind instead of failing.
 *   5. A role or relationship names a party of the same company; the database foreign key
 *      includes the company, so another company's party is refused.
 *
 * Depends on: express, zod, kernel/http (CRUD factory), kernel/db, ./duplicates.ts,
 * ./common.ts. Used by: ./index.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../../kernel/db/prisma.js';
import { createRepository, type Repository } from '../../kernel/db/repository.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { createCrudRouter } from '../../kernel/http/crud-router.js';
import { ConflictError, ValidationError } from '../../kernel/http/errors.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import { fromDate, guardExclusion, withDates } from './common.js';
import { detectDuplicates } from './duplicates.js';

export type PartyRow = NonNullable<Awaited<ReturnType<Db['party']['findFirst']>>>;
export type RoleRow = NonNullable<Awaited<ReturnType<Db['partyRole']['findFirst']>>>;
export type ContactRow = NonNullable<Awaited<ReturnType<Db['partyContact']['findFirst']>>>;
export type AddressRow = NonNullable<Awaited<ReturnType<Db['partyAddress']['findFirst']>>>;
export type RelationshipRow = NonNullable<
  Awaited<ReturnType<Db['partyRelationship']['findFirst']>>
>;

const date = z.iso.date();
const code = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,39}$/, 'lower-case letters, digits and underscores');
const country = z.string().regex(/^[A-Z]{2}$/, 'a two-letter country code, e.g. QA');
const phone = z.string().regex(/^\+[1-9][0-9]{6,14}$/, 'international form, e.g. +97455551234');
const stamps = {
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
};
function stampsOf(row: {
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}) {
  return {
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

/** Phone numbers lose spaces and dashes; e-mail is lower case. */
function normaliseContact(kind: string, value: string): string {
  const trimmed = value.trim();
  return kind === 'email' ? trimmed.toLowerCase() : trimmed.replace(/[\s()-]+/g, '');
}

// ---- Party -------------------------------------------------------------------------------
const partyFields = {
  displayName: z.string().trim().min(1).max(300),
  names: z.record(z.string().min(2).max(8), z.string().trim().min(1).max(300)).optional(),
  dateOfBirth: date.nullable().optional(),
  gender: z.enum(['female', 'male', 'other']).nullable().optional(),
  nationalityCode: country.nullable().optional(),
  photoFileId: z.uuid().nullable().optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
};
const partyCreate = z.strictObject({
  kind: z.enum(['person', 'organisation']),
  ...partyFields,
  companyId: z.uuid().optional(),
});
const partyUpdate = z.strictObject(partyFields).partial();
const partyFilter = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  kind: z.enum(['person', 'organisation']).optional(),
  roleType: code.optional(),
});
const partyItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    kind: z.string(),
    displayName: z.string(),
    names: z.record(z.string(), z.string()),
    dateOfBirth: date.nullable(),
    gender: z.string().nullable(),
    nationalityCode: z.string().nullable(),
    photoFileId: z.uuid().nullable(),
    customFields: z.record(z.string(), z.unknown()),
    mergedIntoId: z.uuid().nullable(),
    ...stamps,
  })
  .meta({ id: 'Party' });

export function toPartyItem(row: PartyRow) {
  return {
    id: row.id,
    companyId: row.companyId,
    kind: row.kind,
    displayName: row.displayName,
    names: row.names as Record<string, string>,
    dateOfBirth: fromDate(row.dateOfBirth),
    gender: row.gender,
    nationalityCode: row.nationalityCode,
    photoFileId: row.photoFileId,
    customFields: row.customFields as Record<string, unknown>,
    mergedIntoId: row.mergedIntoId,
    ...stampsOf(row),
  };
}

export function createPartyRepository(): Repository<PartyRow> {
  const base = createRepository<PartyRow>({ model: 'party', scope: 'company' });
  const scan = async (row: PartyRow): Promise<PartyRow> => {
    await detectDuplicates(currentUnit().db, row.id);
    return row;
  };
  return {
    ...base,
    create: async (data) => scan(await base.create(withDates(data, ['dateOfBirth']))),
    update: async (id, version, changes) => {
      const row = await base.update(id, version, withDates(changes, ['dateOfBirth']));
      // Only a change to what identifies the person is worth another comparison.
      return 'displayName' in changes || 'dateOfBirth' in changes ? scan(row) : row;
    },
    // Rule 3.
    restore: async (id, version) => {
      const row = await currentUnit().db.party.findFirst({
        where: { id, deletedAt: { not: null } },
        select: { mergedIntoId: true },
      });
      if (row?.mergedIntoId !== null && row?.mergedIntoId !== undefined) {
        throw new ConflictError(
          'merged_party',
          'This party was merged into another one and cannot be restored.',
        );
      }
      return base.restore(id, version);
    },
  };
}

// ---- Role --------------------------------------------------------------------------------
const roleFields = {
  roleType: code,
  validFrom: date.optional(),
  validTo: date.nullable().optional(),
  status: z.enum(['active', 'ended']).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
};
const roleCreate = z.strictObject({ partyId: z.uuid(), ...roleFields });
// Closing a role is an update: set validTo and status "ended". The role type never changes.
const roleUpdate = z.strictObject(roleFields).omit({ roleType: true }).partial();
const roleFilter = z.object({
  partyId: z.uuid().optional(),
  roleType: code.optional(),
  status: z.enum(['active', 'ended']).optional(),
});
const roleItem = z
  .object({
    id: z.uuid(),
    partyId: z.uuid(),
    roleType: z.string(),
    validFrom: date,
    validTo: date.nullable(),
    status: z.string(),
    attributes: z.record(z.string(), z.unknown()),
    ...stamps,
  })
  .meta({ id: 'PartyRole' });
const toRoleItem = (row: RoleRow) => ({
  id: row.id,
  partyId: row.partyId,
  roleType: row.roleType,
  validFrom: fromDate(row.validFrom),
  validTo: fromDate(row.validTo),
  status: row.status,
  attributes: row.attributes as Record<string, unknown>,
  ...stampsOf(row),
});

// ---- Contact -----------------------------------------------------------------------------
const contactKind = z.enum(['phone', 'whatsapp', 'email']);
const contactValue = z.string().trim().min(3).max(200);
const contactCreate = z
  .strictObject({
    partyId: z.uuid(),
    kind: contactKind,
    value: contactValue,
    isPrimary: z.boolean().optional(),
  })
  .superRefine((body, ctx) => {
    checkContactValue(body.kind, body.value, ctx);
  });
const contactUpdate = z.strictObject({
  value: contactValue.optional(),
  isPrimary: z.boolean().optional(),
});
const contactFilter = z.object({ partyId: z.uuid().optional(), kind: contactKind.optional() });
const contactItem = z
  .object({
    id: z.uuid(),
    partyId: z.uuid(),
    kind: z.string(),
    value: z.string(),
    isPrimary: z.boolean(),
    verifiedAt: z.iso.datetime().nullable(),
    ...stamps,
  })
  .meta({ id: 'PartyContact' });
const toContactItem = (row: ContactRow) => ({
  id: row.id,
  partyId: row.partyId,
  kind: row.kind,
  value: row.value,
  isPrimary: row.isPrimary,
  verifiedAt: row.verifiedAt?.toISOString() ?? null,
  ...stampsOf(row),
});

function isValidContact(kind: string, normalised: string): boolean {
  return kind === 'email'
    ? z.email().safeParse(normalised).success
    : phone.safeParse(normalised).success;
}

function checkContactValue(kind: string, value: string, ctx: z.RefinementCtx): void {
  if (!isValidContact(kind, normaliseContact(kind, value))) {
    ctx.addIssue({
      code: 'custom',
      path: ['value'],
      message:
        kind === 'email'
          ? 'Not a valid e-mail address'
          : 'Use international form, e.g. +97455551234',
    });
  }
}

/** Rule 4. */
function contactRepository(): Repository<ContactRow> {
  const base = createRepository<ContactRow>({ model: 'partyContact', scope: 'company' });
  const unsetOtherPrimary = async (partyId: string, kind: string, exceptId?: string) => {
    await currentUnit().db.partyContact.updateMany({
      where: {
        partyId,
        kind,
        isPrimary: true,
        ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
      },
      data: { isPrimary: false },
    });
  };
  return {
    ...base,
    create: async (data) => {
      const kind = String(data.kind);
      const value = normaliseContact(kind, String(data.value));
      if (data.isPrimary === true) await unsetOtherPrimary(String(data.partyId), kind);
      return base.create({ ...data, value });
    },
    update: async (id, version, changes) => {
      const current = await base.get(id);
      const next: Record<string, unknown> = { ...changes };
      if (typeof changes.value === 'string') {
        const value = normaliseContact(current.kind, changes.value);
        if (!isValidContact(current.kind, value)) {
          throw new ValidationError([
            {
              path: 'value',
              code: 'invalid_value',
              message: 'Not a valid value for this kind of contact',
            },
          ]);
        }
        next.value = value;
        // A changed number is no longer the verified one.
        next.verifiedAt = null;
      }
      if (changes.isPrimary === true) await unsetOtherPrimary(current.partyId, current.kind, id);
      return base.update(id, version, next);
    },
  };
}

// ---- Address -----------------------------------------------------------------------------
const geo = z.strictObject({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
const addressFields = {
  kind: code,
  lines: z.array(z.string().trim().min(1).max(200)).max(6).optional(),
  city: z.string().trim().min(1).max(100).nullable().optional(),
  countryCode: country.nullable().optional(),
  geo: geo.nullable().optional(),
};
const addressCreate = z.strictObject({ partyId: z.uuid(), ...addressFields });
const addressUpdate = z.strictObject(addressFields).partial();
const addressFilter = z.object({ partyId: z.uuid().optional() });
const addressItem = z
  .object({
    id: z.uuid(),
    partyId: z.uuid(),
    kind: z.string(),
    lines: z.array(z.string()),
    city: z.string().nullable(),
    countryCode: z.string().nullable(),
    geo: geo.nullable(),
    ...stamps,
  })
  .meta({ id: 'PartyAddress' });
const toAddressItem = (row: AddressRow) => ({
  id: row.id,
  partyId: row.partyId,
  kind: row.kind,
  lines: row.lines,
  city: row.city,
  countryCode: row.countryCode,
  geo: row.geo as { lat: number; lng: number } | null,
  ...stampsOf(row),
});

// ---- Relationship ------------------------------------------------------------------------
const relationshipCreate = z.strictObject({
  fromPartyId: z.uuid(),
  toPartyId: z.uuid(),
  type: code,
  validFrom: date.optional(),
  validTo: date.nullable().optional(),
});
const relationshipUpdate = z.strictObject({
  validFrom: date.optional(),
  validTo: date.nullable().optional(),
});
const relationshipFilter = z.object({ partyId: z.uuid().optional(), type: code.optional() });
const relationshipItem = z
  .object({
    id: z.uuid(),
    fromPartyId: z.uuid(),
    toPartyId: z.uuid(),
    type: z.string(),
    validFrom: date,
    validTo: date.nullable(),
    ...stamps,
  })
  .meta({ id: 'PartyRelationship' });
const toRelationshipItem = (row: RelationshipRow) => ({
  id: row.id,
  fromPartyId: row.fromPartyId,
  toPartyId: row.toPartyId,
  type: row.type,
  validFrom: fromDate(row.validFrom),
  validTo: fromDate(row.validTo),
  ...stampsOf(row),
});

export interface PartyRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
}

/** The repositories behind the routes, shared with the recycle bin. */
export function createPartyRepositories() {
  return {
    party: createPartyRepository(),
    role: guardedRepository<RoleRow>('partyRole', ['validFrom', 'validTo']),
    contact: contactRepository(),
    address: createRepository<AddressRow>({ model: 'partyAddress', scope: 'company' }),
    relationship: guardedRepository<RelationshipRow>('partyRelationship', ['validFrom', 'validTo']),
  };
}

/** A repository whose date strings become Dates and whose overlap errors become 409. */
function guardedRepository<TRow extends RoleRow | RelationshipRow>(
  model: 'partyRole' | 'partyRelationship',
  dateKeys: readonly string[],
): Repository<TRow> {
  const base = createRepository<TRow>({ model, scope: 'company' });
  return {
    ...base,
    create: (data) => guardExclusion(() => base.create(withDates(data, dateKeys))),
    update: (id, version, changes) =>
      guardExclusion(() => base.update(id, version, withDates(changes, dateKeys))),
    restore: (id, version) => guardExclusion(() => base.restore(id, version)),
  };
}

export function createPartyRouter(deps: PartyRouterDeps): Router {
  const { uow, registry, permissions } = deps;
  const router = Router();
  const crud = { uow, authorize: permissions.authorize, registry };
  const repositories = createPartyRepositories();

  router.use(
    createCrudRouter(crud, {
      path: '/parties',
      resource: 'party.party',
      tag: 'Parties',
      repository: repositories.party,
      schemas: { create: partyCreate, update: partyUpdate, item: partyItem, filter: partyFilter },
      toItem: toPartyItem,
      // Rule 1. `contains` with `insensitive` uses the trigram index for names.
      toWhere: (f) => {
        const { q, kind, roleType } = f as z.infer<typeof partyFilter>;
        return {
          ...(kind === undefined ? {} : { kind }),
          ...(roleType === undefined
            ? {}
            : { roles: { some: { roleType, status: 'active', deletedAt: null } } }),
          ...(q === undefined
            ? {}
            : {
                OR: [
                  { displayName: { contains: q, mode: 'insensitive' } },
                  {
                    contacts: {
                      some: { value: { contains: q.replace(/[\s()-]+/g, '').toLowerCase() } },
                    },
                  },
                  { identifiers: { some: { valuePlain: q.trim(), deletedAt: null } } },
                ],
              }),
        };
      },
    }),
  );
  router.use(
    createCrudRouter(crud, {
      path: '/party-roles',
      resource: 'party.role',
      tag: 'Party roles',
      repository: repositories.role,
      schemas: { create: roleCreate, update: roleUpdate, item: roleItem, filter: roleFilter },
      toItem: toRoleItem,
      toWhere: (f) => stripUndefined(f),
    }),
  );
  router.use(
    createCrudRouter(crud, {
      path: '/party-contacts',
      resource: 'party.contact',
      tag: 'Party contacts',
      repository: repositories.contact,
      schemas: {
        create: contactCreate,
        update: contactUpdate,
        item: contactItem,
        filter: contactFilter,
      },
      toItem: toContactItem,
      toWhere: (f) => stripUndefined(f),
    }),
  );
  router.use(
    createCrudRouter(crud, {
      path: '/party-addresses',
      resource: 'party.address',
      tag: 'Party addresses',
      repository: repositories.address,
      schemas: {
        create: addressCreate,
        update: addressUpdate,
        item: addressItem,
        filter: addressFilter,
      },
      toItem: toAddressItem,
      toWhere: (f) => stripUndefined(f),
    }),
  );
  router.use(
    createCrudRouter(crud, {
      path: '/party-relationships',
      resource: 'party.relationship',
      tag: 'Party relationships',
      repository: repositories.relationship,
      schemas: {
        create: relationshipCreate,
        update: relationshipUpdate,
        item: relationshipItem,
        filter: relationshipFilter,
      },
      toItem: toRelationshipItem,
      // A relationship belongs to both of its parties.
      toWhere: (f) => {
        const { partyId, type } = f as z.infer<typeof relationshipFilter>;
        return {
          ...(type === undefined ? {} : { type }),
          ...(partyId === undefined
            ? {}
            : { OR: [{ fromPartyId: partyId }, { toPartyId: partyId }] }),
        };
      },
    }),
  );
  return router;
}

function stripUndefined(filter: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== undefined));
}
