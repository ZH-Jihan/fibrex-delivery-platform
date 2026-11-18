/**
 * Cash locations and company bank accounts API (phase 2 row 2.17a; PLAN 3.9).
 *
 *   /cash-locations           CRUD (filter kind), ordered by name
 *   /company-bank-accounts    CRUD (filter cashLocationId); the number is write-only
 *
 * Business rules on top of the plain permissions, and why:
 *   Cash locations
 *   1. A location carries no balance (SPEC 2.9): its balance is the ledger balance of its
 *      account. So the account must be a live, postable asset account, one location per
 *      account (database index), and - when the account is limited to a currency - in
 *      that currency.
 *   2. The currency never changes; the account may change only while the old account has no
 *      journal lines (otherwise the history of the place would silently move).
 *   3. A location with a live bank account is not deleted (delete the account first); a
 *      deleted location comes back only with a live ledger account.
 *   Company bank accounts
 *   4. They belong to a location of kind `bank`, one account per location.
 *   5. The number (IBAN) is stored encrypted, keyed-hashed and masked; responses and audit
 *      rows show only the mask. The same number cannot be added twice (hash index -> 409).
 *      Changing it reseals it; omitting it leaves it alone.
 *   6. An account with live statements is not deleted (delete the statements first).
 *
 * Depends on: express, zod, @fibrex/shared (bank schemas), kernel/db, kernel/http,
 * kernel/permissions, ./bank-vault.ts. Used by: ./index.ts (the gl module manifest).
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  cashLocationCreateSchema,
  cashLocationKindSchema,
  cashLocationUpdateSchema,
  companyBankAccountCreateSchema,
  companyBankAccountUpdateSchema,
  maskIban,
} from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../../kernel/db/prisma.js';
import { createRepository, type Repository } from '../../kernel/db/repository.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { createCrudRouter } from '../../kernel/http/crud-router.js';
import { UnprocessableError, ValidationError } from '../../kernel/http/errors.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import type { BankVault } from './bank-vault.js';

export type CashLocationRecord = NonNullable<
  Awaited<ReturnType<Db['glCashLocation']['findFirst']>>
>;
export type CompanyBankAccountRecord = NonNullable<
  Awaited<ReturnType<Db['glCompanyBankAccount']['findFirst']>>
>;

const invalid = (path: string, message: string, code: string) =>
  new ValidationError([{ path, message, code }]);

const stampShape = {
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
};
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

const cashLocationItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    name: z.string(),
    kind: cashLocationKindSchema,
    accountId: z.uuid(),
    currency: z.string(),
    ...stampShape,
  })
  .meta({ id: 'CashLocation' });
const cashLocationFilter = z.object({ kind: cashLocationKindSchema.optional() });

const bankAccountItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    cashLocationId: z.uuid(),
    bankName: z.string(),
    ibanMasked: z.string(),
    wpsEmployerId: z.string().nullable(),
    ...stampShape,
  })
  .meta({ id: 'CompanyBankAccount' });
const bankAccountFilter = z.object({ cashLocationId: z.uuid().optional() });

export const toCashLocationItem = (row: CashLocationRecord) => ({
  id: row.id,
  companyId: row.companyId,
  name: row.name,
  kind: row.kind as z.infer<typeof cashLocationKindSchema>,
  accountId: row.accountId,
  currency: row.currency,
  ...stamps(row),
});

/** Never includes the encrypted number or its hash. */
export const toBankAccountItem = (row: CompanyBankAccountRecord) => ({
  id: row.id,
  companyId: row.companyId,
  cashLocationId: row.cashLocationId,
  bankName: row.bankName,
  ibanMasked: row.ibanMasked,
  wpsEmployerId: row.wpsEmployerId,
  ...stamps(row),
});

/** Rule 1: the account a location is tied to. */
async function checkLocationAccount(accountId: string, currency: string): Promise<void> {
  const account = await currentUnit().db.glAccount.findFirst({
    where: { id: accountId, deletedAt: null },
  });
  if (account === null) {
    throw invalid('accountId', 'This account does not exist.', 'unknown_account');
  }
  if (!account.isPostable || account.type !== 'asset') {
    throw invalid(
      'accountId',
      `Account ${account.code} must be a postable asset account.`,
      'gl_cash_account_type',
    );
  }
  if (account.currencyRestriction !== null && account.currencyRestriction !== currency) {
    throw invalid(
      'accountId',
      `Account ${account.code} only takes ${account.currencyRestriction}.`,
      'gl_cash_account_currency',
    );
  }
}

export function createCashLocationRepository(): Repository<CashLocationRecord> {
  const base = createRepository<CashLocationRecord>({ model: 'glCashLocation', scope: 'company' });
  return {
    ...base,
    list: (options) =>
      base.list({ ...options, orderBy: options.orderBy ?? [{ name: 'asc' }, { id: 'asc' }] }),
    create: async (data) => {
      const body = data as z.infer<typeof cashLocationCreateSchema>;
      const currency = await currentUnit().db.currency.findFirst({
        where: { code: body.currency, isActive: true },
        select: { id: true },
      });
      if (currency === null) {
        throw invalid(
          'currency',
          `${body.currency} is not an active currency.`,
          'unknown_currency',
        );
      }
      await checkLocationAccount(body.accountId, body.currency);
      return base.create(body);
    },
    update: async (id, version, changes) => {
      const body = changes as z.infer<typeof cashLocationUpdateSchema>;
      const current = await base.get(id);
      if (body.accountId !== undefined && body.accountId !== current.accountId) {
        // Rule 2.
        const used = await currentUnit().db.glJournalLine.count({
          where: { accountId: current.accountId },
        });
        if (used > 0) {
          throw new UnprocessableError(
            'gl_cash_account_in_use',
            'The ledger account of this location already has journal lines; it can no longer change.',
          );
        }
        await checkLocationAccount(body.accountId, current.currency);
      }
      return base.update(id, version, body);
    },
    softDelete: async (id, version, reason) => {
      // Rule 3.
      const accounts = await currentUnit().db.glCompanyBankAccount.count({
        where: { cashLocationId: id, deletedAt: null },
      });
      if (accounts > 0) {
        throw new UnprocessableError(
          'gl_cash_location_in_use',
          'A bank account is set up at this location; delete it first.',
        );
      }
      return base.softDelete(id, version, reason);
    },
    restore: async (id, version) => {
      const row = await currentUnit().db.glCashLocation.findFirst({
        where: { id, deletedAt: { not: null } },
      });
      if (row !== null) await checkLocationAccount(row.accountId, row.currency);
      return base.restore(id, version);
    },
  };
}

export function createBankAccountRepository(
  vault: BankVault,
): Repository<CompanyBankAccountRecord> {
  const base = createRepository<CompanyBankAccountRecord>({
    model: 'glCompanyBankAccount',
    scope: 'company',
  });
  /** The three columns that hold a number: sealed, hashed, masked (rule 5). */
  const numberColumns = (iban: string, companyId: string) => ({
    ibanEncrypted: vault.seal(iban, companyId),
    ibanHash: vault.hash(currentUnit().context.tenantId, iban),
    ibanMasked: maskIban(iban),
  });
  return {
    ...base,
    list: (options) =>
      base.list({ ...options, orderBy: options.orderBy ?? [{ bankName: 'asc' }, { id: 'asc' }] }),
    create: async (data) => {
      const body = data as z.infer<typeof companyBankAccountCreateSchema>;
      // Rule 4.
      const location = await currentUnit().db.glCashLocation.findFirst({
        where: { id: body.cashLocationId, deletedAt: null },
      });
      if (location === null) {
        throw invalid(
          'cashLocationId',
          'This cash location does not exist.',
          'unknown_cash_location',
        );
      }
      if (location.kind !== 'bank') {
        throw invalid(
          'cashLocationId',
          'A bank account belongs to a cash location of kind bank.',
          'gl_cash_location_kind',
        );
      }
      const { iban, ...rest } = body;
      return base.create({
        ...rest,
        companyId: location.companyId,
        ...numberColumns(iban, location.companyId),
      });
    },
    update: async (id, version, changes) => {
      const { iban, ...rest } = changes as z.infer<typeof companyBankAccountUpdateSchema>;
      if (iban === undefined) return base.update(id, version, rest);
      const current = await base.get(id);
      return base.update(id, version, { ...rest, ...numberColumns(iban, current.companyId) });
    },
    softDelete: async (id, version, reason) => {
      // Rule 6.
      const statements = await currentUnit().db.glBankStatement.count({
        where: { companyBankAccountId: id, deletedAt: null },
      });
      if (statements > 0) {
        throw new UnprocessableError(
          'gl_bank_account_in_use',
          'Statements were imported for this bank account; delete them first.',
        );
      }
      return base.softDelete(id, version, reason);
    },
  };
}

export interface BankRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  vault: BankVault;
}

export function createBankRouter(deps: BankRouterDeps): Router {
  const { uow, registry, permissions, vault } = deps;
  const router = Router();
  const crud = { uow, authorize: permissions.authorize, registry };
  router.use(
    createCrudRouter<CashLocationRecord>(crud, {
      path: '/cash-locations',
      resource: 'gl.cash_location',
      tag: 'Cash locations',
      repository: createCashLocationRepository(),
      schemas: {
        create: cashLocationCreateSchema,
        update: cashLocationUpdateSchema,
        item: cashLocationItem,
        filter: cashLocationFilter,
      },
      toItem: toCashLocationItem,
      toWhere: (filter) => filter,
    }),
  );
  router.use(
    createCrudRouter<CompanyBankAccountRecord>(crud, {
      path: '/company-bank-accounts',
      resource: 'gl.bank_account',
      tag: 'Company bank accounts',
      repository: createBankAccountRepository(vault),
      schemas: {
        create: companyBankAccountCreateSchema,
        update: companyBankAccountUpdateSchema,
        item: bankAccountItem,
        filter: bankAccountFilter,
      },
      toItem: toBankAccountItem,
      toWhere: (filter) => filter,
    }),
  );
  return router;
}
