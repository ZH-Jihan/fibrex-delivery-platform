/**
 * Custom record service (PLAN 3.7 `custom_record`, `record_link`; SPEC 2.10 entity builder):
 * the records of the record types an administrator defined, and relations from them.
 *
 * What it gives other code:
 *   - `repository(key)`: the repository of one record type, which the generic CRUD router
 *     drives. It adds the rules below to the plain versioned repository,
 *   - `binRepository()`: every custom record of the company, for the recycle bin,
 *   - `links`, `addLink`, `removeLink`: relations from a record to any other record,
 *   - `exists(entityType, id, companyId)`: whether a record of any type exists.
 *
 * Rules, and why:
 *   1. Only a published custom record type has records. A draft, deleted or built-in type
 *      answers 404, as does a record of another type asked for under this type's path.
 *   2. Data is checked against the published definition before anything is written
 *      (`EntityDefinitionService.assertValid`: structure, limits, lookup codes), and stored
 *      without its not-filled-in properties.
 *   3. A value that points at a party, a file or another record must point at one that
 *      exists and that the caller can see. A value the record already holds is not checked
 *      again: deleting the target must not make the record impossible to save.
 *   4. A retired field keeps its stored value but cannot be given a new one.
 *   5. The number comes from the numbering service, in the same transaction as the insert,
 *      so a failed save gives the number back (no gaps). It is never sent by the client and
 *      never changes.
 *   6. `definition_version` is the version the data was last checked against.
 *   7. The company comes from the session (or the request, when the session has several)
 *      and never changes; branch and party must belong to that company (foreign keys).
 *   8. `state_code` is never sent by the client. A new record starts in the initial state
 *      of its type's state machine (none: no state); afterwards only the state service
 *      changes it (`stateTarget`), so every change is checked and lands in the history.
 *
 * Audit and soft delete are not written here: the database trigger logs every change of
 * `cfg.custom_record`, and deletes go through the repository's soft delete.
 *
 * Depends on: @fibrex/shared entities and records, kernel/db, kernel/entities,
 * kernel/numbering, kernel/http/errors.ts.
 * Used by: ./record-router.ts, src/main.ts (recycle bin), later import (2.8) and reports.
 */
import {
  buildDataFilter,
  entityKeyPattern,
  isAbsent,
  mergeRecordData,
  stripAbsent,
  type RecordCreate,
  type RecordIssue,
  type RecordLinkCreate,
  type RecordUpdate,
} from '@fibrex/shared';
import { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../db/prisma.js';
import { createRepository, MAX_PAGE_SIZE, type Repository } from '../db/repository.js';
import { currentUnit } from '../db/unit-of-work.js';
import type {
  EntityDefinitionService,
  PublishedEntity,
} from '../entities/entity-definition-service.js';
import { BadRequestError, ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import type { NumberingService } from '../numbering/numbering-service.js';
import type { StateService, StateTarget } from '../states/state-service.js';

export type CustomRecordRow = NonNullable<Awaited<ReturnType<Db['customRecord']['findFirst']>>>;
export type RecordLinkRow = NonNullable<Awaited<ReturnType<Db['recordLink']['findFirst']>>>;

/** Entity types of the built-in targets a field can point at. */
export const PARTY_ENTITY_TYPE = 'party.party';
export const FILE_ENTITY_TYPE = 'files.file_object';

export interface RecordServiceDeps {
  entities: EntityDefinitionService;
  numbering: NumberingService;
  /**
   * Whether a record of a built-in type (`party.party`, `files.file_object`, ...) exists and
   * is visible to the caller. Answered by the owning module, wired in `main.ts`, so the
   * kernel never reads a module's tables. `undefined` means no module answers for the type.
   */
  referenceExists: (entityType: string, id: string) => Promise<boolean | undefined>;
  /**
   * State machines (row 2.10): the state a new record of a type starts in, and the first
   * row of its state history. Left out where no state machines are wired (records then
   * have no state).
   */
  states?: Pick<StateService, 'initialCode' | 'recordStart'>;
}

/** The list filters of one record type, as the router hands them over. */
export interface RecordListFilter {
  id?: string;
  number?: string;
  partyId?: string;
  branchId?: string;
  stateCode?: string;
  /** Field filters, `fieldKey -> value` as written in the query string. */
  fields?: Record<string, unknown>;
}

const LIVE = { deletedAt: null };
const DELETED = { deletedAt: { not: null } };

export class RecordService {
  private readonly deps: RecordServiceDeps;
  private readonly rows = createRepository<CustomRecordRow>({
    model: 'customRecord',
    scope: 'company',
  });
  private readonly linkRows = createRepository<RecordLinkRow>({
    model: 'recordLink',
    scope: 'company',
  });

  constructor(deps: RecordServiceDeps) {
    this.deps = deps;
  }

  /** Rule 1: the published custom record type `key`, or 404. */
  private async customEntity(key: string): Promise<PublishedEntity> {
    const entity = await this.deps.entities.published(key);
    if (entity.kind !== 'custom') throw new NotFoundError();
    return entity;
  }

  /** Rule 1: the record `id`, provided it is of this type and in the wanted state. */
  private async ofType(
    entity: PublishedEntity,
    id: string,
    state: Record<string, unknown> = LIVE,
  ): Promise<CustomRecordRow> {
    const row = await currentUnit().db.customRecord.findFirst({
      where: { id, entityDefinitionId: entity.id, ...state },
    });
    if (row === null) throw new NotFoundError();
    return row;
  }

  /** Rule 7: the company of a new record. */
  private companyFor(requested: string | undefined): string {
    const { context } = currentUnit();
    const companyId =
      requested ?? (context.companyIds.length === 1 ? context.companyIds[0] : undefined);
    if (companyId === undefined) {
      throw new BadRequestError('company_required', 'State which company this belongs to.');
    }
    if (!context.companyIds.includes(companyId)) {
      throw new ForbiddenError('You do not have access to this company');
    }
    return companyId;
  }

  /**
   * Whether a live record `id` of type `entityType` exists. A custom type is looked up
   * here, in the given company; a built-in type (a key with a dot) is asked of its module.
   */
  async exists(entityType: string, id: string, companyId: string): Promise<boolean> {
    if (!entityKeyPattern.test(entityType)) {
      return (await this.deps.referenceExists(entityType, id)) === true;
    }
    const row = await currentUnit().db.customRecord.findFirst({
      where: { id, companyId, entity: { key: entityType, kind: 'custom', deletedAt: null } },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * Rules 3 and 4, after the schema check has passed. `previous` is the stored data (empty
   * for a new record); only values that differ from it are checked.
   */
  private async checkValues(
    entity: PublishedEntity,
    data: Record<string, unknown>,
    previous: Record<string, unknown>,
    companyId: string,
  ): Promise<void> {
    const issues: RecordIssue[] = [];
    for (const [key, property] of Object.entries(entity.jsonSchema.properties)) {
      const value = data[key];
      const before = previous[key];
      const changed = JSON.stringify(value ?? null) !== JSON.stringify(before ?? null);
      if (!changed) continue;
      // Rule 4. Clearing a retired field is a change too: its value is history.
      if (property['x-retired'] === true) {
        issues.push({
          path: key,
          code: 'retired_field',
          message: 'This field is no longer in use and cannot be changed.',
        });
        continue;
      }
      const ref = property['x-ref'];
      if (ref === undefined || isAbsent(value) || typeof value !== 'string') continue;
      // Rule 3.
      const targetType =
        ref === 'party'
          ? PARTY_ENTITY_TYPE
          : ref === 'file'
            ? FILE_ENTITY_TYPE
            : (property['x-ref-entity'] ?? '');
      if (!(await this.exists(targetType, value, companyId))) {
        issues.push({
          path: key,
          code: 'unknown_reference',
          message: 'This does not exist, or you cannot see it.',
        });
      }
    }
    if (issues.length > 0) throw new ValidationError(issues);
  }

  /**
   * One page of a type's records, newest first.
   *
   * Field filters run as one containment test (`data @> ...`), the operator the GIN index
   * on `data` serves. Prisma cannot express it, so the matching ids are found with a
   * parameterised query and the rows are then read through Prisma as usual. Both queries
   * run under the row-level security context of the unit of work, like any other.
   */
  private async list(
    key: string,
    options: Parameters<Repository<CustomRecordRow>['list']>[0],
  ): Promise<Awaited<ReturnType<Repository<CustomRecordRow>['list']>>> {
    const entity = await this.customEntity(key);
    const { db } = currentUnit();
    const filter = (options.where ?? {}) as RecordListFilter;
    const deleted = options.deleted === true;
    const pageSize = Math.min(Math.max(1, options.pageSize), MAX_PAGE_SIZE);
    const page = Math.max(1, options.page);

    const conditions: Prisma.Sql[] = [
      Prisma.sql`entity_definition_id = ${entity.id}::uuid`,
      deleted ? Prisma.sql`deleted_at IS NOT NULL` : Prisma.sql`deleted_at IS NULL`,
    ];
    if (filter.id !== undefined) conditions.push(Prisma.sql`id = ${filter.id}::uuid`);
    if (filter.number !== undefined) conditions.push(Prisma.sql`number = ${filter.number}`);
    if (filter.partyId !== undefined) {
      conditions.push(Prisma.sql`party_id = ${filter.partyId}::uuid`);
    }
    if (filter.branchId !== undefined) {
      conditions.push(Prisma.sql`branch_id = ${filter.branchId}::uuid`);
    }
    if (filter.stateCode !== undefined) {
      conditions.push(Prisma.sql`state_code = ${filter.stateCode}`);
    }
    if (filter.fields !== undefined && Object.keys(filter.fields).length > 0) {
      const built = buildDataFilter(entity.jsonSchema, filter.fields);
      if (!built.ok) throw new ValidationError(built.issues);
      conditions.push(Prisma.sql`data @> ${JSON.stringify(built.contains)}::jsonb`);
    }
    const where = Prisma.join(conditions, ' AND ');

    // Ids are UUID v7 (time-ordered), so id descending is "newest first" and stable.
    const found = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM cfg.custom_record
      WHERE ${where}
      ORDER BY id DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
    const counted = await db.$queryRaw<{ total: bigint }[]>`
      SELECT count(*) AS total FROM cfg.custom_record WHERE ${where}`;
    const ids = found.map((row) => row.id);
    const rows =
      ids.length === 0
        ? []
        : await db.customRecord.findMany({
            where: { id: { in: ids }, ...(deleted ? DELETED : LIVE) },
          });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return {
      items: ids.flatMap((id) => byId.get(id) ?? []),
      total: Number(counted[0]?.total ?? 0n),
      page,
      pageSize,
    };
  }

  /** The repository of the record type `key` (rules 1 to 7 on top of the plain one). */
  repository(key: string): Repository<CustomRecordRow> {
    const { entities, numbering } = this.deps;
    return {
      list: (options) => this.list(key, options),

      get: async (id) => this.ofType(await this.customEntity(key), id),

      create: async (input) => {
        const body = input as RecordCreate;
        const entity = await this.customEntity(key);
        const companyId = this.companyFor(body.companyId);
        // Step 1: the data must be valid before a number is taken or a row written.
        const data = stripAbsent(body.data);
        await entities.assertValid(key, data);
        await this.checkValues(entity, data, {}, companyId);
        // Step 2: the number (rule 5). The sequence row stays locked until this transaction
        // ends, so two saves cannot get the same number and a rollback returns it.
        const number =
          entity.numberingKey === null
            ? null
            : (
                await numbering.allocate(entity.numberingKey, {
                  companyId,
                  // First record of the company: the sequence is created with a plain
                  // pattern (e.g. VEH-00001) that an administrator can change afterwards.
                  defaults: {
                    format: '{prefix}{00000}',
                    prefix: `${key.slice(0, 3).toUpperCase()}-`,
                  },
                })
              ).number;
        // Step 3: the first state, when the type has a state machine (rule 8).
        const stateCode = (await this.deps.states?.initialCode(key)) ?? null;
        // Step 4: the row. A branch or party of another company fails its foreign key and
        // comes back as 409 reference_conflict.
        const row = await this.rows.create({
          companyId,
          branchId: body.branchId ?? null,
          partyId: body.partyId ?? null,
          entityDefinitionId: entity.id,
          definitionVersion: entity.version,
          number,
          data,
          stateCode,
        });
        // Step 5: the state history starts with the record, in the same transaction.
        if (stateCode !== null) {
          await this.deps.states?.recordStart(key, row.id, companyId, stateCode);
        }
        return row;
      },

      update: async (id, expectedVersion, changes) => {
        const body = changes as RecordUpdate;
        const entity = await this.customEntity(key);
        const current = await this.ofType(entity, id);
        const next: Record<string, unknown> = {};
        if (body.data !== undefined) {
          // The sent fields are merged into the stored ones and the whole result is checked,
          // so a record always satisfies the definition it was last saved under (rule 6).
          const previous = current.data as Record<string, unknown>;
          const merged = mergeRecordData(previous, body.data);
          await entities.assertValid(key, merged, { previous });
          await this.checkValues(entity, merged, previous, current.companyId);
          next.data = merged;
          next.definitionVersion = entity.version;
        }
        if (body.branchId !== undefined) next.branchId = body.branchId;
        if (body.partyId !== undefined) next.partyId = body.partyId;
        // The version check is the write itself (one statement), in the plain repository.
        return this.rows.update(id, expectedVersion, next);
      },

      softDelete: async (id, expectedVersion, reason) => {
        await this.ofType(await this.customEntity(key), id);
        return this.rows.softDelete(id, expectedVersion, reason);
      },

      restore: async (id, expectedVersion) => {
        await this.ofType(await this.customEntity(key), id, DELETED);
        return this.rows.restore(id, expectedVersion);
      },
    };
  }

  /**
   * How the state service reads a record of type `key` and stores its state (rule 8). The
   * version read with the record is the version the write expects, so a record changed in
   * between is a 409 and never a silent overwrite.
   */
  stateTarget(key: string): StateTarget {
    return {
      load: async (id) => {
        const row = await this.ofType(await this.customEntity(key), id);
        return {
          id: row.id,
          companyId: row.companyId,
          stateCode: row.stateCode,
          version: row.version,
          fields: row.data as Record<string, unknown>,
          readPermission: `custom.${key}.read`,
          updatePermission: `custom.${key}.update`,
        };
      },
      setState: async (subject, toCode) => {
        await this.rows.update(subject.id, subject.version, { stateCode: toCode });
      },
    };
  }

  /** Every custom record the caller can see, whatever its type: for the recycle bin. */
  binRepository(): Repository<CustomRecordRow> {
    return this.rows;
  }

  /** The live relations of a record, in both directions, oldest first. */
  async links(key: string, id: string): Promise<RecordLinkRow[]> {
    await this.ofType(await this.customEntity(key), id);
    return currentUnit().db.recordLink.findMany({
      where: {
        OR: [
          { fromEntityType: key, fromId: id },
          { toEntityType: key, toId: id },
        ],
      },
      orderBy: [{ id: 'asc' }],
    });
  }

  /**
   * Relates the record to another one. The link belongs to the record's company and the
   * target must exist (rule 3). The same relation twice is a 409 (unique index).
   */
  async addLink(key: string, id: string, input: RecordLinkCreate): Promise<RecordLinkRow> {
    const record = await this.ofType(await this.customEntity(key), id);
    if (input.toEntityType === key && input.toId === id) {
      throw new ValidationError([
        { path: 'toId', code: 'self_link', message: 'A record cannot be related to itself.' },
      ]);
    }
    if (!(await this.exists(input.toEntityType, input.toId, record.companyId))) {
      throw new ValidationError([
        {
          path: 'toId',
          code: 'unknown_reference',
          message: 'This does not exist, or you cannot see it.',
        },
      ]);
    }
    return this.linkRows.create({
      companyId: record.companyId,
      fromEntityType: key,
      fromId: id,
      toEntityType: input.toEntityType,
      toId: input.toId,
      relationKey: input.relationKey,
    });
  }

  /** Removes (soft-deletes) a relation that starts or ends at the record. */
  async removeLink(
    key: string,
    id: string,
    linkId: string,
    expectedVersion: number,
    reason: string,
  ): Promise<void> {
    await this.ofType(await this.customEntity(key), id);
    const link = await this.linkRows.get(linkId);
    const touches =
      (link.fromEntityType === key && link.fromId === id) ||
      (link.toEntityType === key && link.toId === id);
    if (!touches) throw new NotFoundError();
    await this.linkRows.softDelete(linkId, expectedVersion, reason);
  }
}
