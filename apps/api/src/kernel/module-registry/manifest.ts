/**
 * Module manifest (SPEC 2.13): the one object a module hands to the kernel to describe
 * everything it contributes. The kernel reads it and wires routes, the permission
 * catalogue, the event-type catalogue, the recycle bin, file attachments and the menu,
 * so adding a module means adding a folder with a manifest and one line in `main.ts`,
 * never edits inside the kernel.
 *
 * Only shapes live here; the behaviour is in ./registry.ts. Report definitions and
 * settings are declared now so later rows (2.2 numbering settings, 2.13 reports) can
 * use them without changing the manifest's shape again.
 *
 * Depends on: express (Router type), kernel/permissions/catalogue.ts,
 * kernel/audit/recycle-bin.ts, kernel/db/prisma.ts. Used by: ./registry.ts, every
 * module's index.ts, src/main.ts.
 */
import type { Router } from 'express';
import type { RecycleBinType } from '../audit/recycle-bin.js';
import type { Db } from '../db/prisma.js';
import type { PermissionDef } from '../permissions/catalogue.js';

/** A business event a module announces; written to `notify.event_type` at start-up. */
export interface EventTypeDef {
  /** `<module>.<thing>.<happened>`, e.g. `party.bank_account.approved`. */
  key: string;
  moduleKey: string;
  label: string;
  description?: string;
}

/** A menu entry the web shell may show (the web keeps the icon and the translation). */
export interface NavEntryDef {
  /** Route path in the web app, e.g. `/people`. */
  path: string;
  /** i18n key of the label, e.g. `nav.people`. */
  labelKey: string;
  /** i18n key of the menu group, e.g. `nav.people.group`. */
  groupKey: string;
  /** Permission needed to see the entry (the API refuses the data without it anyway). */
  permission: string;
}

/** A settings page a module offers (listed on the Settings screen from row 2.2 on). */
export interface SettingDef {
  key: string;
  label: string;
  /** Route path of the screen in the web app. */
  path: string;
  permission: string;
}

/** A report a module defines in code; the report engine (row 2.13) syncs it to a table. */
export interface ReportDef {
  key: string;
  label: string;
  permission: string;
}

/**
 * A record type that takes file attachments. Structurally the same as the files module's
 * `AttachableType`, declared here so the kernel never imports a module.
 */
export interface AttachableDef {
  /** `<schema>.<table>`, as stored in file_attachment.entity_type. */
  entityType: string;
  readPermission: string;
  attachPermission: string;
  /** True when the record exists and the caller can see it (row-level security applies). */
  exists(db: Db, id: string): Promise<boolean>;
}

/**
 * A built-in record type that takes custom fields (PLAN 3.7: system entities are registered
 * in `cfg.entity_definition` too). The entity engine creates the row for each tenant.
 */
export interface SystemEntityDef {
  /** `<schema>.<table>`, e.g. `party.party`; the schema is the module key. */
  key: string;
  /** Name per language shown in the builder; English is required. */
  name: Record<string, string>;
}

export interface ModuleManifest {
  /** Short unique key, the schema name: `party`, `files`, `notify`, later `loans` ... */
  key: string;
  /** Name shown to administrators. */
  label: string;
  /** Every permission the module checks. Each `moduleKey` must equal `key`. */
  permissions: readonly PermissionDef[];
  /** Routers mounted under /api/v1 in the order given. */
  routers?: readonly Router[];
  eventTypes?: readonly EventTypeDef[];
  nav?: readonly NavEntryDef[];
  settings?: readonly SettingDef[];
  reports?: readonly ReportDef[];
  /** Resources the recycle bin lists and restores. */
  recycleTypes?: readonly RecycleBinType[];
  /** Resources files can be attached to. */
  attachables?: readonly AttachableDef[];
  /** Built-in record types administrators may add custom fields to. */
  entities?: readonly SystemEntityDef[];
}

/** What `GET /modules` returns for one module: the manifest without code. */
export interface ModuleSummary {
  key: string;
  label: string;
  permissions: string[];
  nav: NavEntryDef[];
  settings: SettingDef[];
  reports: ReportDef[];
  eventTypes: string[];
}
