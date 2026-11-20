/**
 * Tracking module: public entry point (SPEC 2.13: other modules import only this file).
 *
 * Purpose: the daily status of each person (SPEC 3.3): dated status entries with reasons,
 * "another person working the ID" periods, and the morning call log (PLAN 3.11). Row 4.1
 * declares the schema and the permission keys; the API and the call sheet arrive in rows
 * 4.7 and 4.8 and add their routers here.
 *
 * Depends on: kernel/module-registry, kernel/permissions. Used by: src/main.ts,
 * src/seed/seed.ts.
 */
import type { ModuleManifest } from '../../kernel/module-registry/index.js';
import {
  crudPermissions,
  permission,
  type PermissionDef,
} from '../../kernel/permissions/catalogue.js';

export const TRACKING_PERMISSIONS: readonly PermissionDef[] = [
  permission(
    'tracking',
    'tracking.entry',
    'read',
    'See the daily tracking sheet and status history',
  ),
  permission(
    'tracking',
    'tracking.entry',
    'create',
    'Record a status change on the tracking sheet',
  ),
  ...crudPermissions('tracking', 'tracking.id_operator_period', 'ID-operator periods'),
  permission('tracking', 'tracking.call_log', 'read', 'See the call log'),
  permission('tracking', 'tracking.call_log', 'create', 'Log a call'),
];

/** The module manifest. Routers are added by the rows that build them. */
export function createTrackingModule(): ModuleManifest {
  return {
    key: 'tracking',
    label: 'Tracking',
    permissions: TRACKING_PERMISSIONS,
  };
}
