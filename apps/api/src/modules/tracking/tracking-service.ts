/**
 * Tracking service (phase 4 row 4.7; SPEC 3.3): the call sheet's entries, and how a status
 * recorded on the sheet reaches the employee status state machine.
 *
 * Purpose: one place that writes `tracking.tracking_entry` and applies its status, used by
 * the routes (./tracking-router.ts) and by the recurring job that applies future-dated
 * changes (`applyDue`, registered in src/main.ts).
 *
 * How a recorded status is applied, step by step (`resolveStatus`), and why:
 *   1. The person must be a live employee: the status belongs to `people.employee`.
 *   2. Same status as now, taking effect today or earlier: nothing to move. The entry is
 *      kept as "unchanged" (the call confirmed the status).
 *   3. The move must exist in the employee machine from the current status, and the caller
 *      must hold its permission (the transition's own key or `people.employee.status`).
 *      Both are checked here for a future date as well, so an impossible change is refused
 *      while the caller is on the screen, not discovered by the job later.
 *   4. Effective today or earlier: the kernel state service moves the employee now (it checks
 *      the rules again, writes the dated history row and starts bound workflows, in this
 *      transaction). The entry stores the history row: "applied".
 *      Effective later: the entry is "pending"; the job applies it on that date.
 *   5. A newer status for the same person replaces any change still pending for them
 *      ("superseded"): the last instruction given wins, and nothing is applied twice.
 *   "Today" is the state service's own (the UTC date), so a change it would call future is
 *   never applied early; at worst a change made late in the Qatar evening waits for the job.
 *
 * The reason: the sheet's reason is a `status_reason` value. When the transition takes its
 * reasons from that list the id is passed on; otherwise (a machine edited by an administrator)
 * the reason's label goes into the history note, so the reason is never lost.
 *
 * The job (`applyDue`) runs every tenant: a SECURITY DEFINER function lists the (tenant,
 * company, user) groups with pending changes due; each change is applied in its own
 * transaction as the user who recorded it (request context rebuilt, as the import commit
 * does, row 3.14), so their permission is checked again and the audit rows name them. A
 * change that can no longer be made (someone moved the person meanwhile) is marked "failed"
 * with the reason and does not stop the others. Running it twice does nothing more.
 *
 * Depends on: @fibrex/shared, kernel/db, kernel/states, kernel/permissions, kernel/context,
 * kernel/http/errors, ../people (EMPLOYEE_ENTITY), ../performance (qatarToday).
 * Used by: ./tracking-router.ts, ./index.ts, src/main.ts.
 */
import {
  TRACKING_REASON_REQUIRED,
  type TrackingEntryCreateInput,
  type TrackingEntryUpdateInput,
  type TransitionRequest,
} from '@fibrex/shared';
import { randomUUID } from 'node:crypto';
import { runWithContext, type RequestContext } from '../../kernel/context/request-context.js';
import type { Db } from '../../kernel/db/prisma.js';
import { createRepository } from '../../kernel/db/repository.js';
import { currentUnit, type DbContext, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { ConflictError, UnprocessableError, ValidationError } from '../../kernel/http/errors.js';
import type { Logger } from '../../kernel/observability/logger.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import type { StateService } from '../../kernel/states/state-service.js';
import { EMPLOYEE_ENTITY } from '../people/index.js';
import { qatarToday } from '../performance/index.js';

export const ENTRY_VIEW = 'tracking.entry.view';
export const ENTRY_CREATE = 'tracking.entry.create';
export const ENTRY_UPDATE = 'tracking.entry.update';
export const CALL_CREATE = 'tracking.call.create';
export const STATUS_APPLY = 'tracking.status.apply';
/** The employee entity's own permission for a move whose transition names none. */
const EMPLOYEE_STATUS = 'people.employee.status';

export type EntryRow = NonNullable<Awaited<ReturnType<Db['trackingEntry']['findFirst']>>>;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDay = (text: string) => new Date(`${text}T00:00:00.000Z`);
/** The state service's "today" (UTC date). */
const utcToday = (now: Date) => isoDay(now);

/** The view of an entry the API returns. */
export function entryView(row: EntryRow) {
  return {
    id: row.id,
    partyId: row.partyId,
    businessDate: isoDay(row.businessDate),
    statusCode: row.statusCode,
    reasonId: row.reasonId,
    effectiveDate: row.effectiveDate === null ? null : isoDay(row.effectiveDate),
    statusState: row.statusState,
    statusAppliedAt: row.statusAppliedAt?.toISOString() ?? null,
    statusError: row.statusError,
    stateHistoryId: row.stateHistoryId,
    callOutcomeId: row.callOutcomeId,
    callerUserId: row.callerUserId,
    note: row.note,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export type EntryView = ReturnType<typeof entryView>;

/** The status columns of an entry after `resolveStatus`. */
interface StatusColumns {
  statusCode: string;
  reasonId: string | null;
  effectiveDate: Date;
  statusState: 'unchanged' | 'applied' | 'pending';
  stateHistoryId: string | null;
  statusAppliedAt: Date | null;
  statusError: null;
  statusSetBy: string | null;
}

export interface ApplyDueResult {
  groups: number;
  applied: number;
  failed: number;
}

export interface TrackingServiceDeps {
  uow: UnitOfWork;
  permissions: PermissionService;
  states: StateService;
  /** The job's client (outside any unit of work); only `applyDue` needs it. */
  prisma?: Pick<Db, '$queryRaw'>;
  logger?: Logger;
  /** The clock; tests pass their own. */
  now?: () => Date;
}

export class TrackingService {
  readonly #deps: TrackingServiceDeps;
  readonly #entries = createRepository<EntryRow>({ model: 'trackingEntry', scope: 'company' });

  constructor(deps: TrackingServiceDeps) {
    this.#deps = deps;
  }

  private now(): Date {
    return this.#deps.now?.() ?? new Date();
  }

  /** The sheet's default date: today in Qatar (the business runs on Qatar time). */
  today(): string {
    return qatarToday(this.now());
  }

  /** The live employee of a party, or a clear refusal (step 1). */
  async employeeOf(partyId: string) {
    const employee = await currentUnit().db.employee.findFirst({
      where: { partyId, deletedAt: null },
      select: { id: true, companyId: true, statusCode: true },
    });
    if (employee === null) {
      throw new UnprocessableError(
        'not_an_employee',
        'This person is not an employee, so the call sheet cannot track them.',
      );
    }
    return employee;
  }

  /** An active value of a lookup list, or a field error naming `path`. */
  async lookupValue(id: string, listKey: string, path: string) {
    const value = await currentUnit().db.lookupValue.findFirst({
      where: { id, active: true, deletedAt: null, type: { key: listKey, deletedAt: null } },
      select: { id: true, code: true, labels: true, lookupTypeId: true },
    });
    if (value === null) {
      throw new ValidationError([
        { path, code: 'unknown_value', message: `This is not one of the ${listKey} values.` },
      ]);
    }
    return value;
  }

  /** Steps 1 to 5 of the header. */
  private async resolveStatus(input: {
    partyId: string;
    statusCode: string;
    reasonId: string | null;
    effectiveDate: string;
    note: string | null;
    /** The entry being changed, so it does not supersede itself. */
    entryId?: string;
  }): Promise<StatusColumns> {
    const { db, context } = currentUnit();
    const { permissions, states } = this.#deps;
    if (TRACKING_REASON_REQUIRED.includes(input.statusCode) && input.reasonId === null) {
      throw new ValidationError([
        { path: 'reasonId', code: 'reason_required', message: 'Choose a reason for this status.' },
      ]);
    }
    const reason =
      input.reasonId === null
        ? null
        : await this.lookupValue(input.reasonId, 'status_reason', 'reasonId');
    // Step 1.
    const employee = await this.employeeOf(input.partyId);
    const today = utcToday(this.now());
    const future = input.effectiveDate > today;
    // Step 5 first: whatever this entry turns out to be, it is the newest instruction.
    await db.trackingEntry.updateMany({
      where: {
        partyId: input.partyId,
        statusState: 'pending',
        deletedAt: null,
        ...(input.entryId === undefined ? {} : { id: { not: input.entryId } }),
      },
      data: { statusState: 'superseded' },
    });
    const columns = {
      statusCode: input.statusCode,
      reasonId: input.reasonId,
      effectiveDate: toDay(input.effectiveDate),
      statusError: null,
      statusSetBy: context.userId ?? null,
    };
    // Step 2.
    if (employee.statusCode === input.statusCode && !future) {
      return {
        ...columns,
        statusState: 'unchanged',
        stateHistoryId: null,
        statusAppliedAt: null,
      };
    }
    // Step 3: the move must exist from where the person is now, and be the caller's to make.
    const machine = await states.machineFor(EMPLOYEE_ENTITY);
    if (machine === null) {
      throw new UnprocessableError(
        'state_machine_missing',
        'Employee status has no state machine; set it up first.',
      );
    }
    const transition = await db.stateTransition.findFirst({
      where: {
        stateMachineId: machine.id,
        fromCode: employee.statusCode,
        toCode: input.statusCode,
        deletedAt: null,
      },
    });
    if (transition === null) {
      throw new UnprocessableError(
        'transition_not_allowed',
        `A person who is "${employee.statusCode}" cannot be set to "${input.statusCode}".`,
      );
    }
    await permissions.require(transition.permissionKey ?? EMPLOYEE_STATUS);
    if (future) {
      return { ...columns, statusState: 'pending', stateHistoryId: null, statusAppliedAt: null };
    }
    // Step 4: the kernel moves the employee and writes the dated history.
    const moved = await states.transition(
      EMPLOYEE_ENTITY,
      employee.id,
      transitionRequest(input, reason, transition.reasonLookupTypeId),
    );
    return {
      ...columns,
      statusState: 'applied',
      stateHistoryId: moved.history.id,
      statusAppliedAt: this.now(),
    };
  }

  /** `POST /tracking/entries`: the first record of a person on a date. */
  async createEntry(input: TrackingEntryCreateInput): Promise<EntryView> {
    const { db, context } = currentUnit();
    const { permissions } = this.#deps;
    await permissions.require(ENTRY_CREATE);
    if (input.statusCode !== undefined) await permissions.require(STATUS_APPLY);
    const employee = await this.employeeOf(input.partyId);
    const businessDate = input.businessDate ?? this.today();
    const existing = await db.trackingEntry.findFirst({
      where: { partyId: input.partyId, businessDate: toDay(businessDate), deletedAt: null },
      select: { id: true, version: true },
    });
    if (existing !== null) {
      throw new ConflictError(
        'entry_exists',
        'This person already has an entry for this date; change that one instead.',
        { id: existing.id, version: existing.version },
      );
    }
    if (input.callOutcomeId !== undefined) {
      await this.lookupValue(input.callOutcomeId, 'call_outcome', 'callOutcomeId');
    }
    const status =
      input.statusCode === undefined
        ? {}
        : await this.resolveStatus({
            partyId: input.partyId,
            statusCode: input.statusCode,
            reasonId: input.reasonId ?? null,
            effectiveDate: input.effectiveDate ?? businessDate,
            note: input.note ?? null,
          });
    const row = await this.#entries.create({
      companyId: employee.companyId,
      partyId: input.partyId,
      businessDate: toDay(businessDate),
      callOutcomeId: input.callOutcomeId ?? null,
      callerUserId: input.callOutcomeId === undefined ? null : (context.userId ?? null),
      note: input.note ?? null,
      ...status,
    });
    return entryView(row);
  }

  /**
   * `PATCH /tracking/entries/{id}`. A status given here is a new status change (the one
   * already applied stays in the employee's history); the reason and effective date only
   * change together with a status, so an applied history row is never contradicted.
   */
  async updateEntry(id: string, input: TrackingEntryUpdateInput): Promise<EntryView> {
    const { context } = currentUnit();
    const { permissions } = this.#deps;
    await permissions.require(ENTRY_UPDATE);
    if (input.statusCode !== undefined) await permissions.require(STATUS_APPLY);
    const row = await this.#entries.get(id);
    if (input.statusCode === undefined && input.reasonId !== undefined) {
      throw new ValidationError([
        {
          path: 'reasonId',
          code: 'status_required',
          message: 'Change the reason together with the status.',
        },
      ]);
    }
    const changes: Record<string, unknown> = {};
    if (input.callOutcomeId !== undefined) {
      if (input.callOutcomeId !== null) {
        await this.lookupValue(input.callOutcomeId, 'call_outcome', 'callOutcomeId');
      }
      changes.callOutcomeId = input.callOutcomeId;
      changes.callerUserId = input.callOutcomeId === null ? null : (context.userId ?? null);
    }
    if (input.note !== undefined) changes.note = input.note;
    if (input.statusCode !== undefined) {
      Object.assign(
        changes,
        await this.resolveStatus({
          partyId: row.partyId,
          statusCode: input.statusCode,
          reasonId: input.reasonId ?? null,
          effectiveDate: input.effectiveDate ?? isoDay(row.businessDate),
          note: input.note ?? row.note,
          entryId: row.id,
        }),
      );
    }
    return entryView(await this.#entries.update(id, input.version, changes));
  }

  /** Applies one pending change (inside the unit of work of its group). */
  private async applyPending(id: string): Promise<'applied' | 'skipped'> {
    const { db } = currentUnit();
    const row = await db.trackingEntry.findFirst({ where: { id, deletedAt: null } });
    // Already handled by a parallel run, superseded, or not due: nothing to do.
    if (row?.statusState !== 'pending' || row.statusCode === null || row.effectiveDate === null) {
      return 'skipped';
    }
    if (isoDay(row.effectiveDate) > utcToday(this.now())) return 'skipped';
    const employee = await this.employeeOf(row.partyId);
    let history: { id: string } | null = null;
    if (employee.statusCode !== row.statusCode) {
      const machine = await this.#deps.states.machineFor(EMPLOYEE_ENTITY);
      const transition =
        machine === null
          ? null
          : await db.stateTransition.findFirst({
              where: {
                stateMachineId: machine.id,
                fromCode: employee.statusCode,
                toCode: row.statusCode,
                deletedAt: null,
              },
              select: { reasonLookupTypeId: true },
            });
      const reason =
        row.reasonId === null
          ? null
          : await db.lookupValue.findFirst({
              where: { id: row.reasonId },
              select: { id: true, code: true, labels: true, lookupTypeId: true },
            });
      // The state service refuses a move that no longer exists, with its own clear message.
      const moved = await this.#deps.states.transition(
        EMPLOYEE_ENTITY,
        employee.id,
        transitionRequest(
          {
            statusCode: row.statusCode,
            effectiveDate: isoDay(row.effectiveDate),
            note: row.note,
          },
          reason,
          transition?.reasonLookupTypeId ?? null,
        ),
      );
      history = moved.history;
    }
    await this.#entries.update(
      row.id,
      row.version,
      history === null
        ? { statusState: 'unchanged' }
        : { statusState: 'applied', stateHistoryId: history.id, statusAppliedAt: this.now() },
    );
    return 'applied';
  }

  /** The recurring job: applies every pending change whose date has come (see header). */
  async applyDue(): Promise<ApplyDueResult> {
    const { uow, prisma, logger } = this.#deps;
    if (prisma === undefined) throw new Error('Tracking job: the job client is missing');
    const until = toDay(utcToday(this.now()));
    const groups = await prisma.$queryRaw<
      { tenant_id: string; company_id: string; status_set_by: string | null }[]
    >`SELECT tenant_id::text AS tenant_id, company_id::text AS company_id,
             status_set_by::text AS status_set_by
        FROM tracking.due_status_changes(${until}::date)`;
    const result: ApplyDueResult = { groups: groups.length, applied: 0, failed: 0 };
    for (const group of groups) {
      const context: DbContext = {
        tenantId: group.tenant_id,
        companyIds: [group.company_id],
        ...(group.status_set_by === null ? {} : { userId: group.status_set_by }),
      };
      const request: RequestContext = {
        requestId: `tracking-${randomUUID()}`,
        startedAt: Date.now(),
        ip: undefined,
        principal:
          group.status_set_by === null
            ? undefined
            : { kind: 'user', userId: group.status_set_by, tenantId: group.tenant_id },
        companyIds: [group.company_id],
      };
      await runWithContext(request, async () => {
        const ids = await uow.runAs(context, (db) =>
          db.trackingEntry.findMany({
            where: {
              statusState: 'pending',
              deletedAt: null,
              effectiveDate: { lte: until },
              statusSetBy: group.status_set_by,
            },
            orderBy: [{ effectiveDate: 'asc' }, { id: 'asc' }],
            select: { id: true },
          }),
        );
        for (const { id } of ids) {
          try {
            const done = await uow.runAs(context, () => this.applyPending(id));
            if (done === 'applied') result.applied += 1;
          } catch (err) {
            // The change can no longer be made: say why on the entry, carry on with the rest.
            result.failed += 1;
            const message = err instanceof Error ? err.message : String(err);
            logger?.warn({ err, entryId: id }, 'tracking: pending status change failed');
            await uow.runAs(context, (db) =>
              db.trackingEntry.updateMany({
                where: { id, statusState: 'pending' },
                data: { statusState: 'failed', statusError: message.slice(0, 1000) },
              }),
            );
          }
        }
      });
    }
    return result;
  }
}

/** The state service request for a tracking status (reason handling: see the header). */
function transitionRequest(
  input: { statusCode: string; effectiveDate: string; note: string | null },
  reason: { id: string; code: string; labels: unknown; lookupTypeId: string } | null,
  reasonListId: string | null,
): TransitionRequest {
  const byList = reason !== null && reasonListId !== null && reason.lookupTypeId === reasonListId;
  const labels = (reason?.labels ?? {}) as Record<string, unknown>;
  const reasonText =
    reason === null || byList ? null : typeof labels.en === 'string' ? labels.en : reason.code;
  const note = [reasonText, input.note].filter((part) => part !== null && part !== '').join(': ');
  return {
    toCode: input.statusCode,
    effectiveDate: input.effectiveDate,
    ...(byList ? { reasonId: reason.id } : {}),
    ...(note === '' ? {} : { note: note.slice(0, 2000) }),
  };
}
