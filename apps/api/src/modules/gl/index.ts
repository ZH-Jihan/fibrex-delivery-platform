/**
 * General ledger module (`gl`): public entry point (SPEC 2.13: other modules import only
 * this file).
 *
 * Purpose (row 2.14, ledger set-up): chart of accounts, cost centres, tax codes, exchange
 * rates, fiscal years and periods with close, lock and reopen. Row 2.15 adds posting rules,
 * journals and the posting service here; row 2.16 the ledger reports and screens.
 *
 * Depends on: ./setup-router.ts, ./fiscal-router.ts, ./setup-service.ts, ./chart-seed.ts,
 * kernel/module-registry, kernel/permissions. Used by: src/main.ts, src/seed/seed.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import type { RecycleBinType } from '../../kernel/audit/recycle-bin.js';
import type { BaseRow, Repository } from '../../kernel/db/repository.js';
import type { UnitOfWork } from '../../kernel/db/unit-of-work.js';
import type { ModuleManifest } from '../../kernel/module-registry/index.js';
import {
  crudPermissions,
  permission,
  type PermissionDef,
} from '../../kernel/permissions/catalogue.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import { createFiscalRouter, createFiscalYearRepository } from './fiscal-router.js';
import {
  createAccountRepository,
  createCostCentreRepository,
  createExchangeRateRepository,
  createSetupRouter,
  createTaxCodeRepository,
} from './setup-router.js';

export { seedLedger, STANDARD_CHART, type LedgerSeedResult } from './chart-seed.js';
export { LedgerSetupService, type RateOnDay } from './setup-service.js';
export type { FiscalPeriodRecord, FiscalYearRecord } from './fiscal-router.js';
export type { AccountRecord, TaxCodeRecord } from './setup-router.js';

export const GL_PERMISSIONS: readonly PermissionDef[] = [
  ...crudPermissions('gl', 'gl.account', 'the chart of accounts'),
  ...crudPermissions('gl', 'gl.cost_centre', 'cost centres'),
  ...crudPermissions('gl', 'gl.tax_code', 'tax codes'),
  ...crudPermissions('gl', 'gl.exchange_rate', 'exchange rates'),
  ...crudPermissions('gl', 'gl.fiscal_year', 'fiscal years'),
  permission('gl', 'gl.fiscal_period', 'read', 'View fiscal periods'),
  permission('gl', 'gl.fiscal_period', 'close', 'Close an open fiscal period'),
  permission('gl', 'gl.fiscal_period', 'lock', 'Lock a closed fiscal period (final)'),
  permission('gl', 'gl.fiscal_period', 'reopen', 'Reopen a closed fiscal period (with a reason)'),
  permission(
    'gl',
    'gl.fiscal_period',
    'unlock',
    'Reopen a locked fiscal period (also needs the reopen permission)',
  ),
];

export interface GlModuleDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
}

export function createGlModule(deps: GlModuleDeps): ModuleManifest {
  // One recycle-bin entry; the cast only widens the row type, the repository is unchanged.
  const recycle = <TRow extends BaseRow>(
    entityType: string,
    label: string,
    repository: Repository<TRow>,
    describe: (row: TRow) => string,
  ): RecycleBinType =>
    ({ entityType, moduleKey: 'gl', label, repository, describe }) as unknown as RecycleBinType;

  return {
    key: 'gl',
    label: 'General ledger',
    permissions: GL_PERMISSIONS,
    routers: [createSetupRouter(deps), createFiscalRouter(deps)],
    recycleTypes: [
      recycle('gl.account', 'Account', createAccountRepository(), (r) => r.code),
      recycle(
        'gl.cost_centre',
        'Cost centre',
        createCostCentreRepository(),
        (r) => `${r.code} ${r.name}`,
      ),
      recycle('gl.tax_code', 'Tax code', createTaxCodeRepository(), (r) => `${r.code} ${r.name}`),
      recycle(
        'gl.exchange_rate',
        'Exchange rate',
        createExchangeRateRepository(),
        (r) => `${r.fromCurrency}/${r.toCurrency} ${r.rateDate.toISOString().slice(0, 10)}`,
      ),
      recycle('gl.fiscal_year', 'Fiscal year', createFiscalYearRepository(), (r) => r.name),
    ],
  };
}
