/**
 * Retention: policies say how long a kind of record is kept; runs record what was done.
 *
 * Purpose: PLAN 3.7 `retention_policy` and `retention_run` (SPEC 2.12, data protection).
 * This service owns the rules about what retention may touch and the job that works
 * through every tenant's active policies.
 *
 * Safety rules (recorded in docs/DECISIONS.md):
 *   1. DRY-RUN BY DEFAULT. Every run is a dry run unless the caller passes `allowLive`,
 *      the policy itself is in `live` mode, and a module has registered a target for the
 *      entity type. The scheduled job never passes `allowLive`, so it only counts.
 *   2. NEVER AUDIT, LEDGER, JOURNAL OR PAYROLL DATA. `isProtectedEntityKey` names them; the
 *      database refuses such a policy (CHECK `retention_policy_protected_ck`), the API
 *      refuses it with a clear message, and this service checks again before every run.
 *   3. NEVER A HARD DELETE. A target can only archive or anonymise (the target contract has
 *      no delete), and the application database role has no DELETE grant at all.
 *   4. A dry run writes one insert-only `retention_run` row and changes no other data.
 *
 * Depends on: kernel/db (Unit of work, Prisma types), kernel/observability/logger.
 * Used by: ./retention-router.ts, src/main.ts (job `retention-dry-run`), the recycle bin.
 */
import type { Db, PrismaDb } from '../db/prisma.js';
import { currentUnit, type UnitOfWork } from '../db/unit-of-work.js';
import { NotFoundError } from '../http/errors.js';
import type { Logger } from '../observability/logger.js';

export type RetentionPolicyRow = NonNullable<
  Awaited<ReturnType<Db['retentionPolicy']['findFirst']>>
>;
export type RetentionRunRow = NonNullable<Awaited<ReturnType<Db['retentionRun']['findFirst']>>>;

/**
 * Data that retention may never touch: audit, ledger (gl), journal and payroll, as a whole
 * segment of the entity key (`gl.account`, `payroll_run`, `audit.change`, `journal_line`).
 * The same expression is the database CHECK on `cfg.retention_policy.entity_key`.
 */
const PROTECTED = /(^|[._])(audit|gl|ledger|journal|payroll)([._]|$)/;

export function isProtectedEntityKey(entityKey: string): boolean {
  return PROTECTED.test(entityKey);
}

/** What a module offers so that retention can count and (later) act on its records. */
export interface RetentionTarget {
  entityKey: string;
  /** How many live rows are older than `cutoff` (a dry run only counts). */
  countEligible(cutoff: Date): Promise<number>;
  /**
   * Archives or anonymises the rows older than `cutoff`; returns how many it changed. By
   * contract it never deletes a row. Called only for a live policy with `allowLive`.
   */
  apply(cutoff: Date, action: 'archive' | 'anonymise'): Promise<{ rowsAffected: number }>;
}

export class RetentionTargets {
  readonly #targets = new Map<string, RetentionTarget>();

  register(target: RetentionTarget): void {
    if (isProtectedEntityKey(target.entityKey)) {
      throw new Error(`Retention may never target protected data: ${target.entityKey}`);
    }
    if (this.#targets.has(target.entityKey)) {
      throw new Error(`Retention target registered twice: ${target.entityKey}`);
    }
    this.#targets.set(target.entityKey, target);
  }

  get(entityKey: string): RetentionTarget | undefined {
    return this.#targets.get(entityKey);
  }
}

export interface RetentionRunOptions {
  /** Defaults to true. false is honoured only when `allowLive` is also true. */
  dryRun?: boolean;
  allowLive?: boolean;
}

export interface RetentionServiceDeps {
  targets: RetentionTargets;
  logger?: Logger;
  now?: () => Date;
}

export class RetentionService {
  readonly #deps: RetentionServiceDeps;

  constructor(deps: RetentionServiceDeps) {
    this.#deps = deps;
  }

  /** The oldest date a record may have and still be kept. */
  cutoff(keepMonths: number): Date {
    const now = (this.#deps.now ?? (() => new Date()))();
    const cutoff = new Date(now);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - keepMonths);
    return cutoff;
  }

  /** True when a module could carry out a live run for this entity type. */
  hasTarget(entityKey: string): boolean {
    return this.#deps.targets.get(entityKey) !== undefined;
  }

  /** Runs one policy in the caller's unit of work and records the run. */
  async runPolicy(
    policy: RetentionPolicyRow,
    options: RetentionRunOptions = {},
  ): Promise<RetentionRunRow> {
    const { db, context } = currentUnit();
    const record = (data: {
      dryRun: boolean;
      status: 'completed' | 'skipped' | 'failed';
      rowsAffected?: number;
      note: string;
    }) =>
      db.retentionRun.create({
        data: { tenantId: context.tenantId, policyId: policy.id, ...data },
      });

    // Step 1: protected data is refused even if a row somehow got past the database check.
    if (isProtectedEntityKey(policy.entityKey)) {
      return record({
        dryRun: true,
        status: 'skipped',
        note: 'Protected data (audit, ledger, journal, payroll) is never subject to retention.',
      });
    }
    const target = this.#deps.targets.get(policy.entityKey);
    if (target === undefined) {
      return record({
        dryRun: true,
        status: 'skipped',
        note: 'No module has registered this record type for retention; nothing was counted.',
      });
    }
    const cutoff = this.cutoff(policy.keepMonths);

    // Step 2: a live run needs all three: the caller allows it, the policy is live, and the
    // caller did not ask for a dry run. Anything else counts only.
    const live = options.dryRun === false && options.allowLive === true && policy.mode === 'live';
    if (!live) {
      const eligible = await target.countEligible(cutoff);
      return record({
        dryRun: true,
        status: 'completed',
        note: `Dry run: ${String(eligible)} record(s) older than ${cutoff.toISOString().slice(0, 10)} would be ${policy.action === 'archive' ? 'archived' : 'anonymised'}. Nothing was changed.`,
      });
    }

    // Step 3: live run. The target archives or anonymises; it has no way to delete.
    const { rowsAffected } = await target.apply(cutoff, policy.action as 'archive' | 'anonymise');
    return record({
      dryRun: false,
      status: 'completed',
      rowsAffected,
      note: `${String(rowsAffected)} record(s) older than ${cutoff.toISOString().slice(0, 10)} were ${policy.action === 'archive' ? 'archived' : 'anonymised'}.`,
    });
  }

  /** An administrator's "count now": one policy, always a dry run. */
  async dryRunById(id: string): Promise<RetentionRunRow> {
    const { db } = currentUnit();
    const policy = await db.retentionPolicy.findFirst({ where: { id, deletedAt: null } });
    if (policy === null) throw new NotFoundError('Retention policy not found');
    return this.runPolicy(policy, { dryRun: true });
  }

  /**
   * The scheduled job: finds the tenants with an active policy through
   * `cfg.retention_due_tenants()`, then works each tenant's policies in its own unit of
   * work under row-level security. Dry run unless `allowLive` is passed (main.ts does not).
   */
  async sweep(
    prisma: PrismaDb,
    uow: UnitOfWork,
    options: { allowLive?: boolean } = {},
  ): Promise<{ runs: number }> {
    const tenants = await prisma.$queryRaw<{ tenant_id: string }[]>`
      SELECT tenant_id::text AS tenant_id FROM cfg.retention_due_tenants()`;
    let runs = 0;
    for (const tenant of tenants) {
      try {
        runs += await uow.runAs({ tenantId: tenant.tenant_id, companyIds: [] }, async (db) => {
          const policies = await db.retentionPolicy.findMany({
            where: { active: true, deletedAt: null },
            orderBy: { entityKey: 'asc' },
          });
          for (const policy of policies) {
            await this.runPolicy(policy, { dryRun: policy.mode !== 'live', ...options });
          }
          return policies.length;
        });
      } catch (err) {
        // One tenant's failure must not stop the others.
        this.#deps.logger?.error({ err, tenantId: tenant.tenant_id }, 'retention run failed');
      }
    }
    return { runs };
  }
}
