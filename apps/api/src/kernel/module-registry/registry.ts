/**
 * Module registry (SPEC 2.13, PLAN 4 `kernel/module-registry`).
 *
 * Purpose: collect every module's manifest once, check it, and hand the pieces to the
 * kernel layers that need them: routers to Express, permissions to the catalogue sync,
 * event types to the notify catalogue, recycle-bin types and attachables to their
 * registries, and the menu to the web through `GET /modules`.
 *
 * Checks done at registration (a mistake fails start-up, never a request):
 *   - a module key is registered once and is a plain lower-case identifier;
 *   - every permission, event type and recycle-bin type carries the module's own key, so
 *     the permission matrix groups them under the right module and no module can quietly
 *     define keys for another;
 *   - nothing is registered after the routers were mounted.
 * Checked at mount: every permission a menu entry, setting, report or attachable refers to
 * exists in the kernel's or some module's list, so the shell never shows a screen that the
 * API cannot authorise.
 *
 * Depends on: ./manifest.ts, kernel/permissions/catalogue.ts (PermissionDef),
 * kernel/audit/recycle-bin.ts (RecycleBinType). Used by: src/main.ts, ./module-router.ts,
 * tests.
 */
import type { Router } from 'express';
import type { RecycleBinType } from '../audit/recycle-bin.js';
import type { PermissionDef } from '../permissions/catalogue.js';
import type {
  AttachableDef,
  EventTypeDef,
  ModuleManifest,
  ModuleSummary,
  NavEntryDef,
  SystemEntityDef,
} from './manifest.js';

export class ModuleRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleRegistryError';
  }
}

export class ModuleRegistry {
  private readonly manifests = new Map<string, ModuleManifest>();
  private readonly kernelPermissions: readonly PermissionDef[];
  private mounted = false;

  /** `kernelPermissions`: keys the kernel checks itself (IAM, audit, jobs ...). */
  constructor(options: { kernelPermissions?: readonly PermissionDef[] } = {}) {
    this.kernelPermissions = options.kernelPermissions ?? [];
  }

  register(manifest: ModuleManifest): void {
    if (this.mounted) {
      throw new ModuleRegistryError(
        `Module '${manifest.key}' registered after the routers were mounted`,
      );
    }
    if (!/^[a-z][a-z0-9_]*$/.test(manifest.key)) {
      throw new ModuleRegistryError(
        `Module key '${manifest.key}' must be lower-case letters, digits and underscores`,
      );
    }
    if (this.manifests.has(manifest.key)) {
      throw new ModuleRegistryError(`Module '${manifest.key}' is registered twice`);
    }
    // Everything a module declares belongs to it: the matrix and the recycle bin group by
    // module key, and a module must not be able to smuggle keys into another's group.
    for (const p of manifest.permissions) this.ownKey(manifest, 'permission', p.key, p.moduleKey);
    for (const e of manifest.eventTypes ?? []) {
      this.ownKey(manifest, 'event type', e.key, e.moduleKey);
    }
    for (const r of manifest.recycleTypes ?? []) {
      this.ownKey(manifest, 'recycle-bin type', r.entityType, r.moduleKey);
    }
    for (const e of manifest.entities ?? []) {
      // The part before the dot is the owning module, as for every `<schema>.<table>` name.
      this.ownKey(manifest, 'entity', e.key, e.key.split('.')[0] ?? '');
    }
    const seen = new Set<string>();
    for (const p of manifest.permissions) {
      if (seen.has(p.key)) {
        throw new ModuleRegistryError(
          `Module '${manifest.key}' declares permission '${p.key}' twice`,
        );
      }
      seen.add(p.key);
    }
    this.manifests.set(manifest.key, manifest);
  }

  private ownKey(manifest: ModuleManifest, what: string, key: string, moduleKey: string): void {
    if (moduleKey !== manifest.key) {
      throw new ModuleRegistryError(
        `Module '${manifest.key}' declares ${what} '${key}' with module key '${moduleKey}'`,
      );
    }
  }

  /** Registered manifests in registration order. */
  all(): readonly ModuleManifest[] {
    return [...this.manifests.values()];
  }

  get(key: string): ModuleManifest | undefined {
    return this.manifests.get(key);
  }

  /** Module permissions only; `main.ts` adds the kernel's before the catalogue sync. */
  permissions(): PermissionDef[] {
    return this.all().flatMap((m) => [...m.permissions]);
  }

  eventTypes(): EventTypeDef[] {
    return this.all().flatMap((m) => [...(m.eventTypes ?? [])]);
  }

  recycleTypes(): RecycleBinType[] {
    return this.all().flatMap((m) => [...(m.recycleTypes ?? [])]);
  }

  attachables(): AttachableDef[] {
    return this.all().flatMap((m) => [...(m.attachables ?? [])]);
  }

  entities(): SystemEntityDef[] {
    return this.all().flatMap((m) => [...(m.entities ?? [])]);
  }

  nav(): NavEntryDef[] {
    return this.all().flatMap((m) => [...(m.nav ?? [])]);
  }

  /**
   * Checks every permission reference, then mounts each module's routers on `api` in
   * registration order. Called once; registering afterwards is refused.
   */
  mount(api: Router): void {
    if (this.mounted) throw new ModuleRegistryError('Modules are already mounted');
    this.validateReferences();
    for (const manifest of this.all()) {
      for (const router of manifest.routers ?? []) api.use(router);
    }
    this.mounted = true;
  }

  /** Every permission a manifest points at must be declared by the kernel or a module. */
  validateReferences(): void {
    const known = new Set([...this.kernelPermissions, ...this.permissions()].map((p) => p.key));
    for (const m of this.all()) {
      const refs: { what: string; permission: string }[] = [
        ...(m.nav ?? []).map((n) => ({ what: `menu entry ${n.path}`, permission: n.permission })),
        ...(m.settings ?? []).map((s) => ({ what: `setting ${s.key}`, permission: s.permission })),
        ...(m.reports ?? []).map((r) => ({ what: `report ${r.key}`, permission: r.permission })),
        ...(m.attachables ?? []).flatMap((a) => [
          { what: `attachable ${a.entityType}`, permission: a.readPermission },
          { what: `attachable ${a.entityType}`, permission: a.attachPermission },
        ]),
      ];
      for (const ref of refs) {
        if (!known.has(ref.permission)) {
          throw new ModuleRegistryError(
            `Module '${m.key}': ${ref.what} needs unknown permission '${ref.permission}'`,
          );
        }
      }
    }
  }

  /** The manifests without code, for `GET /modules`. */
  summaries(): ModuleSummary[] {
    return this.all().map((m) => ({
      key: m.key,
      label: m.label,
      permissions: m.permissions.map((p) => p.key),
      nav: [...(m.nav ?? [])],
      settings: [...(m.settings ?? [])],
      reports: [...(m.reports ?? [])],
      eventTypes: (m.eventTypes ?? []).map((e) => e.key),
    }));
  }
}
