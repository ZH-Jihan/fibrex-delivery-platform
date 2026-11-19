# Adding a module (or one new resource)

Worked from the existing `modules/notify` and `kernel/platform/organisation-router.ts`. Example: module `fleet`, resource `fleet.vehicle`. The rules behind each step are in CLAUDE.md and SPEC 2.

## 1. Migration (SQL by hand)

New folder `apps/api/prisma/migrations/<yyyymmddhhmmss>_fleet/migration.sql`. Additive only.

```sql
CREATE SCHEMA fleet;
CREATE TABLE fleet.vehicle (
  id            uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid NOT NULL,
  company_id    uuid NOT NULL,
  plate         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version       integer NOT NULL DEFAULT 1,
  deleted_at    timestamptz, deleted_by uuid, delete_reason text,
  CONSTRAINT vehicle_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT vehicle_tenant_fk FOREIGN KEY (tenant_id) REFERENCES platform.tenant (id)
);
SELECT app.setup_table('fleet', 'vehicle', 'company');
```

`app.setup_table` adds the audit trigger, version and soft-delete triggers, grants (no DELETE for the app role) and the RLS policy. Pick the kind: `company` (company-scoped), `tenant`, `company_append` / `tenant_append` (insert-only), `global`, `global_catalog`. Reference people through `party_id`, never copy names. Money columns: `NUMERIC(18,4)` plus a currency code, and no balances (post journal entries instead). Apply with `pnpm db:migrate`.

## 2. Prisma model

Add `apps/api/prisma/schema/fleet.prisma` (copy the shape of `notify.prisma`) and add `"fleet"` to `schemas` in `base.prisma`. Run `pnpm typecheck` (it regenerates the client). The drift test `test/integration/schema-drift.test.ts` fails if the SQL and the model disagree.

## 3. Zod schemas

Create, update and item schemas in `packages/shared/src/<area>` (shared by API and web forms), exported from `packages/shared/src/index.ts`. Use `z.strictObject` for input.

## 4. Module code

`apps/api/src/modules/fleet/`, with a header comment on every file (purpose, depends on, used by):

- Repository: `createRepository(...)` from `kernel/db/repository.ts` (soft delete, versioning).
- `router.ts`: `createCrudRouter({ uow, authorize: permissions.authorize, registry }, { path: '/vehicles', resource: 'fleet.vehicle', tag: 'Vehicles', repository, schemas: { create, update, item }, toItem })`. Extra rules go in handlers through `currentUnit()`; never run SQL outside a unit of work.
- `index.ts`: the only file other modules may import. Export the service interface, `FLEET_PERMISSIONS` and `createFleetModule(deps): ModuleManifest` (type from `kernel/module-registry`), which returns the manifest: `key: 'fleet'`, `label`, `permissions`, `routers`, and when needed `eventTypes`, `nav` (path, i18n keys, permission), `settings`, `reports`, `recycleTypes` (restorable resources) and `attachables` (resources that take files).

Register it in `src/main.ts` inside `mountApi` with one line: `modules.register(createFleetModule({ uow, registry, permissions }))`. The registry mounts the routers, feeds the recycle bin, the attachable registry, the permission catalogue and the event-type catalogue, and serves the manifest on `GET /modules`. It refuses a manifest whose keys carry another module's key or whose menu entries point at an unknown permission.

## 5. Permissions

In `index.ts`: `export const FLEET_PERMISSIONS = [...crudPermissions('fleet', 'fleet.vehicle', 'vehicles')]` (keys `fleet.vehicle.read|create|update|delete|restore`) and put it in the manifest; nothing to add in `main.ts`. Grant keys to roles in the seed (`apps/api/src/seed`) or on the matrix screen; never test a role name in code. For business events, declare the event types in the manifest and call `NotifyService.emit` after your transaction commits.

## 6. Web screen and menu entry

- Screens under `apps/web/src/fleet/` using `ui/DataTable`, `ui/EntityForm` and `ui/HistoryTab`; hide buttons with `can('fleet.vehicle.create')`.
- Add the route in `apps/web/src/App.tsx`.
- Add `apps/web/src/fleet/manifest.ts` exporting a `WebModuleManifest` (`key: 'fleet'`, menu groups with `to`, `label` i18n key, `permission: 'fleet.vehicle.read'`, lucide icon), list it in `WEB_MODULES` in `apps/web/src/shell/nav.ts`, and add the labels in `i18n/en.ts` (other languages fall back to English). Use the same path and permission as the API manifest's `nav` entry.
- Module label for the permission matrix: add it through the i18n keys used by `tOr()`, as done for party, files and notify.

## 7. Tests

- API integration test `apps/api/test/integration/fleet.test.ts` (copy the helpers from `organisation.test.ts`): create, read, update, delete; 409 on a stale `If-Match`; 403 without the permission; another company or tenant cannot see the rows (RLS); delete needs a reason; restore from the recycle bin; an audit row is written.
- Unit tests for any rule or money logic, next to the code.
- Web test beside the screen (`*.test.tsx`). Add a Playwright journey in `apps/web/e2e` only for a main user journey.
- Before finishing: `pnpm lint`, `pnpm typecheck`, `pnpm test`.

## 8. Docs

One line in `docs/PROGRESS.md`; a row in `docs/DECISIONS.md` only if a later phase depends on the choice.

## 9. Using engines (Phase 2)

Inject the service through your module's deps and call it inside a unit of work. Never bypass the service to query engine tables directly.

### Formulas

```typescript
// In your module's index.ts deps: formulas: FormulaService
const result = await formulas.evaluate('fleet.mileage_charge', onDate, { km: 450 });
// result.value is NUMERIC(18,4) text; result.trace lists each step when explain: true is passed.
```

Declare the formula key in your module manifest's `formulaKeys` list so the formula builder validates it.

### Rate tables

```typescript
// In your module's index.ts deps: rates: RateTableService
const rate = await rates.resolve('fleet.fuel_surcharge', onDate, { region: 'north' });
// Returns the NUMERIC(18,4) rate string, or null when no row matches.
```

### State machines

```typescript
// In your module's index.ts deps: states: StateService
await states.transition({ entityType: 'fleet.vehicle', entityId: id, toCode: 'active' });
// Throws if the transition is not allowed from the current state.
```

Declare `entityType` in `recycleTypes` if you want soft-deleted records restorable from the state machine.

### Workflows

```typescript
// In your module's index.ts deps: workflows: WorkflowService
await workflows.onCreated('fleet.vehicle', record.id);
// Called after a successful create so an `on_create` binding fires immediately.
```

Pass `workflows.onCreated` and `workflows.onUpdated` as callbacks when you create records; never reach into the workflow tables directly.

### Events (outbox)

```typescript
// In your module's index.ts deps: outbox: EventOutbox
outbox.record({
  eventType: 'fleet.vehicle.created',
  companyId,
  aggregateType: 'fleet.vehicle',
  aggregateId: record.id,
  payload: { plateNo: record.plate },
});
// Called inside the same unit of work as the write; the dispatcher delivers it after commit.
```

Declare the event type in the manifest's `eventTypes` list so subscribers can filter it and the outbox validates the type name.
