/**
 * Entity definition service (PLAN 3.7 `entity_definition`, `field_definition`; SPEC 2.10
 * entity and form builder): the record types an administrator defines, and the custom
 * fields on built-in record types.
 *
 * What it gives other code:
 *   - `published(key)`: the definition users work with (the last published version),
 *   - `validate(key, data)`: record data checked against that version's JSON Schema, then
 *     against the lookup lists (the custom records API of row 2.5 calls this before saving),
 *   - `publish(...)`: turns the drafted changes into the next version,
 *   - `ensureSystemEntities()`: gives the current tenant a row for each built-in record type
 *     the modules registered, so custom fields can be added to them.
 *
 * Draft and publish, and why: a half-edited definition must never reach users or be used to
 * judge their data. Edits therefore only mark the definition as changed; `publish` checks
 * the whole definition, generates the schema, raises the version and stores a frozen copy.
 *
 * Not checked here: that a party, a file or a referenced record exists. Those need the
 * owning module and are checked by the records API (kernel/records).
 *
 * Permissions of a custom record type: its records are guarded by `custom.<key>.<action>`
 * (read, create, update, delete, restore). The keys are written to the catalogue when the
 * type is published, and on the first publish they are given to every role that may publish
 * record types, so whoever defined the type can use it at once; everyone else gets access
 * through the permission matrix.
 *
 * Row-level security applies as to any query: the unit of work has set the tenant context.
 *
 * Depends on: @fibrex/shared entities, kernel/db, kernel/http/errors.ts, kernel/lookups,
 * kernel/module-registry/manifest.ts (type only).
 * Used by: entity-definition-router.ts, later the custom records API (2.5) and modules that
 * store custom fields.
 */
import {
  buildJsonSchema,
  isAbsent,
  layoutProblems,
  layoutSchema,
  listConfigSchema,
  validateRecordData,
  type FieldSpec,
  type FieldStatus,
  type FieldType,
  type Layout,
  type ListConfig,
  type RecordIssue,
  type RecordJsonSchema,
} from '@fibrex/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../db/prisma.js';
import { createRepository } from '../db/repository.js';
import { currentUnit } from '../db/unit-of-work.js';
import { NotFoundError, UnprocessableError, ValidationError } from '../http/errors.js';
import { crudPermissions, syncPermissionCatalogue } from '../permissions/catalogue.js';
import type { LookupService } from '../lookups/lookup-service.js';
import type { SystemEntityDef } from '../module-registry/manifest.js';

export type EntityDefinitionRow = NonNullable<
  Awaited<ReturnType<Db['entityDefinition']['findFirst']>>
>;
export type FieldDefinitionRow = NonNullable<
  Awaited<ReturnType<Db['fieldDefinition']['findFirst']>>
>;

/** A field inside a published version (the schema generator's shape plus its id). */
export interface PublishedField extends FieldSpec {
  id: string;
}

/** The frozen content of one published version (`entity_definition_version.definition`). */
export interface PublishedDefinition {
  name: Record<string, string>;
  listConfig: ListConfig;
  formLayout: Layout;
  detailLayout: Layout;
  numberingKey: string | null;
  fields: PublishedField[];
}

/** What users of a record type work with: its last published version. */
export interface PublishedEntity extends PublishedDefinition {
  id: string;
  key: string;
  kind: string;
  permissionModuleKey: string;
  version: number;
  publishedAt: string | null;
  jsonSchema: RecordJsonSchema;
}

export interface EntityDefinitionServiceDeps {
  lookups: LookupService;
  /** The built-in record types the modules registered (read when needed, not at start-up). */
  systemEntities: () => readonly SystemEntityDef[];
}

const json = (value: unknown) => value as Prisma.InputJsonValue;

export class EntityDefinitionService {
  private readonly deps: EntityDefinitionServiceDeps;
  /**
   * The plain versioned repository. Publishing must not go through the router's repository:
   * that one flags every write as an unpublished change, which is exactly what a publish clears.
   */
  private readonly rows = createRepository<EntityDefinitionRow>({
    model: 'entityDefinition',
    scope: 'tenant',
  });

  constructor(deps: EntityDefinitionServiceDeps) {
    this.deps = deps;
  }

  /**
   * Creates the missing rows of built-in record types for the current tenant. Cheap enough
   * to call before every list: one indexed read, and a write only the first time.
   */
  async ensureSystemEntities(): Promise<void> {
    const defs = this.deps.systemEntities();
    if (defs.length === 0) return;
    const { db, context } = currentUnit();
    const existing = await db.entityDefinition.findMany({
      where: { key: { in: defs.map((d) => d.key) } },
      select: { key: true },
    });
    const have = new Set(existing.map((row) => row.key));
    const missing = defs.filter((d) => !have.has(d.key));
    if (missing.length === 0) return;
    // skipDuplicates: two requests may get here together; the unique key lets one win.
    await db.entityDefinition.createMany({
      data: missing.map((d) => ({
        tenantId: context.tenantId,
        key: d.key,
        name: json(d.name),
        kind: 'system',
        permissionModuleKey: d.key.split('.')[0] ?? d.key,
      })),
      skipDuplicates: true,
    });
  }

  /** The last published version of the record type `key`; 404 when it has none. */
  async published(key: string): Promise<PublishedEntity> {
    const { db } = currentUnit();
    const row = await db.entityDefinition.findFirst({ where: { key, deletedAt: null } });
    if (row === null || row.publishedVersion === 0) throw new NotFoundError();
    const frozen = await db.entityDefinitionVersion.findFirst({
      where: { entityDefinitionId: row.id, versionNo: row.publishedVersion },
    });
    if (frozen === null) throw new NotFoundError();
    const definition = frozen.definition as unknown as PublishedDefinition;
    return {
      ...definition,
      id: row.id,
      key: row.key,
      kind: row.kind,
      permissionModuleKey: row.permissionModuleKey,
      version: row.publishedVersion,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      jsonSchema: frozen.jsonSchema as unknown as RecordJsonSchema,
    };
  }

  /**
   * Every problem with `data` as a record of type `key` (an empty list means valid).
   *
   * Step 1: structure and limits, from the published JSON Schema (the same check the form
   *         runs in the browser).
   * Step 2: dropdown and multi-select codes must be active values of their list. A code the
   *         record already holds (`previous`) is not re-checked: retiring a lookup value
   *         must not make old records impossible to save.
   */
  async validate(
    key: string,
    data: unknown,
    options: { previous?: Record<string, unknown> } = {},
  ): Promise<RecordIssue[]> {
    const entity = await this.published(key);
    const issues = validateRecordData(entity.jsonSchema, data);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return issues;
    const values = data as Record<string, unknown>;
    const failed = new Set(issues.map((issue) => issue.path));
    for (const [fieldKey, property] of Object.entries(entity.jsonSchema.properties)) {
      const list = property['x-lookup'];
      const value = values[fieldKey];
      if (list === undefined || isAbsent(value) || failed.has(fieldKey)) continue;
      const before = options.previous?.[fieldKey];
      const kept = new Set<unknown>(Array.isArray(before) ? before : [before]);
      const codes = (Array.isArray(value) ? value : [value]) as string[];
      for (const code of codes) {
        if (kept.has(code)) continue;
        if (!(await this.deps.lookups.has(list, code))) {
          issues.push({
            path: fieldKey,
            code: 'unknown_lookup_value',
            message: `'${code}' is not an available choice.`,
          });
        }
      }
    }
    return issues;
  }

  /** As `validate`, but throws the 400 the API returns for invalid fields. */
  async assertValid(
    key: string,
    data: unknown,
    options: { previous?: Record<string, unknown> } = {},
  ): Promise<void> {
    const issues = await this.validate(key, data, options);
    if (issues.length > 0) throw new ValidationError(issues);
  }

  /**
   * Publishes the drafted changes of one definition as its next version.
   *
   * Everything runs in the caller's unit of work (one transaction): either the definition,
   * its fields and the frozen copy all move to the new version, or nothing does.
   */
  async publish(id: string, expectedVersion: number): Promise<EntityDefinitionRow> {
    const { db, context } = currentUnit();
    const current = await this.rows.get(id);

    // Step 1: there must be something to publish.
    if (current.publishedVersion > 0 && !current.hasUnpublishedChanges) {
      throw new UnprocessableError('nothing_to_publish', 'There are no changes to publish.');
    }
    const fields = await db.fieldDefinition.findMany({
      where: { entityDefinitionId: id, deletedAt: null },
      include: { lookupType: true },
      orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
    });
    const inUse = fields.filter((field) => field.status !== 'retired');
    // A custom record type without a field would give an empty form. A built-in type has
    // its own columns, so it may be published with no custom field (all of them retired).
    if (current.kind === 'custom' && inUse.length === 0) {
      throw new UnprocessableError('no_fields', 'Add at least one field before publishing.');
    }

    // Step 2: everything a field points to must still exist, or the form could not be drawn.
    for (const field of inUse) {
      if (field.lookupTypeId !== null && (field.lookupType?.deletedAt ?? null) !== null) {
        throw new UnprocessableError(
          'lookup_type_missing',
          `The list of field '${field.key}' has been deleted.`,
        );
      }
      if (field.refEntityKey !== null && field.refEntityKey !== current.key) {
        const target = await db.entityDefinition.findFirst({
          where: { key: field.refEntityKey, deletedAt: null },
          select: { id: true },
        });
        if (target === null) {
          throw new UnprocessableError(
            'unknown_ref_entity',
            `Field '${field.key}' refers to a record type that does not exist.`,
          );
        }
      }
    }

    // Step 3: the list and page layouts may only name fields that are in use.
    const layouts = {
      listConfig: listConfigSchema.parse(current.listConfig),
      formLayout: layoutSchema.parse(current.formLayout),
      detailLayout: layoutSchema.parse(current.detailLayout),
    };
    const problems = layoutProblems(
      layouts,
      inUse.map((field) => field.key),
    );
    if (problems.length > 0) throw new ValidationError(problems);

    // Step 4: generate the schema. Draft fields are part of it: they are published below.
    const specs: PublishedField[] = fields.map((field) => ({
      id: field.id,
      key: field.key,
      label: field.label as Record<string, string>,
      type: field.type as FieldType,
      validations: field.validations as Record<string, unknown>,
      required: field.required,
      sortOrder: field.sortOrder,
      status: (field.status === 'draft' ? 'published' : field.status) as FieldStatus,
      lookupKey: field.lookupType?.key ?? null,
      refEntityKey: field.refEntityKey,
    }));
    const jsonSchema = buildJsonSchema(specs);
    const versionNo = current.publishedVersion + 1;

    // Step 5: the versioned write goes first, so someone else's change since the caller
    // last read the definition stops the publish (409) before anything else is written.
    const updated = await this.rows.update(id, expectedVersion, {
      jsonSchema,
      status: 'published',
      publishedVersion: versionNo,
      publishedAt: new Date(),
      hasUnpublishedChanges: false,
    });
    await db.fieldDefinition.updateMany({
      where: { entityDefinitionId: id, deletedAt: null, status: 'draft' },
      data: { status: 'published' },
    });

    // Step 6: the frozen copy records and pages are read with.
    const definition: PublishedDefinition = {
      name: current.name as Record<string, string>,
      ...layouts,
      numberingKey: current.numberingKey,
      fields: specs,
    };
    await db.entityDefinitionVersion.create({
      data: {
        tenantId: context.tenantId,
        entityDefinitionId: id,
        versionNo,
        definition: json(definition),
        jsonSchema: json(jsonSchema),
        createdBy: context.userId ?? null,
      },
    });

    // Step 7: the permission keys of a custom type's records (see the header).
    if (current.kind === 'custom') await this.grantRecordPermissions(current.key, versionNo === 1);
    return updated;
  }

  /**
   * Writes `custom.<key>.*` to the permission catalogue and, on the first publish only,
   * gives the keys to the roles that hold `platform.entity_definition.publish`.
   *
   * Why only the first time: an administrator may later take a key away from a role in the
   * matrix, and publishing a new version must not quietly hand it back.
   * The description names the key, not the type's name: the catalogue is shared by all
   * tenants, and two tenants may use the same key for differently named types.
   * Row-level security limits the roles read and the rows written to the caller's tenant.
   */
  private async grantRecordPermissions(key: string, firstPublish: boolean): Promise<void> {
    const { db, context } = currentUnit();
    const defs = crudPermissions('custom', `custom.${key}`, `"${key}" records`);
    await syncPermissionCatalogue(db, defs);
    if (!firstPublish) return;
    await db.$executeRaw`
      INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
      SELECT ${context.tenantId}::uuid, holder.role_id, p.id
      FROM (
        SELECT DISTINCT rp.role_id
        FROM iam.role_permission rp
        JOIN iam.permission held ON held.id = rp.permission_id
        JOIN iam.role r ON r.id = rp.role_id
        WHERE held.key = 'platform.entity_definition.publish'
          AND rp.deleted_at IS NULL
          AND r.deleted_at IS NULL
      ) holder
      CROSS JOIN iam.permission p
      WHERE p.key = ANY(${defs.map((d) => d.key)}::text[])
        AND NOT EXISTS (
          SELECT 1 FROM iam.role_permission existing
          WHERE existing.role_id = holder.role_id
            AND existing.permission_id = p.id
            AND existing.deleted_at IS NULL)`;
  }
}
