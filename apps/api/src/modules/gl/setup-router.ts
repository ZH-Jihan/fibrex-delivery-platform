/**
 * Ledger set-up API, part 1 (phase 2 row 2.14; PLAN 5.11): the chart of accounts, cost
 * centres, tax codes and exchange rates. Fiscal years and periods are in ./fiscal-router.ts.
 *
 *   /accounts            CRUD (filters type, parentId), list ordered by code
 *   GET /accounts/tree   every live account as a nested tree, ordered by code
 *   /cost-centres        CRUD (filter parentId), ordered by code
 *   /tax-codes           CRUD, ordered by code
 *   /exchange-rates      CRUD (filters fromCurrency, toCurrency), newest day first
 *
 * Business rules on top of the plain permissions, and why:
 *   Accounts
 *   1. A code never changes (posting rules, row 2.15, name accounts by code). Rename
 *      instead, or retire the account and add a new one.
 *   2. A parent is a header: it is not postable, so no balance ever sits on an account that
 *      also totals others. An account with live children cannot be made postable.
 *   3. A child has the same type as its parent (an expense under an asset header would make
 *      the statements wrong); the type of an account with children cannot change.
 *   4. No cycles: an account cannot be moved under itself or one of its descendants.
 *   5. An account with live children, or used by a live tax code, is not deleted; a deleted
 *      account comes back only under a live parent. (Row 2.15 adds: not with journal lines.)
 *   Cost centres: rules 1 (code fixed), 4 and 5 (children) apply.
 *   Tax codes
 *   6. A rate above zero needs a live, postable account to post the tax to.
 *   7. Exactly one default per company: making a code the default takes it from the old
 *      one; the default itself can be neither un-defaulted nor deleted (make another one
 *      the default first). Codes never change (rule 1).
 *   Exchange rates
 *   8. One rate per currency pair and day; the pair and the day never change (delete and
 *      add instead). Both currencies must be active in `platform.currency`. Journals store
 *      the rate they used (row 2.15), so changing a rate later never changes a posted entry.
 *
 * Depends on: express, zod, @fibrex/shared (ledger schemas), kernel/db, kernel/http,
 * kernel/permissions. Used by: ./index.ts (the gl module manifest).
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  accountCodeSchema,
  accountTypeSchema,
  costCentreCodeSchema,
  currencyCodeSchema,
  exchangeRateValueSchema,
  ledgerDimensionsSchema,
  ledgerNameSchema,
  taxCodeCodeSchema,
  taxRateSchema,
} from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../../kernel/db/prisma.js';
import { createRepository, type BaseRow, type Repository } from '../../kernel/db/repository.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { createCrudRouter } from '../../kernel/http/crud-router.js';
import { UnprocessableError, ValidationError } from '../../kernel/http/errors.js';
import { registerRoute } from '../../kernel/http/openapi.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';

export type AccountRecord = NonNullable<Awaited<ReturnType<Db['glAccount']['findFirst']>>>;
export type CostCentreRecord = NonNullable<Awaited<ReturnType<Db['glCostCentre']['findFirst']>>>;
export type TaxCodeRecord = NonNullable<Awaited<ReturnType<Db['glTaxCode']['findFirst']>>>;
export type ExchangeRateRecord = NonNullable<
  Awaited<ReturnType<Db['glExchangeRate']['findFirst']>>
>;

const day = z.iso.date();
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDay = (text: string) => new Date(`${text}T00:00:00.000Z`);
const invalid = (path: string, message: string, code: string) =>
  new ValidationError([{ path, message, code }]);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const accountCreate = z.strictObject({
  code: accountCodeSchema,
  name: ledgerNameSchema,
  type: accountTypeSchema,
  parentId: z.uuid().nullable().default(null),
  isPostable: z.boolean().default(true),
  isControl: z.boolean().default(false),
  currencyRestriction: currencyCodeSchema.nullable().default(null),
  requiresDimensions: ledgerDimensionsSchema.default([]),
  description: z.string().max(2000).nullable().default(null),
});
const accountUpdate = z
  .strictObject({
    name: ledgerNameSchema,
    type: accountTypeSchema,
    parentId: z.uuid().nullable(),
    isPostable: z.boolean(),
    isControl: z.boolean(),
    currencyRestriction: currencyCodeSchema.nullable(),
    requiresDimensions: ledgerDimensionsSchema,
    description: z.string().max(2000).nullable(),
  })
  .partial();
const accountItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    code: z.string(),
    name: z.record(z.string(), z.string()),
    type: accountTypeSchema,
    parentId: z.uuid().nullable(),
    isPostable: z.boolean(),
    isControl: z.boolean(),
    currencyRestriction: z.string().nullable(),
    requiresDimensions: z.array(z.string()),
    description: z.string().nullable(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Account' });
const accountFilter = z.object({
  type: accountTypeSchema.optional(),
  parentId: z.uuid().optional(),
});

interface AccountNode extends z.infer<typeof accountItem> {
  children: AccountNode[];
}
const accountNode: z.ZodType<AccountNode> = accountItem
  .extend({ children: z.array(z.lazy(() => accountNode)) })
  .meta({ id: 'AccountNode' });

const costCentreCreate = z.strictObject({
  code: costCentreCodeSchema,
  name: z.string().trim().min(1).max(200),
  parentId: z.uuid().nullable().default(null),
});
const costCentreUpdate = z
  .strictObject({ name: z.string().trim().min(1).max(200), parentId: z.uuid().nullable() })
  .partial();
const costCentreItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    code: z.string(),
    name: z.string(),
    parentId: z.uuid().nullable(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'CostCentre' });
const costCentreFilter = z.object({ parentId: z.uuid().optional() });

const taxCodeCreate = z.strictObject({
  code: taxCodeCodeSchema,
  name: z.string().trim().min(1).max(200),
  rate: taxRateSchema.default('0'),
  accountId: z.uuid().nullable().default(null),
  isDefault: z.boolean().default(false),
});
const taxCodeUpdate = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    rate: taxRateSchema,
    accountId: z.uuid().nullable(),
    isDefault: z.boolean(),
  })
  .partial();
const taxCodeItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    code: z.string(),
    name: z.string(),
    rate: z.string(),
    accountId: z.uuid().nullable(),
    isDefault: z.boolean(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'TaxCode' });

const exchangeRateCreate = z
  .strictObject({
    fromCurrency: currencyCodeSchema,
    toCurrency: currencyCodeSchema,
    rateDate: day,
    rate: exchangeRateValueSchema,
    source: z.string().trim().min(1).max(100).default('manual'),
  })
  .refine((b) => b.fromCurrency !== b.toCurrency, {
    path: ['toCurrency'],
    message: 'The two currencies must differ.',
  });
const exchangeRateUpdate = z
  .strictObject({ rate: exchangeRateValueSchema, source: z.string().trim().min(1).max(100) })
  .partial();
const exchangeRateItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    fromCurrency: z.string(),
    toCurrency: z.string(),
    rateDate: day,
    rate: z.string(),
    source: z.string(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'ExchangeRate' });
const exchangeRateFilter = z.object({
  fromCurrency: currencyCodeSchema.optional(),
  toCurrency: currencyCodeSchema.optional(),
});

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

const stamps = (row: {
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}) => ({
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  deletedAt: row.deletedAt?.toISOString() ?? null,
});

export function toAccountItem(row: AccountRecord): z.infer<typeof accountItem> {
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    name: row.name as Record<string, string>,
    type: row.type as z.infer<typeof accountTypeSchema>,
    parentId: row.parentId,
    isPostable: row.isPostable,
    isControl: row.isControl,
    currencyRestriction: row.currencyRestriction,
    requiresDimensions: row.requiresDimensions,
    description: row.description,
    ...stamps(row),
  };
}

export const toCostCentreItem = (row: CostCentreRecord) => ({
  id: row.id,
  companyId: row.companyId,
  code: row.code,
  name: row.name,
  parentId: row.parentId,
  ...stamps(row),
});

export const toTaxCodeItem = (row: TaxCodeRecord) => ({
  id: row.id,
  companyId: row.companyId,
  code: row.code,
  name: row.name,
  rate: row.rate.toFixed(4),
  accountId: row.accountId,
  isDefault: row.isDefault,
  ...stamps(row),
});

export const toExchangeRateItem = (row: ExchangeRateRecord) => ({
  id: row.id,
  companyId: row.companyId,
  fromCurrency: row.fromCurrency,
  toCurrency: row.toCurrency,
  rateDate: isoDay(row.rateDate),
  rate: row.rate.toFixed(8),
  source: row.source,
  ...stamps(row),
});

// ---------------------------------------------------------------------------
// Tree helpers (accounts and cost centres)
// ---------------------------------------------------------------------------

/** The models that form a tree by `parentId` inside one company. */
type TreeModel = 'glAccount' | 'glCostCentre';

async function liveChildren(model: TreeModel, id: string): Promise<number> {
  const { db } = currentUnit();
  const where = { parentId: id, deletedAt: null };
  return model === 'glAccount' ? db.glAccount.count({ where }) : db.glCostCentre.count({ where });
}

async function parentOf(model: TreeModel, id: string): Promise<string | null | undefined> {
  const { db } = currentUnit();
  const args = { where: { id }, select: { parentId: true } } as const;
  const row =
    model === 'glAccount'
      ? await db.glAccount.findFirst(args)
      : await db.glCostCentre.findFirst(args);
  return row === null ? undefined : row.parentId;
}

/** Rule 4: true when `candidateParent` is `id` itself or sits below it. */
async function wouldCycle(model: TreeModel, id: string, candidateParent: string): Promise<boolean> {
  // Walk up from the proposed parent; the tree is shallow (a chart rarely has 6 levels), and
  // the walk stops after 100 steps so a corrupted tree can never loop forever.
  let cursor: string | null | undefined = candidateParent;
  for (let steps = 0; cursor !== null && cursor !== undefined && steps < 100; steps += 1) {
    if (cursor === id) return true;
    cursor = await parentOf(model, cursor);
  }
  return false;
}

/** Orders a list by code unless the caller asked for something else. */
function byCode<TRow extends BaseRow>(base: Repository<TRow>): Repository<TRow>['list'] {
  return (options) =>
    base.list({ ...options, orderBy: options.orderBy ?? [{ code: 'asc' }, { id: 'asc' }] });
}

async function activeCurrency(code: string, path: string): Promise<void> {
  const found = await currentUnit().db.currency.findFirst({
    where: { code, isActive: true },
    select: { id: true },
  });
  if (found === null) throw invalid(path, `${code} is not an active currency.`, 'unknown_currency');
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

async function liveAccount(id: string, path: string): Promise<AccountRecord> {
  const row = await currentUnit().db.glAccount.findFirst({ where: { id, deletedAt: null } });
  if (row === null) throw invalid(path, 'This account does not exist.', 'unknown_account');
  return row;
}

/** Rules 2 and 3 for a proposed parent. */
async function checkAccountParent(parentId: string, type: string): Promise<void> {
  const parent = await liveAccount(parentId, 'parentId');
  if (parent.isPostable) {
    throw new UnprocessableError(
      'gl_parent_postable',
      `Account ${parent.code} takes postings, so it cannot have sub-accounts. Make it a header (not postable) first.`,
    );
  }
  if (parent.type !== type) {
    throw new UnprocessableError(
      'gl_parent_type',
      `Account ${parent.code} is a ${parent.type} account; a sub-account must be a ${parent.type} account too.`,
    );
  }
}

/** The repository behind `/accounts` and the recycle bin; adds rules 1 to 5. */
export function createAccountRepository(): Repository<AccountRecord> {
  const base = createRepository<AccountRecord>({ model: 'glAccount', scope: 'company' });
  return {
    ...base,
    list: byCode(base),
    create: async (data) => {
      const body = data as z.infer<typeof accountCreate>;
      if (body.parentId !== null) await checkAccountParent(body.parentId, body.type);
      if (body.currencyRestriction !== null) {
        await activeCurrency(body.currencyRestriction, 'currencyRestriction');
      }
      return base.create(body);
    },
    update: async (id, version, changes) => {
      const body = changes as z.infer<typeof accountUpdate>;
      const current = await base.get(id);
      const type = body.type ?? current.type;
      const parentId = body.parentId === undefined ? current.parentId : body.parentId;
      const children = await liveChildren('glAccount', id);
      if (body.type !== undefined && body.type !== current.type && children > 0) {
        throw new UnprocessableError(
          'gl_account_has_children',
          'The type of an account with sub-accounts cannot change; move or retire them first.',
        );
      }
      if (body.isPostable === true && children > 0) {
        throw new UnprocessableError(
          'gl_account_has_children',
          'An account with sub-accounts is a header and cannot take postings.',
        );
      }
      if (parentId !== null && (body.parentId !== undefined || body.type !== undefined)) {
        if (await wouldCycle('glAccount', id, parentId)) {
          throw invalid('parentId', 'An account cannot sit under itself.', 'gl_tree_cycle');
        }
        await checkAccountParent(parentId, type);
      }
      if (body.currencyRestriction !== undefined && body.currencyRestriction !== null) {
        await activeCurrency(body.currencyRestriction, 'currencyRestriction');
      }
      return base.update(id, version, body);
    },
    softDelete: async (id, version, reason) => {
      if ((await liveChildren('glAccount', id)) > 0) {
        throw new UnprocessableError(
          'gl_account_has_children',
          'Delete or move the sub-accounts of this account first.',
        );
      }
      const taxCodes = await currentUnit().db.glTaxCode.count({
        where: { accountId: id, deletedAt: null },
      });
      if (taxCodes > 0) {
        throw new UnprocessableError(
          'gl_account_in_use',
          'A tax code posts to this account; change the tax code first.',
        );
      }
      return base.softDelete(id, version, reason);
    },
    restore: async (id, version) => {
      const row = await currentUnit().db.glAccount.findFirst({
        where: { id, deletedAt: { not: null } },
      });
      if (row?.parentId != null) {
        const parent = await currentUnit().db.glAccount.findFirst({
          where: { id: row.parentId, deletedAt: null },
        });
        if (parent === null) {
          throw new UnprocessableError(
            'gl_parent_deleted',
            'The parent of this account is deleted; restore the parent first.',
          );
        }
      }
      return base.restore(id, version);
    },
  };
}

/** The repository behind `/cost-centres` and the recycle bin (rules 1, 4, 5). */
export function createCostCentreRepository(): Repository<CostCentreRecord> {
  const base = createRepository<CostCentreRecord>({ model: 'glCostCentre', scope: 'company' });
  const liveParent = async (parentId: string) => {
    const parent = await currentUnit().db.glCostCentre.findFirst({
      where: { id: parentId, deletedAt: null },
    });
    if (parent === null) {
      throw invalid('parentId', 'This cost centre does not exist.', 'unknown_cost_centre');
    }
  };
  return {
    ...base,
    list: byCode(base),
    create: async (data) => {
      const body = data as z.infer<typeof costCentreCreate>;
      if (body.parentId !== null) await liveParent(body.parentId);
      return base.create(body);
    },
    update: async (id, version, changes) => {
      const body = changes as z.infer<typeof costCentreUpdate>;
      if (body.parentId !== undefined && body.parentId !== null) {
        await liveParent(body.parentId);
        if (await wouldCycle('glCostCentre', id, body.parentId)) {
          throw invalid('parentId', 'A cost centre cannot sit under itself.', 'gl_tree_cycle');
        }
      }
      return base.update(id, version, body);
    },
    softDelete: async (id, version, reason) => {
      if ((await liveChildren('glCostCentre', id)) > 0) {
        throw new UnprocessableError(
          'gl_cost_centre_has_children',
          'Delete or move the cost centres under this one first.',
        );
      }
      return base.softDelete(id, version, reason);
    },
    restore: async (id, version) => {
      const row = await currentUnit().db.glCostCentre.findFirst({
        where: { id, deletedAt: { not: null } },
      });
      if (row?.parentId != null) {
        const parent = await currentUnit().db.glCostCentre.findFirst({
          where: { id: row.parentId, deletedAt: null },
        });
        if (parent === null) {
          throw new UnprocessableError(
            'gl_parent_deleted',
            'The parent of this cost centre is deleted; restore the parent first.',
          );
        }
      }
      return base.restore(id, version);
    },
  };
}

/** Rule 6: the account a taxed code posts to. */
async function checkTaxAccount(rate: string, accountId: string | null): Promise<void> {
  if (accountId !== null) {
    const account = await liveAccount(accountId, 'accountId');
    if (!account.isPostable) {
      throw invalid('accountId', `Account ${account.code} is a header.`, 'gl_account_header');
    }
  }
  if (Number(rate) > 0 && accountId === null) {
    throw invalid('accountId', 'A tax rate above zero needs an account.', 'gl_tax_account');
  }
}

/** Rule 7: the old default of the company stops being the default. */
async function clearOtherDefaults(companyId: string, keepId: string): Promise<void> {
  // Through the model (not the repository): the audit trigger still records the change and
  // the version still moves, so a screen holding the old default sees a 409 on its next save.
  const { db, context } = currentUnit();
  await db.glTaxCode.updateMany({
    where: { companyId, isDefault: true, deletedAt: null, id: { not: keepId } },
    data: {
      isDefault: false,
      version: { increment: 1 },
      updatedAt: new Date(),
      updatedBy: context.userId ?? null,
    },
  });
}

/** The repository behind `/tax-codes` and the recycle bin; adds rules 6 and 7. */
export function createTaxCodeRepository(): Repository<TaxCodeRecord> {
  const base = createRepository<TaxCodeRecord>({ model: 'glTaxCode', scope: 'company' });
  const keepsDefault = new UnprocessableError(
    'gl_tax_default_required',
    'A company always has one default tax code; make another code the default instead.',
  );
  return {
    ...base,
    list: byCode(base),
    create: async (data) => {
      const body = data as z.infer<typeof taxCodeCreate>;
      await checkTaxAccount(body.rate, body.accountId);
      // Insert as not-default first: the one-default index would refuse a second default
      // before the old one is cleared, and the company is only known once the row exists.
      const made = await base.create({ ...body, isDefault: false });
      if (!body.isDefault) return made;
      await clearOtherDefaults(made.companyId, made.id);
      return base.update(made.id, made.version, { isDefault: true });
    },
    update: async (id, version, changes) => {
      const body = changes as z.infer<typeof taxCodeUpdate>;
      const current = await base.get(id);
      if (body.isDefault === false && current.isDefault) throw keepsDefault;
      if (body.rate !== undefined || body.accountId !== undefined) {
        await checkTaxAccount(
          body.rate ?? current.rate.toFixed(4),
          body.accountId === undefined ? current.accountId : body.accountId,
        );
      }
      if (body.isDefault === true && !current.isDefault) {
        await clearOtherDefaults(current.companyId, id);
      }
      return base.update(id, version, body);
    },
    softDelete: async (id, version, reason) => {
      if ((await base.get(id)).isDefault) throw keepsDefault;
      return base.softDelete(id, version, reason);
    },
    restore: async (id, version) => {
      const row = await currentUnit().db.glTaxCode.findFirst({
        where: { id, deletedAt: { not: null } },
      });
      if (row?.accountId != null) await liveAccount(row.accountId, 'accountId');
      return base.restore(id, version);
    },
  };
}

/** The repository behind `/exchange-rates` and the recycle bin (rule 8). */
export function createExchangeRateRepository(): Repository<ExchangeRateRecord> {
  const base = createRepository<ExchangeRateRecord>({ model: 'glExchangeRate', scope: 'company' });
  return {
    ...base,
    list: (options) =>
      base.list({
        ...options,
        orderBy: options.orderBy ?? [{ rateDate: 'desc' }, { fromCurrency: 'asc' }, { id: 'asc' }],
      }),
    create: async (data) => {
      const body = data as z.infer<typeof exchangeRateCreate>;
      await activeCurrency(body.fromCurrency, 'fromCurrency');
      await activeCurrency(body.toCurrency, 'toCurrency');
      return base.create({ ...body, rateDate: toDay(body.rateDate) });
    },
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface SetupRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
}

/** Builds the nested chart from a flat list already ordered by code. */
export function buildAccountTree(rows: readonly AccountRecord[]): AccountNode[] {
  const nodes = new Map<string, AccountNode>();
  for (const row of rows) nodes.set(row.id, { ...toAccountItem(row), children: [] });
  const roots: AccountNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId === null ? undefined : nodes.get(node.parentId);
    (parent?.children ?? roots).push(node);
  }
  return roots;
}

export function createSetupRouter(deps: SetupRouterDeps): Router {
  const { uow, registry, permissions } = deps;
  const router = Router();
  const crud = { uow, authorize: permissions.authorize, registry };

  // Before the CRUD routes, so "tree" is never read as an id.
  router.get('/accounts/tree', async (_req, res) => {
    const rows = await uow.run(async () => {
      await permissions.require('gl.account.read');
      return currentUnit().db.glAccount.findMany({
        where: { deletedAt: null },
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
      });
    });
    res.json({ items: buildAccountTree(rows) });
  });
  registerRoute(registry, {
    method: 'get',
    path: '/accounts/tree',
    tags: ['Chart of accounts'],
    summary: 'Every live account as a tree, ordered by code',
    responses: {
      200: {
        description: 'The chart of accounts',
        content: { 'application/json': { schema: z.object({ items: z.array(accountNode) }) } },
      },
    },
  });

  router.use(
    createCrudRouter<AccountRecord>(crud, {
      path: '/accounts',
      resource: 'gl.account',
      tag: 'Chart of accounts',
      repository: createAccountRepository(),
      schemas: {
        create: accountCreate,
        update: accountUpdate,
        item: accountItem,
        filter: accountFilter,
      },
      toItem: toAccountItem,
      toWhere: (filter) => filter,
    }),
  );
  router.use(
    createCrudRouter<CostCentreRecord>(crud, {
      path: '/cost-centres',
      resource: 'gl.cost_centre',
      tag: 'Cost centres',
      repository: createCostCentreRepository(),
      schemas: {
        create: costCentreCreate,
        update: costCentreUpdate,
        item: costCentreItem,
        filter: costCentreFilter,
      },
      toItem: toCostCentreItem,
      toWhere: (filter) => filter,
    }),
  );
  router.use(
    createCrudRouter<TaxCodeRecord>(crud, {
      path: '/tax-codes',
      resource: 'gl.tax_code',
      tag: 'Tax codes',
      repository: createTaxCodeRepository(),
      schemas: { create: taxCodeCreate, update: taxCodeUpdate, item: taxCodeItem },
      toItem: toTaxCodeItem,
    }),
  );
  router.use(
    createCrudRouter<ExchangeRateRecord>(crud, {
      path: '/exchange-rates',
      resource: 'gl.exchange_rate',
      tag: 'Exchange rates',
      repository: createExchangeRateRepository(),
      schemas: {
        create: exchangeRateCreate,
        update: exchangeRateUpdate,
        item: exchangeRateItem,
        filter: exchangeRateFilter,
      },
      toItem: toExchangeRateItem,
      toWhere: (filter) => filter,
    }),
  );

  return router;
}
