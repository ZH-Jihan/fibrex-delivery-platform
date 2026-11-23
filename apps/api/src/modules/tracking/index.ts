/**
 * Tracking module: public entry point (SPEC 2.13: other modules import only this file).
 *
 * Purpose: the daily status of each person (SPEC 3.3): the morning call sheet's entries with
 * call outcome, status, reason and effective date, "another person working the ID" periods,
 * and the call log (PLAN 3.11). Row 4.1 declared the schema; row 4.7 adds the API
 * (./tracking-router.ts), the service that applies a recorded status to the employee status
 * state machine (./tracking-service.ts, with the job for future-dated changes), the call
 * sheet read model (./call-sheet.ts) and the menu entry for the screen of row 4.8.
 *
 * Depends on: kernel/module-registry, kernel/permissions, ./tracking-router.ts,
 * ./tracking-service.ts. Used by: src/main.ts, src/seed/seed.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import type { UnitOfWork } from '../../kernel/db/unit-of-work.js';
import type { ModuleManifest } from '../../kernel/module-registry/index.js';
import { permission, type PermissionDef } from '../../kernel/permissions/catalogue.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import { can } from '@fibrex/shared';
import { AMOUNTS_VIEW } from '../performance/index.js';
import { createCallSheetReport } from './call-sheet-report.js';
import { createTrackingRouter } from './tracking-router.js';
import type { TrackingService } from './tracking-service.js';

export {
  TrackingService,
  type ApplyDueResult,
  type TrackingServiceDeps,
} from './tracking-service.js';
export { PLATFORM_PROFESSIONS } from './call-sheet.js';

/**
 * Row 4.7 keys. Migration 20261130000000_tracking_call_sheet gave roles holding the row 4.1
 * keys (tracking.entry.read, tracking.id_operator_period.*, tracking.call_log.*) these instead
 * and switched the old ones off.
 */
export const TRACKING_PERMISSIONS: readonly PermissionDef[] = [
  permission(
    'tracking',
    'tracking.entry',
    'view',
    "See the morning call sheet, its cross-check and each person's tracking history",
  ),
  permission(
    'tracking',
    'tracking.entry',
    'create',
    'Record a call sheet entry or an ID-operator period',
  ),
  permission(
    'tracking',
    'tracking.entry',
    'update',
    'Change a call sheet entry or an ID-operator period',
  ),
  permission('tracking', 'tracking.call', 'create', 'Log a call'),
  permission(
    'tracking',
    'tracking.status',
    'apply',
    "Change a person's status from the call sheet (also needs the employee status permission)",
  ),
];

/** What the module's router needs (absent: the manifest declares permissions only). */
export interface TrackingModuleDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  tracking: TrackingService;
}

/** Whether the caller may see COD amounts in the export (never, without the permission service). */
function amountsAllowed(deps: TrackingModuleDeps | undefined): () => Promise<boolean> {
  return async () =>
    deps === undefined ? false : can(await deps.permissions.current(), AMOUNTS_VIEW);
}

export function createTrackingModule(deps?: TrackingModuleDeps): ModuleManifest {
  return {
    key: 'tracking',
    label: 'Tracking',
    permissions: TRACKING_PERMISSIONS,
    reports: [createCallSheetReport(amountsAllowed(deps))],
    nav: [
      {
        path: '/tracking',
        labelKey: 'nav.tracking',
        groupKey: 'nav.performance.group',
        permission: 'tracking.entry.view',
      },
    ],
    ...(deps === undefined ? {} : { routers: [createTrackingRouter(deps)] }),
  };
}
