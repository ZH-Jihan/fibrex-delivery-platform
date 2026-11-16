/**
 * State service: moves a record of any entity type from one state to another and keeps the
 * dated history (PLAN 3.7 `state_history`; SPEC 2.10 "State machines").
 *
 * Purpose: the one place a state changes. A module never writes its own status column
 * directly; it registers a `StateTarget` (how to read a record and how to store its new
 * state) and everything else, the rules, the permission and the history, happens here, so
 * no entity can skip them. Custom record types need no registration (see `StateTargets`).
 *
 * How a move works, step by step (`transition`):
 *   1. Find the live machine of the entity type (one per type) and the record, through its
 *      target. A record the caller cannot see is a 404 (row-level security).
 *   2. Where the record is now: its state, or the machine's initial state when it has none
 *      (a record created before the machine existed counts as being at the start).
 *   3. The move must be a live transition from that state to the wanted one. Anything else
 *      is refused (422): the machine lists every move that is allowed.
 *   4. Permission: the transition's own key, or the entity's update permission when the
 *      transition names none.
 *   5. Required fields, reason and effective date: the shared `checkTransition`. A reason
 *      from a list must be an active value of the transition's list.
 *   6. Store the new state through the target with the version read in step 1, so two
 *      people moving the same record at once get one success and one 409.
 *   7. Write the history row. Steps 6 and 7 are in the caller's transaction: a state never
 *      changes without its history, nor the other way round.
 *
 * Depends on: @fibrex/shared (checkTransition), kernel/db unit of work, kernel/http/errors,
 * kernel/permissions.
 * Used by: ./state-router.ts, kernel/records (first state of a new record), src/main.ts;
 * later modules register targets (tracking, employee status).
 */
import { can, checkTransition, type TransitionRequest } from '@fibrex/shared';
import type { Db } from '../db/prisma.js';
import { currentUnit } from '../db/unit-of-work.js';
import { NotFoundError, UnprocessableError, ValidationError } from '../http/errors.js';
import type { PermissionService } from '../permissions/permission-service.js';

export type StateMachineRecord = NonNullable<Awaited<ReturnType<Db['stateMachine']['findFirst']>>>;
export type StateRecord = NonNullable<Awaited<ReturnType<Db['state']['findFirst']>>>;
export type StateTransitionRecord = NonNullable<
  Awaited<ReturnType<Db['stateTransition']['findFirst']>>
>;
export type StateHistoryRecord = NonNullable<Awaited<ReturnType<Db['stateHistory']['findFirst']>>>;

/** One record as the state service needs to see it. */
export interface StateSubject {
  id: string;
  companyId: string;
  /** NULL when the record has never been given a state. */
  stateCode: string | null;
  /** The optimistic-locking version read with the record. */
  version: number;
  /** Field values, checked against a transition's required fields. */
  fields: Readonly<Record<string, unknown>>;
  /** Permission to see the record (and so its history). */
  readPermission: string;
  /** Permission a move needs when the transition names none. */
  updatePermission: string;
}

/** How one entity type lets the state service read a record and store its state. */
export interface StateTarget {
  /** The live record, or NotFoundError. */
  load(id: string): Promise<StateSubject>;
  /** Stores the new state; a version that is no longer current must fail with a 409. */
  setState(subject: StateSubject, toCode: string): Promise<void>;
}

/**
 * The entity types whose records can change state. Modules register theirs under their
 * entity type (`people.employee`); a key without a dot is a custom record type and is
 * answered by `custom`, so every record type an administrator defines works at once.
 */
export class StateTargets {
  readonly #registered = new Map<string, StateTarget>();
  readonly #custom: (entityKey: string) => StateTarget;

  constructor(custom: (entityKey: string) => StateTarget) {
    this.#custom = custom;
  }

  register(entityType: string, target: StateTarget): void {
    if (!entityType.includes('.')) {
      throw new Error(`State target "${entityType}": a module's entity type is module.type`);
    }
    if (this.#registered.has(entityType)) {
      throw new Error(`State target "${entityType}" is registered twice`);
    }
    this.#registered.set(entityType, target);
  }

  for(entityType: string): StateTarget {
    if (!entityType.includes('.')) return this.#custom(entityType);
    const target = this.#registered.get(entityType);
    if (target === undefined) throw new NotFoundError(`"${entityType}" has no states.`);
    return target;
  }
}

/** One move the record could make now, for the buttons of a screen. */
export interface AvailableTransition {
  transition: StateTransitionRecord;
  to: StateRecord;
  /** Whether the caller holds the permission the move needs. */
  allowed: boolean;
}

export interface StateOverview {
  machine: StateMachineRecord;
  /** Where the record is now (step 2), or null when the machine has no initial state. */
  current: StateRecord | null;
  stateCode: string | null;
  available: AvailableTransition[];
}

export interface TransitionResult {
  stateCode: string;
  history: StateHistoryRecord;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDay = (text: string) => new Date(`${text}T00:00:00.000Z`);

export interface StateServiceDeps {
  permissions: PermissionService;
  targets: StateTargets;
}

export class StateService {
  readonly #deps: StateServiceDeps;

  constructor(deps: StateServiceDeps) {
    this.#deps = deps;
  }

  /** The live machine of an entity type, or null when the type has none. */
  async machineFor(entityType: string): Promise<StateMachineRecord | null> {
    return currentUnit().db.stateMachine.findFirst({
      where: { entityKey: entityType, deletedAt: null },
    });
  }

  private async statesOf(machineId: string): Promise<StateRecord[]> {
    return currentUnit().db.state.findMany({
      where: { stateMachineId: machineId, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
  }

  /**
   * The state a new record of this type starts in: the initial state of its machine, or
   * null when the type has no machine (or the machine has no initial state yet).
   */
  async initialCode(entityType: string): Promise<string | null> {
    const machine = await this.machineFor(entityType);
    if (machine === null) return null;
    const initial = await currentUnit().db.state.findFirst({
      where: { stateMachineId: machine.id, isInitial: true, deletedAt: null },
    });
    return initial?.code ?? null;
  }

  /** The first history row of a record that was just created in state `code`. */
  async recordStart(
    entityType: string,
    entityId: string,
    companyId: string,
    code: string,
  ): Promise<StateHistoryRecord> {
    return this.writeHistory({
      entityType,
      entityId,
      companyId,
      fromCode: null,
      toCode: code,
      effectiveDate: toDay(isoDay(new Date())),
    });
  }

  private async writeHistory(row: {
    entityType: string;
    entityId: string;
    companyId: string;
    fromCode: string | null;
    toCode: string;
    effectiveDate: Date;
    reasonId?: string | undefined;
    note?: string | undefined;
  }): Promise<StateHistoryRecord> {
    const { db, context } = currentUnit();
    return db.stateHistory.create({
      data: {
        tenantId: context.tenantId,
        companyId: row.companyId,
        entityType: row.entityType,
        entityId: row.entityId,
        fromCode: row.fromCode,
        toCode: row.toCode,
        effectiveDate: row.effectiveDate,
        reasonId: row.reasonId ?? null,
        note: row.note ?? null,
        // Absent for an API client or a system job; `created_by` is stamped by the database.
        actorId: context.userId ?? null,
      },
    });
  }

  /** Steps 1 and 2, shared by reading and moving. */
  private async locate(entityType: string, id: string) {
    const machine = await this.machineFor(entityType);
    if (machine === null) throw new NotFoundError(`"${entityType}" has no state machine.`);
    const target = this.#deps.targets.for(entityType);
    const subject = await target.load(id);
    const states = await this.statesOf(machine.id);
    const fromCode = subject.stateCode ?? states.find((s) => s.isInitial)?.code ?? null;
    return { machine, target, subject, states, fromCode };
  }

  /** Where a record is and which moves it could make (needs the entity's read permission). */
  async overview(entityType: string, id: string): Promise<StateOverview> {
    const { machine, subject, states, fromCode } = await this.locate(entityType, id);
    const access = await this.#deps.permissions.require(subject.readPermission);
    const transitions =
      fromCode === null
        ? []
        : await currentUnit().db.stateTransition.findMany({
            where: { stateMachineId: machine.id, fromCode, deletedAt: null },
          });
    const byCode = new Map(states.map((s) => [s.code, s]));
    const available = transitions
      .flatMap((transition) => {
        const to = byCode.get(transition.toCode);
        if (to === undefined) return [];
        const key = transition.permissionKey ?? subject.updatePermission;
        return [{ transition, to, allowed: can(access, key) }];
      })
      .sort((a, b) => a.to.sortOrder - b.to.sortOrder || a.to.code.localeCompare(b.to.code));
    return {
      machine,
      current: fromCode === null ? null : (byCode.get(fromCode) ?? null),
      stateCode: subject.stateCode,
      available,
    };
  }

  /** The dated history of a record, oldest first (needs the entity's read permission). */
  async history(entityType: string, id: string): Promise<StateHistoryRecord[]> {
    const subject = await this.#deps.targets.for(entityType).load(id);
    await this.#deps.permissions.require(subject.readPermission);
    return currentUnit().db.stateHistory.findMany({
      where: { entityType, entityId: id },
      // Ids are UUID v7 (time-ordered): the order the moves were made in.
      orderBy: [{ id: 'asc' }],
    });
  }

  /** Moves a record to `request.toCode` (the steps are in the header). */
  async transition(
    entityType: string,
    id: string,
    request: TransitionRequest,
  ): Promise<TransitionResult> {
    const { db } = currentUnit();
    // Steps 1 and 2.
    const { machine, target, subject, states, fromCode } = await this.locate(entityType, id);
    if (fromCode === null) {
      throw new UnprocessableError(
        'state_machine_incomplete',
        'This state machine has no first state yet.',
      );
    }
    // Step 3.
    const to = states.find((s) => s.code === request.toCode);
    const transition =
      to === undefined
        ? null
        : await db.stateTransition.findFirst({
            where: {
              stateMachineId: machine.id,
              fromCode,
              toCode: request.toCode,
              deletedAt: null,
            },
          });
    if (transition === null) {
      throw new UnprocessableError(
        'transition_not_allowed',
        `A record in state "${fromCode}" cannot move to "${request.toCode}".`,
      );
    }
    // Step 4.
    await this.#deps.permissions.require(transition.permissionKey ?? subject.updatePermission);
    // Step 5.
    const last = await db.stateHistory.findFirst({
      where: { entityType, entityId: id },
      orderBy: [{ id: 'desc' }],
    });
    const today = isoDay(new Date());
    const issues = checkTransition(
      {
        requiredFields: transition.requiredFields,
        reasonRequired: transition.reasonRequired,
        hasReasonList: transition.reasonLookupTypeId !== null,
      },
      request,
      {
        data: subject.fields,
        today,
        lastEffectiveDate: last === null ? undefined : isoDay(last.effectiveDate),
      },
    );
    if (request.reasonId !== undefined) {
      // A reason is only meaningful from the transition's own list; a value of another
      // list (or a retired one) would make reports by reason wrong.
      const reason =
        transition.reasonLookupTypeId === null
          ? null
          : await db.lookupValue.findFirst({
              where: {
                id: request.reasonId,
                lookupTypeId: transition.reasonLookupTypeId,
                active: true,
                deletedAt: null,
              },
              select: { id: true },
            });
      if (reason === null) {
        issues.push({
          path: 'reasonId',
          code: 'unknown_reason',
          message: 'This is not one of the reasons for this change.',
        });
      }
    }
    if (issues.length > 0) throw new ValidationError(issues);
    // Step 6.
    await target.setState(subject, request.toCode);
    // Step 7.
    const history = await this.writeHistory({
      entityType,
      entityId: id,
      companyId: subject.companyId,
      fromCode,
      toCode: request.toCode,
      effectiveDate: toDay(request.effectiveDate ?? today),
      reasonId: request.reasonId,
      note: request.note,
    });
    return { stateCode: request.toCode, history };
  }
}
