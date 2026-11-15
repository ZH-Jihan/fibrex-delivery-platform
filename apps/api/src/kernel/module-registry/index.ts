/**
 * Module registry: public entry point. See ./registry.ts for the rules.
 * Depends on: ./manifest.ts, ./registry.ts, ./module-router.ts. Used by: modules, main.ts.
 */
export type {
  AttachableDef,
  EventTypeDef,
  ModuleManifest,
  ModuleSummary,
  NavEntryDef,
  ReportDef,
  SettingDef,
} from './manifest.js';
export { ModuleRegistry, ModuleRegistryError } from './registry.js';
export { createModuleRouter } from './module-router.js';
