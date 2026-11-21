/**
 * Performance module: public entry point (SPEC 2.13: other modules import only this file).
 *
 * Purpose: client platforms (Snoonu ...), the report sync that reads each platform's daily
 * sheet, and the daily performance figures per person (PLAN 3.11, phase 4 plan). Row 4.1
 * declares the schema, the permission keys and the starting data; the sync engine, its
 * screens and the reports arrive in rows 4.2 to 4.6 and add their routers here. Row 4.3 adds
 * the sync engine (./sync-service.ts), its queue and schedules (./sync-queue.ts), the run
 * routes (./sync-router.ts) and the admin alert event `performance.sync_problem`. Row 4.4
 * adds the read-only Google Sheets reader and connection (./google-connection.ts,
 * ./google-router.ts) and the sync source routes (./sync-source-router.ts).
 *
 * Depends on: kernel/module-registry, kernel/permissions, ./platform-seed.ts, ./cycle.ts,
 * ./report-adapter.ts, ./snoonu-parser.ts, ./source-providers.ts, ./sync-service.ts,
 * ./sync-queue.ts, ./sync-router.ts, ./sync-alert-seed.ts, ./google-connection.ts,
 * ./google-router.ts, ./sync-source-router.ts.
 * Used by: src/main.ts, src/seed/seed.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import type { SecretBox } from '../../kernel/crypto/secret-box.js';
import type { UnitOfWork } from '../../kernel/db/unit-of-work.js';
import type { ModuleManifest } from '../../kernel/module-registry/index.js';
import {
  crudPermissions,
  permission,
  type PermissionDef,
} from '../../kernel/permissions/catalogue.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import type { GoogleConnectionService } from './google-connection.js';
import { createGoogleRouter } from './google-router.js';
import type { PartyService } from '../party/index.js';
import type { EmployeeDirectory } from '../people/index.js';
import { createPerformanceReportRouter } from './performance-report-router.js';
import { PERFORMANCE_REPORTS } from './performance-reports.js';
import { createSummaryRouter } from './summary-router.js';
import type { SummaryService } from './summary-service.js';
import { createSyncSourceRouter } from './sync-source-router.js';
import { createUnmatchedRouter } from './unmatched-router.js';
import type { SyncQueue } from './sync-queue.js';
import { createSyncRouter } from './sync-router.js';
import { SYNC_PROBLEM_EVENT, type SyncService } from './sync-service.js';

export {
  seedClientPlatforms,
  SNOONU_CODE,
  SNOONU_CYCLE_START_DAY,
  SNOONU_METRICS,
} from './platform-seed.js';
export { addDays, blockDate, cycleContaining, type Cycle } from './cycle.js';
export * from './report-adapter.js';
export { parseDailyReport, snoonuReportAdapter } from './snoonu-parser.js';
export * from './source-providers.js';
export * from './sync-service.js';
export {
  GoogleConnectionService,
  GoogleSheetsProvider,
  assertReadable,
  toGrid,
  GOOGLE_ADAPTER_KIND,
  authModeOf,
  GOOGLE_PROVIDER,
  type GoogleConnectionStatus,
} from './google-connection.js';
export { GOOGLE_MANAGE } from './google-router.js';
export {
  PERFORMANCE_REPORTS,
  qatarToday,
  thisAndLastCycle,
  yesterdayInQatar,
} from './performance-reports.js';
export { SyncQueue, SYNC_QUEUE, type SyncJob, type SyncQueueOptions } from './sync-queue.js';
export { seedSyncAlertRule, SYNC_PROBLEM_RULE_NAME } from './sync-alert-seed.js';
export {
  SummaryService,
  readSummarySettings,
  writeSummarySettings,
  SUMMARY_TEMPLATE_KEY,
  SUMMARY_INCOMPLETE_TEMPLATE_KEY,
  type SummaryResult,
  type SummaryRunResult,
  type SummaryServiceDeps,
} from './summary-service.js';
export { SUMMARY_MANAGE } from './summary-router.js';
export { seedPerformanceSummary, OWNER_SUMMARY_RECIPIENTS } from './summary-seed.js';
export { summariseDay, dueSummaryDate, localClock } from './summary-calc.js';

export const PERFORMANCE_PERMISSIONS: readonly PermissionDef[] = [
  ...crudPermissions('performance', 'performance.client_platform', 'client platforms'),
  ...crudPermissions(
    'performance',
    'performance.sync_source',
    'sync sources and their column mappings',
  ),
  ...crudPermissions('performance', 'performance.metric_definition', 'metric definitions'),
  permission('performance', 'performance.sync_run', 'read', 'See sync runs and their errors'),
  permission(
    'performance',
    'performance.sync_run',
    'run',
    "Run a sync now, re-import a date range or upload a day's Excel",
  ),
  permission('performance', 'performance.unmatched', 'read', 'See unmatched platform ids'),
  permission(
    'performance',
    'performance.unmatched',
    'resolve',
    'Link, create or ignore an unmatched platform id',
  ),
  permission('performance', 'performance.daily', 'read', 'See daily performance figures'),
  permission(
    'performance',
    'performance.report',
    'view',
    'See the performance reports and a person’s performance history',
  ),
  permission(
    'performance',
    'performance.summary',
    'manage',
    'Set who gets the daily performance summary email and send it now',
  ),
  permission(
    'performance',
    'performance.google_connection',
    'manage',
    'Connect, test and disconnect the Google account that reads platform sheets (read-only)',
  ),
];

/** What the module's routers need (absent: the manifest declares permissions only). */
export interface PerformanceModuleDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  sync: SyncService;
  syncQueue: SyncQueue;
  /** Row 4.4: with these, the Google connection and sync source routes are mounted. */
  google?: GoogleConnectionService;
  box?: SecretBox;
  /** Row 4.5b: with both, the unmatched riders queue routes are mounted. */
  parties?: PartyService;
  employees?: EmployeeDirectory;
  /** Row 4.6b: with it, the daily summary settings and "Send now" routes are mounted. */
  summary?: SummaryService;
}

/** The module manifest. Routers are added by the rows that build them. */
export function createPerformanceModule(deps?: PerformanceModuleDeps): ModuleManifest {
  return {
    key: 'performance',
    label: 'Performance',
    permissions: PERFORMANCE_PERMISSIONS,
    reports: PERFORMANCE_REPORTS,
    eventTypes: [
      {
        key: SYNC_PROBLEM_EVENT,
        moduleKey: 'performance',
        label: 'Sync problem',
        description:
          'A sync run could not use the report (unreachable after its last retry, no reader, empty, layout changed). Payload: runId, sourceName, platformCode, businessDate, problem, message.',
      },
    ],
    ...(deps === undefined
      ? {}
      : {
          routers: [
            createSyncRouter({
              uow: deps.uow,
              registry: deps.registry,
              permissions: deps.permissions,
              service: deps.sync,
              queue: deps.syncQueue,
            }),
            createPerformanceReportRouter({
              uow: deps.uow,
              registry: deps.registry,
              permissions: deps.permissions,
            }),
            ...(deps.summary === undefined
              ? []
              : [
                  createSummaryRouter({
                    uow: deps.uow,
                    registry: deps.registry,
                    permissions: deps.permissions,
                    summary: deps.summary,
                  }),
                ]),
            ...(deps.parties === undefined || deps.employees === undefined
              ? []
              : [
                  createUnmatchedRouter({
                    uow: deps.uow,
                    registry: deps.registry,
                    permissions: deps.permissions,
                    parties: deps.parties,
                    directory: deps.employees,
                  }),
                ]),
            ...(deps.google === undefined || deps.box === undefined
              ? []
              : [
                  createGoogleRouter({
                    uow: deps.uow,
                    registry: deps.registry,
                    permissions: deps.permissions,
                    google: deps.google,
                  }),
                  createSyncSourceRouter({
                    uow: deps.uow,
                    registry: deps.registry,
                    permissions: deps.permissions,
                    box: deps.box,
                    google: deps.google,
                    queue: deps.syncQueue,
                  }),
                ]),
          ],
        }),
  };
}
