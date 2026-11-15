/**
 * Import targets: what a sheet can be imported into.
 *
 * Purpose: the import engine knows nothing about parties, vehicles or custom record types.
 * It asks a target for the fields a mapping may fill, for a check of one row, for creating
 * the record and for taking it back out. A module that wants its table importable registers
 * a target (`ImportTargets.register`); every custom record type is importable without any
 * code through `customRecordTarget` (SPEC 2.6: the business adds record types as data).
 *
 * Why the targets go through the owning service and not the database directly: the rules
 * of a record (validation, numbering, audit stamps, soft delete) live in that service, so an
 * import can never write something the normal screen would refuse (SPEC 2.1-2.3).
 *
 * Depends on: kernel/records, kernel/entities, kernel/http/errors. Used by: ./import-service,
 * src/main.ts.
 */
import { NotFoundError } from '../http/errors.js';
import type { EntityDefinitionService } from '../entities/entity-definition-service.js';
import type { RecordService } from '../records/record-service.js';
import type { ImportValue, RowIssue } from '@fibrex/shared';

export interface ImportField {
  key: string;
  label: string;
  required: boolean;
}

export interface ImportTarget {
  /** The entity key the import job names (`vehicle`, `party.party`). */
  readonly key: string;
  readonly label: string;
  /** The permission needed to create records of this kind; checked when a job starts and commits. */
  readonly createPermission: string;
  /** The fields a mapping may fill. */
  fields(): Promise<ImportField[]>;
  /** Problems with one normalised row; an empty list means the row can be created. Writes nothing. */
  validate(values: Record<string, ImportValue>): Promise<RowIssue[]>;
  /** Creates the record inside the caller's unit of work and returns its id. */
  create(values: Record<string, ImportValue>, companyId: string): Promise<string>;
  /** Soft-deletes a record this import created (audited, recoverable). */
  remove(id: string, reason: string): Promise<void>;
}

export class ImportTargets {
  private readonly registered = new Map<string, ImportTarget>();
  private readonly fallback: (entityKey: string) => Promise<ImportTarget>;

  /** `fallback` answers for keys no module registered: the custom record types. */
  constructor(fallback: (entityKey: string) => Promise<ImportTarget>) {
    this.fallback = fallback;
  }

  register(target: ImportTarget): void {
    if (this.registered.has(target.key)) {
      throw new Error(`Import target registered twice: ${target.key}`);
    }
    this.registered.set(target.key, target);
  }

  /** The target for `entityKey`; 404 when nothing can be imported under that key. */
  async resolve(entityKey: string): Promise<ImportTarget> {
    return this.registered.get(entityKey) ?? this.fallback(entityKey);
  }
}

/** The target of one published custom record type, built from its definition each time. */
export async function customRecordTarget(
  deps: { records: RecordService; entities: EntityDefinitionService },
  entityKey: string,
): Promise<ImportTarget> {
  // `published` is a 404 for a key that is unknown or not yet published.
  const entity = await deps.entities.published(entityKey);
  if (entity.kind !== 'custom') throw new NotFoundError();
  const repository = deps.records.repository(entityKey);
  return {
    key: entityKey,
    label: entity.name.en ?? entityKey,
    createPermission: `custom.${entityKey}.create`,
    fields: () =>
      Promise.resolve(
        entity.fields
          .filter((field) => field.status !== 'retired')
          .map((field) => ({
            key: field.key,
            label: field.label.en ?? field.key,
            required: field.required,
          })),
      ),
    validate: async (values) => {
      const issues = await deps.entities.validate(entityKey, values);
      return issues.map((issue) => ({
        path: issue.path,
        code: issue.code,
        message: issue.message,
      }));
    },
    create: async (values, companyId) => {
      const row = await repository.create({ companyId, data: values });
      return row.id;
    },
    remove: async (id, reason) => {
      const row = await repository.get(id);
      await repository.softDelete(id, row.version, reason);
    },
  };
}
