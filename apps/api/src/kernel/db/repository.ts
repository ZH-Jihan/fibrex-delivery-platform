/**
 * Generic repository for mutable business tables.
 *
 * Purpose: the one place that knows how a standard row is listed, created, updated,
 * soft-deleted and restored, so every module does it the same way and none can skip the
 * rules:
 *   - it only works inside a unit of work, so the row-level security context is always set;
 *   - tenant and company of a new row come from that context, never from the client;
 *   - system columns (id, tenant, audit stamps, version, soft-delete columns) cannot be
 *     written by callers; the database triggers own them;
 *   - every change of an existing row is `UPDATE ... WHERE id = ? AND version = ?`
 *     (optimistic locking); a stale version raises VersionConflictError (409 with a diff);
 *   - delete means soft delete; restore brings the row back.
 *
 * A row the caller may not see (another tenant or company, hidden by RLS) is
 * indistinguishable from a row that does not exist: both give 404, so ids cannot be probed.
 *
 * Depends on: ./unit-of-work.ts, ./optimistic-lock.ts, ../http/errors.ts, generated Prisma.
 * Used by: kernel/http/crud-router.ts and module services.
 */
import { Prisma } from '../../generated/prisma/client.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../http/errors.js';
import { VersionConflictError, diffChanges } from './optimistic-lock.js';
import { currentUnit } from './unit-of-work.js';

/** Columns every mutable table has (docs/PLAN.md table kinds S and T). */
export interface BaseRow {
  id: string;
  version: number;
  deletedAt: Date | null;
}

/** Client property name of a model, for example 'branch' for model Branch. */
export type ModelKey = Uncapitalize<Prisma.ModelName>;

export interface RepositoryConfig {
  model: ModelKey;
  /** 'company': rows carry company_id. 'tenant': rows belong to the whole tenant. */
  scope: 'company' | 'tenant';
}

export interface ListOptions {
  where?: Record<string, unknown>;
  orderBy?: Record<string, 'asc' | 'desc'>[];
  page: number;
  pageSize: number;
  /** true lists the recycle bin (soft-deleted rows) instead of live rows. */
  deleted?: boolean;
}

export interface Page<TRow> {
  items: TRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Repository<TRow extends BaseRow> {
  list(options: ListOptions): Promise<Page<TRow>>;
  /** Throws NotFoundError when the row is missing, deleted or not visible to the caller. */
  get(id: string): Promise<TRow>;
  create(data: Record<string, unknown>): Promise<TRow>;
  update(id: string, expectedVersion: number, changes: Record<string, unknown>): Promise<TRow>;
  softDelete(id: string, expectedVersion: number, reason?: string): Promise<TRow>;
  restore(id: string, expectedVersion: number): Promise<TRow>;
}

/** Columns only the database and this repository may write. */
const SYSTEM_FIELDS = [
  'id',
  'tenantId',
  'companyId',
  'createdAt',
  'createdBy',
  'updatedAt',
  'updatedBy',
  'version',
  'deletedAt',
  'deletedBy',
  'deleteReason',
] as const;

export const MAX_PAGE_SIZE = 200;

/** The few delegate methods the repository uses, typed loosely once, here. */
interface Delegate {
  findMany(args: {
    where: Record<string, unknown>;
    orderBy: Record<string, 'asc' | 'desc'>[];
    skip: number;
    take: number;
  }): Promise<unknown[]>;
  findFirst(args: { where: Record<string, unknown> }): Promise<unknown>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  updateManyAndReturn(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<unknown[]>;
}

function withoutSystemFields(data: Record<string, unknown>): Record<string, unknown> {
  const system: readonly string[] = SYSTEM_FIELDS;
  return Object.fromEntries(
    Object.entries(data).filter(([key, value]) => value !== undefined && !system.includes(key)),
  );
}

/** Names of the columns in a unique-constraint error, when the driver reports them. */
function uniqueFields(err: Prisma.PrismaClientKnownRequestError): string[] {
  const meta = err.meta as
    | { target?: unknown; driverAdapterError?: { cause?: { constraint?: { fields?: unknown } } } }
    | undefined;
  const fields = meta?.driverAdapterError?.cause?.constraint?.fields ?? meta?.target;
  return Array.isArray(fields) ? fields.map(String) : [];
}

/**
 * Turns the database errors a user can cause into the matching API error. Anything else
 * is rethrown unchanged and becomes a logged 500.
 */
export function mapDbError(err: unknown): unknown {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return err;
  switch (err.code) {
    case 'P2002':
      return new ConflictError('unique_conflict', 'Another record already uses this value.', {
        fields: uniqueFields(err),
      });
    case 'P2003':
      return new ConflictError(
        'reference_conflict',
        'The record refers to something that does not exist or is not available.',
      );
    case 'P2025':
      return new NotFoundError();
    default:
      return err;
  }
}

export function createRepository<TRow extends BaseRow>(config: RepositoryConfig): Repository<TRow> {
  const delegate = (): Delegate =>
    (currentUnit().db as unknown as Record<ModelKey, Delegate>)[config.model];

  async function guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      throw mapDbError(err);
    }
  }

  /**
   * A versioned write matched no row. Work out why:
   *   - no row in the expected state (missing, hidden by RLS, deleted/not deleted) -> 404
   *   - the row exists, so its version has moved on                                -> 409
   */
  async function explainMiss(
    id: string,
    expectedVersion: number,
    state: Record<string, unknown>,
    changes: Record<string, unknown>,
  ): Promise<never> {
    const current = (await delegate().findFirst({ where: { id, ...state } })) as
      (Record<string, unknown> & BaseRow) | null;
    if (current === null) throw new NotFoundError();
    throw new VersionConflictError(expectedVersion, current, diffChanges(changes, current));
  }

  const LIVE = { deletedAt: null };
  const DELETED = { deletedAt: { not: null } };

  return {
    list: (options) =>
      guarded(async () => {
        const pageSize = Math.min(Math.max(1, options.pageSize), MAX_PAGE_SIZE);
        const page = Math.max(1, options.page);
        const where = { ...options.where, ...(options.deleted === true ? DELETED : LIVE) };
        // Ids are UUID v7 (time-ordered), so id descending is "newest first" and stable.
        const orderBy = options.orderBy ?? [{ id: 'desc' as const }];
        // One after the other: both run on the transaction's single connection.
        const items = await delegate().findMany({
          where,
          orderBy,
          skip: (page - 1) * pageSize,
          take: pageSize,
        });
        const total = await delegate().count({ where });
        return { items: items as TRow[], total, page, pageSize };
      }),

    get: (id) =>
      guarded(async () => {
        const row = (await delegate().findFirst({ where: { id, ...LIVE } })) as TRow | null;
        if (row === null) throw new NotFoundError();
        return row;
      }),

    create: (data) =>
      guarded(async () => {
        const { context } = currentUnit();
        const row: Record<string, unknown> = {
          ...withoutSystemFields(data),
          tenantId: context.tenantId,
        };
        if (config.scope === 'company') {
          // The company is taken from the request when it names one, otherwise from the
          // session when that has exactly one. It must be a company the session may use;
          // the RLS WITH CHECK would refuse it anyway, this gives a clear 403 instead.
          const requested = typeof data.companyId === 'string' ? data.companyId : undefined;
          const companyId =
            requested ?? (context.companyIds.length === 1 ? context.companyIds[0] : undefined);
          if (companyId === undefined) {
            throw new BadRequestError('company_required', 'State which company this belongs to.');
          }
          if (!context.companyIds.includes(companyId)) {
            throw new ForbiddenError('You do not have access to this company');
          }
          row.companyId = companyId;
        }
        return (await delegate().create({ data: row })) as TRow;
      }),

    update: (id, expectedVersion, changes) =>
      guarded(async () => {
        const data = withoutSystemFields(changes);
        if (Object.keys(data).length === 0) {
          // Nothing to write: still honour the version check, but do not bump the version.
          const row = (await delegate().findFirst({ where: { id, ...LIVE } })) as TRow | null;
          if (row === null) throw new NotFoundError();
          if (row.version !== expectedVersion) {
            const current = row as unknown as Record<string, unknown> & BaseRow;
            throw new VersionConflictError(expectedVersion, current, []);
          }
          return row;
        }
        // One statement checks the version and writes: no gap for another writer to slip
        // into. The trigger sets version = version + 1 and the updated_* stamps.
        const rows = await delegate().updateManyAndReturn({
          where: { id, version: expectedVersion, ...LIVE },
          data,
        });
        if (rows.length === 0) return explainMiss(id, expectedVersion, LIVE, data);
        return rows[0] as TRow;
      }),

    softDelete: (id, expectedVersion, reason) =>
      guarded(async () => {
        const { context } = currentUnit();
        // The database refuses a deleted row without a reason (the *_soft_delete_ck
        // constraints). Checked here so the caller gets a clear 400, not a failed write.
        const deleteReason = reason?.trim() ?? '';
        if (deleteReason === '') {
          throw new ValidationError([
            { path: 'reason', code: 'required', message: 'Say why this is being deleted' },
          ]);
        }
        const rows = await delegate().updateManyAndReturn({
          where: { id, version: expectedVersion, ...LIVE },
          data: {
            deletedAt: new Date(),
            deletedBy: context.userId ?? null,
            deleteReason,
          },
        });
        if (rows.length === 0) return explainMiss(id, expectedVersion, LIVE, {});
        return rows[0] as TRow;
      }),

    restore: (id, expectedVersion) =>
      guarded(async () => {
        // A restore can collide with a live row that reused a unique value (for example
        // the same code) while this one was in the recycle bin: that surfaces as 409
        // unique_conflict through mapDbError.
        const rows = await delegate().updateManyAndReturn({
          where: { id, version: expectedVersion, ...DELETED },
          data: { deletedAt: null, deletedBy: null, deleteReason: null },
        });
        if (rows.length === 0) return explainMiss(id, expectedVersion, DELETED, {});
        return rows[0] as TRow;
      }),
  };
}
