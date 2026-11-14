/**
 * Unit of work: one database transaction that carries the row-level security context.
 *
 * Purpose: this is the only way module code reaches the database. `run()` opens a
 * transaction, tells PostgreSQL who is calling (tenant, companies, user), and only then
 * runs the module's code. The RLS policies of every table read those settings, so tenant
 * and company isolation is enforced by the database for every statement, including ones a
 * module forgot to filter (SPEC 2.7).
 *
 * How the context is set, and why this way:
 *   1. `set_config(name, value, true)` is the function form of `SET LOCAL`: the value lasts
 *      until the transaction ends. Connections come from a shared pool, so a session-level
 *      SET would leak one tenant's context into the next request on that connection.
 *   2. All four settings are written on every transaction, as '' when absent. The SQL
 *      helpers (app.current_tenant_id() ...) read '' as NULL, so a missing value means
 *      "no rows", never "the previous value".
 *   3. Values are sent as bind parameters and must be UUIDs. The company list is sent as
 *      an array literal `{a,b}`, so each id is checked first: a value containing a comma
 *      could otherwise smuggle in another company.
 *
 * Everything inside `run()` commits together or, if anything throws, rolls back together.
 * A nested `run()` joins the transaction already open.
 *
 * Depends on: ./prisma.ts, ../context/request-context.ts, ../http/errors.ts.
 * Used by: kernel/db/repository.ts, kernel/http/crud-router.ts, every module service, jobs.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentContext } from '../context/request-context.js';
import { UnauthenticatedError } from '../http/errors.js';
import type { Db, PrismaDb } from './prisma.js';

/** Who the database should treat the transaction as. */
export interface DbContext {
  readonly tenantId: string;
  /** Companies the transaction may read and write; empty means tenant-level tables only. */
  readonly companyIds: readonly string[];
  /** Absent for system jobs and API clients. */
  readonly userId?: string;
  /** The real user while impersonating (kept for the audit trail). */
  readonly impersonatorId?: string;
}

export interface Unit {
  readonly db: Db;
  readonly context: DbContext;
}

export interface UnitOfWorkOptions {
  /** How long to wait for a free connection before failing (ms). */
  maxWaitMs?: number;
  /** Longest a transaction may stay open before it is rolled back (ms). */
  timeoutMs?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const unitStorage = new AsyncLocalStorage<Unit>();

/** The unit of work the current code runs in; throws outside one (a programming error). */
export function currentUnit(): Unit {
  const unit = unitStorage.getStore();
  if (unit === undefined) {
    throw new Error('No unit of work: database access must happen inside UnitOfWork.run()');
  }
  return unit;
}

function assertUuid(name: string, value: string): void {
  if (!UUID.test(value)) throw new Error(`Database context: ${name} is not a UUID`);
}

/** Checks every id; throws rather than send anything doubtful to the database. */
export function validateDbContext(ctx: DbContext): void {
  assertUuid('tenantId', ctx.tenantId);
  for (const id of ctx.companyIds) assertUuid('companyIds', id);
  if (ctx.userId !== undefined) assertUuid('userId', ctx.userId);
  if (ctx.impersonatorId !== undefined) assertUuid('impersonatorId', ctx.impersonatorId);
}

/**
 * Builds the database context from the authenticated request. No principal means the
 * request is anonymous: it gets 401, never a transaction without a tenant.
 */
export function dbContextFromRequest(): DbContext {
  const principal = currentContext()?.principal;
  if (principal === undefined) throw new UnauthenticatedError();
  const companyIds = currentContext()?.companyIds ?? [];
  if (principal.kind === 'user') {
    return {
      tenantId: principal.tenantId,
      companyIds,
      userId: principal.userId,
      ...(principal.impersonatorId === undefined
        ? {}
        : { impersonatorId: principal.impersonatorId }),
    };
  }
  return { tenantId: principal.tenantId, companyIds };
}

function sameContext(a: DbContext, b: DbContext): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.userId === b.userId &&
    a.impersonatorId === b.impersonatorId &&
    a.companyIds.length === b.companyIds.length &&
    a.companyIds.every((id) => b.companyIds.includes(id))
  );
}

export class UnitOfWork {
  private readonly prisma: PrismaDb;
  private readonly maxWaitMs: number;
  private readonly timeoutMs: number;

  constructor(prisma: PrismaDb, options: UnitOfWorkOptions = {}) {
    this.prisma = prisma;
    this.maxWaitMs = options.maxWaitMs ?? 5_000;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** Runs `fn` in a transaction as the caller of the current HTTP request. */
  run<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const open = unitStorage.getStore();
    // Already inside a unit of work for this request: join it.
    if (open !== undefined) return fn(open.db);
    return this.begin(dbContextFromRequest(), fn);
  }

  /**
   * Runs `fn` in a transaction with an explicit context. For background jobs and start-up
   * tasks, which have no HTTP request. Inside an open unit of work the context must be the
   * same: one transaction cannot serve two tenants.
   */
  runAs<T>(context: DbContext, fn: (db: Db) => Promise<T>): Promise<T> {
    const open = unitStorage.getStore();
    if (open !== undefined) {
      if (!sameContext(open.context, context)) {
        throw new Error('A unit of work is already open with a different database context');
      }
      return fn(open.db);
    }
    return this.begin(context, fn);
  }

  private begin<T>(context: DbContext, fn: (db: Db) => Promise<T>): Promise<T> {
    validateDbContext(context);
    const companies = `{${context.companyIds.join(',')}}`;
    return this.prisma.$transaction(
      async (tx) => {
        // First statement of the transaction: nothing can run before the context exists.
        await tx.$queryRaw`
          SELECT set_config('app.tenant_id', ${context.tenantId}, true),
                 set_config('app.company_ids', ${companies}, true),
                 set_config('app.user_id', ${context.userId ?? ''}, true),
                 set_config('app.impersonator_id', ${context.impersonatorId ?? ''}, true)`;
        const db: Db = tx;
        return unitStorage.run({ db, context }, () => fn(db));
      },
      { maxWait: this.maxWaitMs, timeout: this.timeoutMs },
    );
  }
}
