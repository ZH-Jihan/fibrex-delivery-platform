/**
 * Performance module: public entry point (SPEC 2.13: other modules import only this file).
 *
 * Purpose: client platforms (Snoonu ...), the report sync that reads each platform's daily
 * sheet, and the daily performance figures per person (PLAN 3.11, phase 4 plan). Row 4.1
 * declares the schema, the permission keys and the starting data; the sync engine, its
 * screens and the reports arrive in rows 4.2 to 4.6 and add their routers here.
 *
 * Depends on: kernel/module-registry, kernel/permissions, ./platform-seed.ts.
 * Used by: src/main.ts, src/seed/seed.ts.
 */
import type { ModuleManifest } from '../../kernel/module-registry/index.js';
import {
  crudPermissions,
  permission,
  type PermissionDef,
} from '../../kernel/permissions/catalogue.js';

export {
  seedClientPlatforms,
  SNOONU_CODE,
  SNOONU_CYCLE_START_DAY,
  SNOONU_METRICS,
} from './platform-seed.js';

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
];

/** The module manifest. Routers are added by the rows that build them. */
export function createPerformanceModule(): ModuleManifest {
  return {
    key: 'performance',
    label: 'Performance',
    permissions: PERFORMANCE_PERMISSIONS,
  };
}
