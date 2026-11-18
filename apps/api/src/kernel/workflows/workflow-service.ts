/**
 * Workflow engine (phase 2 row 2.11a; PLAN 3.7 `workflow_*`, PLAN 5.9 "Workflow"; SPEC 2.10).
 *
 * Purpose: runs the approval workflows an administrator configured. It starts them (on a
 * record's creation, on a move into a state, or by hand), walks their steps, opens tasks
 * for the right people, applies each task action (approve, reject, send back, comment,
 * delegate), keeps the insert-only timeline, and sends reminders and escalations when a
 * task passes its SLA. The shape of a graph and its rules are in @fibrex/shared
 * (workflows); the walk is here.
 *
 * How a workflow runs, step by step:
 *   1. Start: the definition's published version is fixed on the instance, so a later
 *      change to the workflow never changes one already running. One instance of a
 *      definition runs per record at a time; a second start is ignored (automatic) or
 *      refused (by hand).
 *   2. Walk (`advance`): from the current position, notify steps announce their event and
 *      carry on; condition steps run their formula on the record's fields (the formula
 *      version used is written to the timeline) and carry on or jump forward; the first
 *      approval or parallel group stops the walk and opens its tasks. Past the last step
 *      the workflow is approved.
 *   3. Tasks: one per named user, per user in the record field, per role (anyone holding
 *      the role in the record's company may act). A user away on an active delegation is
 *      replaced by the delegate, and the task remembers whom it came from. An approval
 *      that finds nobody stops the whole action (422): an approval is never skipped
 *      silently.
 *   4. Actions lock the instance row first (SELECT ... FOR UPDATE), so two approvers
 *      acting at the same moment are applied one after the other and a quorum of "all" is
 *      counted correctly.
 *   5. Approve: the task is done; when the step's quorum is reached (shared
 *      `quorumReached`) its other tasks are skipped, and when every branch of a parallel
 *      group is complete the walk continues. The person who started the workflow may not
 *      approve it unless the step allows it.
 *   6. Reject ends the workflow as rejected. Send back reopens the previous approval stage
 *      (a new round of tasks); at the first stage there is nothing to send back to.
 *   7. End: open tasks are skipped, and the graph's outcome move (`onApproved` /
 *      `onRejected`) is made through the state service with the workflow as the authority.
 *   8. SLA (`sweep`, run by the scheduler): a task past its reminder time is reminded
 *      once; a task past its deadline is escalated once: replaced by tasks for the step's
 *      `escalateTo` (the old task expires), or, with no one to escalate to, announced as
 *      overdue.
 *   9. Notifications are announced only after the transaction commits
 *      (`currentUnit().afterCommit`), so nobody is told about a task a rollback removed.
 *
 * Depends on: @fibrex/shared (workflow graph, quorum), kernel/db unit of work,
 * kernel/http/errors, kernel/permissions, kernel/states (records and outcome moves),
 * kernel/formulas (conditions).
 * Used by: ./workflow-router.ts, kernel/records and kernel/states (start hooks, wired in
 * src/main.ts), the scheduler (SLA sweep).
 */
import {
  checkWorkflowGraph,
  quorumReached,
  workflowGraphSchema,
  type ApprovalStep,
  type AssigneeRule,
  type ParallelStep,
  type QuorumTask,
  type WorkflowGraph,
  type WorkflowTrigger,
} from '@fibrex/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Db, PrismaDb } from '../db/prisma.js';
import { currentUnit, type UnitOfWork } from '../db/unit-of-work.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '../http/errors.js';
import type { Logger } from '../observability/logger.js';
import type { PermissionService } from '../permissions/permission-service.js';
import type {
  StateMove,
  StateService,
  StateSubject,
  StateTargets,
} from '../states/state-service.js';

export type WorkflowDefinitionRow = NonNullable<
  Awaited<ReturnType<Db['workflowDefinition']['findFirst']>>
>;
export type WorkflowVersionRow = NonNullable<
  Awaited<ReturnType<Db['workflowVersion']['findFirst']>>
>;
export type WorkflowBindingRow = NonNullable<
  Awaited<ReturnType<Db['workflowBinding']['findFirst']>>
>;
export type WorkflowInstanceRow = NonNullable<
  Awaited<ReturnType<Db['workflowInstance']['findFirst']>>
>;
export type WorkflowTaskRow = NonNullable<Awaited<ReturnType<Db['workflowTask']['findFirst']>>>;
export type WorkflowEventRow = NonNullable<Awaited<ReturnType<Db['workflowEvent']['findFirst']>>>;
export type WorkflowDelegationRow = NonNullable<
  Awaited<ReturnType<Db['workflowDelegation']['findFirst']>>
>;

/** An event for the notification rules, announced after commit. */
export interface WorkflowAnnouncement {
  tenantId: string;
  companyId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

/** Where announcements go (the notification service in src/main.ts). */
export interface WorkflowEventSink {
  emit(event: WorkflowAnnouncement): Promise<unknown>;
}

/** Event types the engine announces; registered in the notification catalogue. */
export const WORKFLOW_EVENT_TYPES = [
  {
    key: 'workflow.task_assigned',
    moduleKey: 'platform',
    label: 'Workflow task assigned',
    description: 'A workflow task was given to a person (assigneeId) or a role (roleKey).',
  },
  {
    key: 'workflow.task_reminder',
    moduleKey: 'platform',
    label: 'Workflow task reminder',
    description: 'A workflow task reached its reminder time.',
  },
  {
    key: 'workflow.task_escalated',
    moduleKey: 'platform',
    label: 'Workflow task escalated',
    description: 'A workflow task passed its deadline and was given to someone else.',
  },
  {
    key: 'workflow.task_overdue',
    moduleKey: 'platform',
    label: 'Workflow task overdue',
    description: 'A workflow task passed its deadline and has no one to escalate to.',
  },
  {
    key: 'workflow.notify',
    moduleKey: 'platform',
    label: 'Workflow notify step',
    description: 'A notify step of a workflow was reached.',
  },
  {
    key: 'workflow.completed',
    moduleKey: 'platform',
    label: 'Workflow finished',
    description: 'A workflow was approved or rejected (starterId is who started it).',
  },
] as const;

export type TaskAction = 'approve' | 'reject' | 'send_back' | 'comment' | 'delegate';

export interface TaskActionInput {
  comment?: string | undefined;
  payload?: Record<string, unknown> | undefined;
  toUserId?: string | undefined;
}

export interface InboxEntry {
  task: WorkflowTaskRow;
  instance: WorkflowInstanceRow;
  definition: WorkflowDefinitionRow;
  stepName: string;
}

export interface InstanceView {
  instance: WorkflowInstanceRow;
  definition: WorkflowDefinitionRow;
  tasks: WorkflowTaskRow[];
  events: WorkflowEventRow[];
}

export interface WorkflowServiceDeps {
  permissions: PermissionService;
  targets: StateTargets;
  states: Pick<StateService, 'transition'>;
  /** Evaluates a boolean formula by key on a day (the formula service). */
  evaluate: (
    key: string,
    onDate: Date,
    inputs: Record<string, unknown>,
  ) => Promise<{ value: unknown; formulaVersionId: string; versionNo: number }>;
  events?: WorkflowEventSink;
  logger?: Logger;
  now?: () => Date;
}

const HOUR = 3_600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDay = (text: string) => new Date(`${text}T00:00:00.000Z`);

/** An approval step found in a graph, with the group it belongs to and its position. */
interface Located {
  step: ApprovalStep;
  group: ParallelStep | null;
  index: number;
}

function locate(graph: WorkflowGraph, key: string): Located | null {
  for (const [index, step] of graph.steps.entries()) {
    if (step.kind === 'approval' && step.key === key) return { step, group: null, index };
    if (step.kind === 'parallel_group') {
      const branch = step.branches.find((b) => b.key === key);
      if (branch !== undefined) return { step: branch, group: step, index };
    }
  }
  return null;
}

/** One task to open: a user (maybe standing in for someone) or a role. */
interface Assignee {
  userId?: string;
  roleId?: string;
  roleKey?: string;
  delegatedFrom?: string;
}

export class WorkflowService {
  readonly #deps: WorkflowServiceDeps;

  constructor(deps: WorkflowServiceDeps) {
    this.#deps = deps;
  }

  #now(): Date {
    return this.#deps.now?.() ?? new Date();
  }

  /* ----------------------------------------------------------------------------------
   * Configuration: publishing a version
   * -------------------------------------------------------------------------------- */

  /**
   * Checks a graph against the rules of @fibrex/shared and against the tenant's data:
   * condition formulas exist and return bool, roles and users exist, outcome states are
   * states of the entity's machine. Returns the parsed graph.
   */
  async checkGraph(entityKey: string, raw: unknown): Promise<WorkflowGraph> {
    const parsed = workflowGraphSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((i) => ({
          path: ['graph', ...i.path.map(String)].join('.'),
          code: i.code,
          message: i.message,
        })),
      );
    }
    const graph = parsed.data;
    const issues = checkWorkflowGraph(graph).map((i) => ({ ...i, path: `graph.${i.path}` }));
    const { db } = currentUnit();
    const approvals: { step: ApprovalStep; path: string }[] = [];
    for (const [i, step] of graph.steps.entries()) {
      const path = `graph.steps.${String(i)}`;
      if (step.kind === 'approval') approvals.push({ step, path });
      if (step.kind === 'parallel_group') {
        step.branches.forEach((b, j) =>
          approvals.push({ step: b, path: `${path}.branches.${String(j)}` }),
        );
      }
      if (step.kind === 'condition') {
        const issue = await this.#checkConditionFormula(step.formulaKey, `${path}.formulaKey`);
        if (issue !== null) issues.push(issue);
      }
    }
    for (const { step, path } of approvals) {
      for (const [field, rule] of [
        ['assignee', step.assignee],
        ['escalateTo', step.escalateTo],
      ] as const) {
        if (rule === undefined) continue;
        const roles = rule.roles ?? [];
        if (roles.length > 0) {
          const found = await db.role.findMany({
            where: { key: { in: roles }, deletedAt: null },
            select: { key: true },
          });
          for (const key of roles.filter((r) => !found.some((f) => f.key === r))) {
            issues.push({
              path: `${path}.${field}.roles`,
              code: 'unknown_role',
              message: `There is no role "${key}".`,
            });
          }
        }
        const users = rule.users ?? [];
        if (users.length > 0) {
          const found = await db.userAccount.count({
            where: { id: { in: users }, deletedAt: null },
          });
          if (found !== new Set(users).size) {
            issues.push({
              path: `${path}.${field}.users`,
              code: 'unknown_user',
              message: 'One of these users does not exist.',
            });
          }
        }
      }
    }
    for (const outcome of ['onApproved', 'onRejected'] as const) {
      const move = graph[outcome];
      if (move === undefined) continue;
      const state = await db.state.findFirst({
        where: { code: move.toStateCode, deletedAt: null, machine: { entityKey, deletedAt: null } },
        select: { id: true },
      });
      if (state === null) {
        issues.push({
          path: `graph.${outcome}.toStateCode`,
          code: 'unknown_state',
          message: `"${entityKey}" has no state "${move.toStateCode}".`,
        });
      }
    }
    if (issues.length > 0) throw new ValidationError(issues);
    return graph;
  }

  async #checkConditionFormula(key: string, path: string) {
    const formula = await currentUnit().db.formula.findFirst({
      where: { key, deletedAt: null },
      select: { returnType: true },
    });
    if (formula === null) {
      return { path, code: 'unknown_formula', message: `There is no formula "${key}".` };
    }
    if (formula.returnType !== 'bool') {
      return {
        path,
        code: 'formula_not_bool',
        message: `Formula "${key}" must give true or false.`,
      };
    }
    return null;
  }

  /** A binding's condition formula, checked the same way as a condition step's. */
  async checkBindingFormula(key: string): Promise<void> {
    const issue = await this.#checkConditionFormula(key, 'conditionFormulaKey');
    if (issue !== null) throw new ValidationError([issue]);
  }

  /**
   * Publishes the newest draft of a definition: checks it, freezes it, writes its steps
   * and retires the version published before. Running instances keep their version.
   */
  async publish(definitionId: string): Promise<WorkflowVersionRow> {
    const { db, context } = currentUnit();
    const definition = await db.workflowDefinition.findFirst({
      where: { id: definitionId, deletedAt: null },
    });
    if (definition === null) throw new NotFoundError('No such workflow.');
    const draft = await db.workflowVersion.findFirst({
      where: { workflowDefinitionId: definitionId, status: 'draft', deletedAt: null },
      orderBy: { versionNo: 'desc' },
    });
    if (draft === null) {
      throw new UnprocessableError('workflow_no_draft', 'There is no draft version to publish.');
    }
    const graph = await this.checkGraph(definition.entityKey, draft.graph);
    await db.workflowVersion.updateMany({
      where: { workflowDefinitionId: definitionId, status: 'published', deletedAt: null },
      data: { status: 'retired' },
    });
    const published = await db.workflowVersion.update({
      where: { id: draft.id },
      data: {
        status: 'published',
        publishedAt: this.#now(),
        publishedBy: context.userId ?? null,
        graph: graph as unknown as Prisma.InputJsonValue,
      },
    });
    // One row per step (branches under their group), for reports and the screens.
    const rows: Prisma.WorkflowStepCreateManyInput[] = [];
    const stepRow = (step: ApprovalStep, order: number, parentKey: string | null) => ({
      tenantId: context.tenantId,
      workflowVersionId: draft.id,
      key: step.key,
      parentKey,
      kind: 'approval',
      name: step.name,
      assigneeRule: step.assignee as Prisma.InputJsonValue,
      quorum: step.quorum,
      slaHours: step.slaHours ?? null,
      reminderHours: step.reminderHours ?? null,
      escalateTo: (step.escalateTo ?? undefined) as Prisma.InputJsonValue | undefined,
      allowSelfApproval: step.allowSelfApproval,
      orderNo: order,
    });
    graph.steps.forEach((step, i) => {
      const order = i * 100;
      if (step.kind === 'approval') rows.push(stepRow(step, order, null));
      else if (step.kind === 'parallel_group') {
        rows.push({
          tenantId: context.tenantId,
          workflowVersionId: draft.id,
          key: step.key,
          kind: 'parallel_group',
          name: step.name,
          orderNo: order,
        });
        step.branches.forEach((b, j) => rows.push(stepRow(b, order + j + 1, step.key)));
      } else if (step.kind === 'condition') {
        rows.push({
          tenantId: context.tenantId,
          workflowVersionId: draft.id,
          key: step.key,
          kind: 'condition',
          name: step.name,
          conditionFormulaKey: step.formulaKey,
          onFalseStepKey: step.onFalse,
          orderNo: order,
        });
      } else {
        rows.push({
          tenantId: context.tenantId,
          workflowVersionId: draft.id,
          key: step.key,
          kind: 'notify',
          name: step.name,
          eventTypeKey: step.eventType,
          orderNo: order,
        });
      }
    });
    await db.workflowStep.createMany({ data: rows });
    return published;
  }

  /* ----------------------------------------------------------------------------------
   * Starting
   * -------------------------------------------------------------------------------- */

  /** Hook of kernel/records: workflows bound to "on create" of the type. */
  async onCreated(entityType: string, entityId: string): Promise<void> {
    await this.#fire(entityType, entityId, 'on_create', null, []);
  }

  /** Hook of kernel/states: workflows bound to a move into `toCode`, and the transition's own. */
  async onTransition(move: StateMove): Promise<void> {
    await this.#fire(
      move.entityType,
      move.entityId,
      'on_transition',
      move.toCode,
      move.workflowDefinitionId === null ? [] : [move.workflowDefinitionId],
    );
  }

  async #fire(
    entityType: string,
    entityId: string,
    trigger: WorkflowTrigger,
    toCode: string | null,
    extra: string[],
  ): Promise<void> {
    const { db } = currentUnit();
    const bindings = await db.workflowBinding.findMany({
      where: {
        entityKey: entityType,
        trigger,
        active: true,
        deletedAt: null,
        ...(toCode === null ? {} : { toStateCode: toCode }),
      },
      orderBy: { id: 'asc' },
    });
    if (bindings.length === 0 && extra.length === 0) return;
    const subject = await this.#deps.targets.for(entityType).load(entityId);
    const ids = new Set(extra);
    for (const binding of bindings) {
      if (
        binding.conditionFormulaKey === null ||
        (await this.#condition(binding.conditionFormulaKey, subject)).value
      ) {
        ids.add(binding.workflowDefinitionId);
      }
    }
    for (const id of ids) {
      await this.#start(id, entityType, subject, trigger, false);
    }
  }

  /** Starts a workflow by hand; it needs a live "manual" binding and the record's update permission. */
  async startManual(
    definitionKey: string,
    entityType: string,
    entityId: string,
  ): Promise<WorkflowInstanceRow> {
    const { db } = currentUnit();
    const subject = await this.#deps.targets.for(entityType).load(entityId);
    await this.#deps.permissions.require(subject.updatePermission);
    const definition = await db.workflowDefinition.findFirst({
      where: { key: definitionKey, deletedAt: null },
    });
    const binding =
      definition === null
        ? null
        : await db.workflowBinding.findFirst({
            where: {
              workflowDefinitionId: definition.id,
              entityKey: entityType,
              trigger: 'manual',
              active: true,
              deletedAt: null,
            },
          });
    if (definition === null || binding === null) {
      throw new UnprocessableError(
        'workflow_not_bound',
        `Workflow "${definitionKey}" cannot be started by hand on "${entityType}".`,
      );
    }
    const started = await this.#start(definition.id, entityType, subject, 'manual', true);
    if (started === null) throw new Error('unreachable: a manual start returns its instance');
    return started;
  }

  /** Step 1 of the header. `strict`: refuse instead of ignoring (manual start). */
  async #start(
    definitionId: string,
    entityType: string,
    subject: StateSubject,
    trigger: WorkflowTrigger,
    strict: boolean,
  ): Promise<WorkflowInstanceRow | null> {
    const { db, context } = currentUnit();
    const definition = await db.workflowDefinition.findFirst({
      where: { id: definitionId, deletedAt: null },
    });
    if (definition?.status !== 'active') {
      if (strict)
        throw new UnprocessableError('workflow_inactive', 'This workflow is switched off.');
      return null;
    }
    if (definition.entityKey !== entityType) {
      throw new UnprocessableError(
        'workflow_wrong_entity',
        `Workflow "${definition.key}" is for "${definition.entityKey}", not "${entityType}".`,
      );
    }
    const version = await db.workflowVersion.findFirst({
      where: { workflowDefinitionId: definitionId, status: 'published', deletedAt: null },
    });
    if (version === null) {
      throw new UnprocessableError(
        'workflow_not_published',
        `Workflow "${definition.key}" has no published version.`,
      );
    }
    const running = await db.workflowInstance.findFirst({
      where: {
        workflowDefinitionId: definitionId,
        entityType,
        entityId: subject.id,
        status: 'running',
        deletedAt: null,
      },
    });
    if (running !== null) {
      if (strict) {
        throw new ConflictError(
          'workflow_running',
          'This workflow is already running for this record.',
          {
            instanceId: running.id,
          },
        );
      }
      return null;
    }
    const instance = await db.workflowInstance.create({
      data: {
        tenantId: context.tenantId,
        companyId: subject.companyId,
        workflowDefinitionId: definitionId,
        workflowVersionId: version.id,
        entityType,
        entityId: subject.id,
        trigger,
        startedBy: context.userId ?? null,
      },
    });
    await this.#log(instance, 'started', { detail: { trigger, versionNo: version.versionNo } });
    const graph = workflowGraphSchema.parse(version.graph);
    return this.#advance(instance, definition, graph, 0, subject);
  }

  /* ----------------------------------------------------------------------------------
   * The walk
   * -------------------------------------------------------------------------------- */

  /** Step 2 of the header: walk from `from` to the next approval stage, or to the end. */
  async #advance(
    instance: WorkflowInstanceRow,
    definition: WorkflowDefinitionRow,
    graph: WorkflowGraph,
    from: number,
    subject: StateSubject | null,
  ): Promise<WorkflowInstanceRow> {
    let index = from;
    let record = subject;
    const load = async () => {
      record ??= await this.#deps.targets.for(instance.entityType).load(instance.entityId);
      return record;
    };
    while (index < graph.steps.length) {
      const step = graph.steps[index];
      if (step === undefined) break;
      if (step.kind === 'notify') {
        await this.#log(instance, 'notified', {
          stepKey: step.key,
          detail: { eventType: step.eventType },
        });
        this.#announce(instance, step.eventType, {
          ...this.#about(instance, definition),
          stepKey: step.key,
          stepName: step.name,
          starterId: instance.startedBy,
        });
        index += 1;
        continue;
      }
      if (step.kind === 'condition') {
        const result = await this.#condition(step.formulaKey, await load());
        await this.#log(instance, 'condition', {
          stepKey: step.key,
          detail: {
            formulaKey: step.formulaKey,
            formulaVersionId: result.formulaVersionId,
            versionNo: result.versionNo,
            result: result.value,
          },
        });
        if (result.value) index += 1;
        else if (step.onFalse === 'end') index = graph.steps.length;
        else index = graph.steps.findIndex((s) => s.key === step.onFalse);
        continue;
      }
      // An approval or a parallel group: open its tasks and stop.
      return this.#activate(instance, definition, graph, index, await load());
    }
    return this.#complete(instance, definition, graph, 'approved');
  }

  /** Runs a boolean formula on the record's fields (today's version of the formula). */
  async #condition(key: string, subject: StateSubject) {
    let result;
    try {
      result = await this.#deps.evaluate(key, toDay(isoDay(this.#now())), { ...subject.fields });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new UnprocessableError(
        'workflow_condition_failed',
        `The condition "${key}" could not be worked out: ${message}`,
      );
    }
    if (typeof result.value !== 'boolean') {
      throw new UnprocessableError(
        'workflow_condition_failed',
        `The condition "${key}" did not give true or false.`,
      );
    }
    return {
      value: result.value,
      formulaVersionId: result.formulaVersionId,
      versionNo: result.versionNo,
    };
  }

  /** Opens a new round of tasks for the stage at `index` (an approval or a parallel group). */
  async #activate(
    instance: WorkflowInstanceRow,
    definition: WorkflowDefinitionRow,
    graph: WorkflowGraph,
    index: number,
    known: StateSubject | null,
  ): Promise<WorkflowInstanceRow> {
    const { db } = currentUnit();
    // The record is read only when a rule names one of its fields.
    const subject =
      known ?? (await this.#deps.targets.for(instance.entityType).load(instance.entityId));
    const stage = graph.steps[index];
    const steps =
      stage?.kind === 'approval' ? [stage] : stage?.kind === 'parallel_group' ? stage.branches : [];
    const activationNo = instance.activationNo + 1;
    const updated = await db.workflowInstance.update({
      where: { id: instance.id },
      data: { stepIndex: index, activationNo, currentStepKeys: steps.map((s) => s.key) },
    });
    for (const step of steps) {
      const assignees = await this.#resolve(
        step.assignee,
        subject,
        instance.companyId,
        definition.key,
      );
      if (assignees.length === 0) {
        throw new UnprocessableError(
          'workflow_no_assignee',
          `Nobody can approve step "${step.name}": its users, roles or field name no one in this company.`,
        );
      }
      for (const assignee of assignees) {
        await this.#openTask(updated, definition, step, activationNo, assignee, null);
      }
    }
    return updated;
  }

  async #openTask(
    instance: WorkflowInstanceRow,
    definition: WorkflowDefinitionRow,
    step: ApprovalStep,
    activationNo: number,
    assignee: Assignee,
    escalatedFrom: string | null,
  ): Promise<WorkflowTaskRow> {
    const { db, context } = currentUnit();
    const now = this.#now().getTime();
    // An escalated task gets no new deadline: it is already late.
    const timed = escalatedFrom === null;
    const task = await db.workflowTask.create({
      data: {
        tenantId: context.tenantId,
        companyId: instance.companyId,
        instanceId: instance.id,
        stepKey: step.key,
        activationNo,
        assigneeUserId: assignee.userId ?? null,
        assigneeRoleId: assignee.roleId ?? null,
        delegatedFromUserId: assignee.delegatedFrom ?? null,
        escalatedFromTaskId: escalatedFrom,
        dueAt: timed && step.slaHours !== undefined ? new Date(now + step.slaHours * HOUR) : null,
        reminderAt:
          timed && step.reminderHours !== undefined
            ? new Date(now + step.reminderHours * HOUR)
            : null,
      },
    });
    await this.#log(instance, 'task_created', {
      stepKey: step.key,
      taskId: task.id,
      detail: {
        assigneeUserId: task.assigneeUserId,
        roleKey: assignee.roleKey ?? null,
        delegatedFromUserId: task.delegatedFromUserId,
        escalatedFromTaskId: escalatedFrom,
      },
    });
    this.#announce(instance, 'workflow.task_assigned', {
      ...this.#about(instance, definition),
      taskId: task.id,
      stepKey: step.key,
      stepName: step.name,
      assigneeId: task.assigneeUserId,
      roleKey: assignee.roleKey ?? null,
    });
    return task;
  }

  /**
   * Step 3 of the header: the people (or roles) an assignee rule names in this company.
   * Users must be active members of the company; roles must be held by someone there. A
   * user with an active delegation is replaced by the delegate.
   */
  async #resolve(
    rule: Pick<AssigneeRule, 'users' | 'roles' | 'userField'>,
    subject: StateSubject | null,
    companyId: string,
    definitionKey: string,
  ): Promise<Assignee[]> {
    const { db } = currentUnit();
    const userIds = new Set(rule.users ?? []);
    if (rule.userField !== undefined && subject !== null) {
      const value = subject.fields[rule.userField];
      if (typeof value === 'string' && UUID.test(value)) userIds.add(value);
    }
    const out: Assignee[] = [];
    const members = await this.#members([...userIds], companyId);
    const seen = new Set<string>();
    for (const userId of members) {
      const delegate = await this.#delegateOf(userId, companyId, definitionKey);
      const assignee: Assignee =
        delegate === null ? { userId } : { userId: delegate, delegatedFrom: userId };
      if (assignee.userId !== undefined && !seen.has(assignee.userId)) {
        seen.add(assignee.userId);
        out.push(assignee);
      }
    }
    const roleKeys = rule.roles ?? [];
    if (roleKeys.length > 0) {
      const held = await db.$queryRaw<{ id: string; key: string }[]>`
        SELECT DISTINCT r.id::text AS id, r.key
          FROM iam.role r
          JOIN iam.membership_role mr ON mr.role_id = r.id
          JOIN iam.company_membership m ON m.id = mr.membership_id
          JOIN iam.user_account u ON u.id = m.user_id
         WHERE r.key = ANY (${roleKeys}::text[]) AND r.deleted_at IS NULL
           AND m.company_id = ${companyId}::uuid AND m.deleted_at IS NULL
           AND u.status = 'active' AND u.deleted_at IS NULL
         ORDER BY r.key`;
      for (const role of held) out.push({ roleId: role.id, roleKey: role.key });
    }
    return out;
  }

  /** The given users that are active members of the company. */
  async #members(userIds: string[], companyId: string): Promise<string[]> {
    if (userIds.length === 0) return [];
    const rows = await currentUnit().db.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT u.id::text AS id
        FROM iam.user_account u
        JOIN iam.company_membership m ON m.user_id = u.id
       WHERE u.id = ANY (${userIds}::uuid[]) AND u.status = 'active' AND u.deleted_at IS NULL
         AND m.company_id = ${companyId}::uuid AND m.deleted_at IS NULL`;
    // Keep the order the rule gave.
    return userIds.filter((id) => rows.some((r) => r.id === id));
  }

  /** The delegate standing in for `userId` today for this workflow, if any (one level). */
  async #delegateOf(
    userId: string,
    companyId: string,
    definitionKey: string,
  ): Promise<string | null> {
    const today = toDay(isoDay(this.#now()));
    const delegations = await currentUnit().db.workflowDelegation.findMany({
      where: { userId, deletedAt: null, validFrom: { lte: today }, validTo: { gte: today } },
      orderBy: { id: 'asc' },
    });
    for (const d of delegations) {
      const keys = (d.scope as { definitionKeys?: unknown }).definitionKeys;
      if (Array.isArray(keys) && keys.length > 0 && !keys.includes(definitionKey)) continue;
      // The delegate must be able to act in this company.
      if ((await this.#members([d.delegateUserId], companyId)).length > 0) return d.delegateUserId;
    }
    return null;
  }

  /** Step 7 of the header. */
  async #complete(
    instance: WorkflowInstanceRow,
    definition: WorkflowDefinitionRow,
    graph: WorkflowGraph,
    outcome: 'approved' | 'rejected' | 'cancelled',
  ): Promise<WorkflowInstanceRow> {
    const { db } = currentUnit();
    await db.workflowTask.updateMany({
      where: { instanceId: instance.id, status: 'open' },
      data: { status: 'skipped' },
    });
    const done = await db.workflowInstance.update({
      where: { id: instance.id },
      data: { status: outcome, completedAt: this.#now(), currentStepKeys: [] },
    });
    await this.#log(done, 'completed', { detail: { outcome } });
    if (outcome === 'cancelled') return done;
    const move = outcome === 'approved' ? graph.onApproved : graph.onRejected;
    if (move !== undefined) {
      const subject = await this.#deps.targets.for(instance.entityType).load(instance.entityId);
      // A record already there (moved by hand meanwhile) needs no move.
      if (subject.stateCode !== move.toStateCode) {
        await this.#deps.states.transition(
          instance.entityType,
          instance.entityId,
          { toCode: move.toStateCode, note: `Workflow ${definition.key} ${outcome}` },
          { byWorkflow: true },
        );
        await this.#log(done, 'state_moved', { detail: { toCode: move.toStateCode } });
      }
    }
    this.#announce(done, 'workflow.completed', {
      ...this.#about(done, definition),
      outcome,
      starterId: done.startedBy,
    });
    return done;
  }

  /* ----------------------------------------------------------------------------------
   * Task actions
   * -------------------------------------------------------------------------------- */

  /** Locks the instance (step 4) and returns it with its definition and graph. */
  async #lock(instanceId: string) {
    const { db } = currentUnit();
    await db.$queryRaw`SELECT id FROM cfg.workflow_instance WHERE id = ${instanceId}::uuid FOR UPDATE`;
    const instance = await db.workflowInstance.findFirst({
      where: { id: instanceId, deletedAt: null },
    });
    if (instance === null) throw new NotFoundError('No such workflow.');
    const definition = await db.workflowDefinition.findFirstOrThrow({
      where: { id: instance.workflowDefinitionId },
    });
    const version = await db.workflowVersion.findFirstOrThrow({
      where: { id: instance.workflowVersionId },
    });
    return { instance, definition, graph: workflowGraphSchema.parse(version.graph) };
  }

  /** Role ids the user holds in the company. */
  async #rolesOf(userId: string, companyId: string): Promise<string[]> {
    const rows = await currentUnit().db.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT mr.role_id::text AS id
        FROM iam.membership_role mr
        JOIN iam.company_membership m ON m.id = mr.membership_id
       WHERE m.user_id = ${userId}::uuid AND m.company_id = ${companyId}::uuid
         AND m.deleted_at IS NULL`;
    return rows.map((r) => r.id);
  }

  /** Users who delegated to `userId` today (for the inbox and for acting on their tasks). */
  async #delegatorsOf(userId: string): Promise<{ userId: string; scope: unknown }[]> {
    const today = toDay(isoDay(this.#now()));
    const rows = await currentUnit().db.workflowDelegation.findMany({
      where: {
        delegateUserId: userId,
        deletedAt: null,
        validFrom: { lte: today },
        validTo: { gte: today },
      },
      select: { userId: true, scope: true },
    });
    return rows;
  }

  /** Whether the current user may act on the task (assignee, role holder or delegate). */
  async #mayAct(task: WorkflowTaskRow, definitionKey: string): Promise<boolean> {
    const me = currentUnit().context.userId;
    if (me === undefined) return false;
    if (task.assigneeUserId === me) return true;
    if (task.assigneeRoleId !== null) {
      return (await this.#rolesOf(me, task.companyId)).includes(task.assigneeRoleId);
    }
    for (const d of await this.#delegatorsOf(me)) {
      if (d.userId !== task.assigneeUserId) continue;
      const keys = (d.scope as { definitionKeys?: unknown }).definitionKeys;
      if (!Array.isArray(keys) || keys.length === 0 || keys.includes(definitionKey)) return true;
    }
    return false;
  }

  /** Applies one action to an open task (steps 4 to 7 of the header). */
  async act(taskId: string, action: TaskAction, input: TaskActionInput): Promise<WorkflowTaskRow> {
    const { db, context } = currentUnit();
    const me = context.userId;
    if (me === undefined) throw new ForbiddenError('Only a person can act on a workflow task.');
    const found = await db.workflowTask.findFirst({ where: { id: taskId, deletedAt: null } });
    if (found === null) throw new NotFoundError('No such task.');
    const { instance, definition, graph } = await this.#lock(found.instanceId);
    // Read again under the lock: someone may have acted while we waited.
    const task = await db.workflowTask.findFirstOrThrow({ where: { id: taskId } });
    if (task.status !== 'open' || instance.status !== 'running') {
      throw new ConflictError('task_closed', 'This task is no longer open.', {
        status: task.status,
      });
    }
    const located = locate(graph, task.stepKey);
    if (located === null) throw new Error(`Step "${task.stepKey}" is not in the workflow version`);
    const mayAct = await this.#mayAct(task, definition.key);
    if (action === 'delegate') {
      return this.#delegate(task, instance, definition, located.step, mayAct, input);
    }
    if (!mayAct) throw new ForbiddenError('This task is not yours.');

    if (action === 'comment') {
      await this.#log(instance, 'commented', {
        stepKey: task.stepKey,
        taskId,
        detail: { comment: input.comment ?? '' },
      });
      return task;
    }
    if (action === 'approve' && instance.startedBy === me && !located.step.allowSelfApproval) {
      throw new ForbiddenError('You started this workflow; someone else must approve it.');
    }
    // One person, one vote per step round. A stand-in may hold their own task and the task of
    // someone who delegated to them (a delegation made after the tasks were created, or a task
    // passed on). Approving both would let one person satisfy an "all" quorum alone.
    if (action === 'approve') {
      const already = await db.workflowTask.count({
        where: {
          instanceId: instance.id,
          stepKey: task.stepKey,
          activationNo: task.activationNo,
          actedBy: me,
          action: 'approve',
          id: { not: taskId },
        },
      });
      if (already > 0) {
        throw new ForbiddenError('You have already approved this step; someone else must.');
      }
    }
    const closed = await db.workflowTask.update({
      where: { id: taskId },
      data: {
        status: 'done',
        action,
        actedBy: me,
        actedAt: this.#now(),
        comment: input.comment ?? null,
        payload: (input.payload ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    const eventKind =
      action === 'approve' ? 'approved' : action === 'reject' ? 'rejected_task' : 'sent_back';
    await this.#log(instance, eventKind, {
      stepKey: task.stepKey,
      taskId,
      detail: { comment: input.comment ?? null, payload: input.payload ?? null },
    });

    if (action === 'reject') {
      await this.#complete(instance, definition, graph, 'rejected');
      return closed;
    }
    if (action === 'send_back') {
      // Step 6: the previous approval stage, opened again as a new round.
      let back = instance.stepIndex - 1;
      while (back >= 0) {
        const kind = graph.steps[back]?.kind;
        if (kind === 'approval' || kind === 'parallel_group') break;
        back -= 1;
      }
      if (back < 0) {
        throw new UnprocessableError(
          'workflow_nothing_to_send_back',
          'This is the first approval; it can only be approved or rejected.',
        );
      }
      await db.workflowTask.updateMany({
        where: { instanceId: instance.id, status: 'open' },
        data: { status: 'skipped' },
      });
      await this.#activate(instance, definition, graph, back, null);
      return closed;
    }

    // Step 5: approve.
    const round = (key: string) =>
      db.workflowTask.findMany({
        where: { instanceId: instance.id, stepKey: key, activationNo: instance.activationNo },
        select: { status: true, action: true },
      });
    const reached = (step: ApprovalStep, tasks: QuorumTask[]) => quorumReached(step.quorum, tasks);
    if (!reached(located.step, (await round(task.stepKey)) as QuorumTask[])) return closed;
    await db.workflowTask.updateMany({
      where: {
        instanceId: instance.id,
        stepKey: task.stepKey,
        activationNo: instance.activationNo,
        status: 'open',
      },
      data: { status: 'skipped' },
    });
    await this.#log(instance, 'step_completed', { stepKey: task.stepKey });
    if (located.group !== null) {
      for (const branch of located.group.branches) {
        if (branch.key === task.stepKey) continue;
        if (!reached(branch, (await round(branch.key)) as QuorumTask[])) return closed;
      }
      await this.#log(instance, 'step_completed', { stepKey: located.group.key });
    }
    await this.#advance(instance, definition, graph, located.index + 1, null);
    return closed;
  }

  async #delegate(
    task: WorkflowTaskRow,
    instance: WorkflowInstanceRow,
    definition: WorkflowDefinitionRow,
    step: ApprovalStep,
    mayAct: boolean,
    input: TaskActionInput,
  ): Promise<WorkflowTaskRow> {
    const { db, context } = currentUnit();
    if (!mayAct) await this.#deps.permissions.require('platform.workflow_task.reassign');
    if (task.assigneeUserId === null) {
      throw new UnprocessableError(
        'task_for_role',
        'A task for a role is taken by anyone holding it; it cannot be passed on.',
      );
    }
    const to = input.toUserId;
    if (to === undefined || to === task.assigneeUserId) {
      throw new ValidationError([
        { path: 'toUserId', code: 'invalid', message: 'Choose someone else.' },
      ]);
    }
    if ((await this.#members([to], task.companyId)).length === 0) {
      throw new ValidationError([
        {
          path: 'toUserId',
          code: 'unknown_user',
          message: 'This person cannot act in this company.',
        },
      ]);
    }
    // Not to someone who already holds or answered a task of this step round: they would get
    // two votes (and `act` refuses their second approval, so the task would be stuck).
    const holds = await db.workflowTask.count({
      where: {
        instanceId: instance.id,
        stepKey: task.stepKey,
        activationNo: task.activationNo,
        id: { not: task.id },
        OR: [{ assigneeUserId: to, status: 'open' }, { actedBy: to }],
      },
    });
    if (holds > 0) {
      throw new ValidationError([
        {
          path: 'toUserId',
          code: 'already_on_step',
          message: 'This person already has a task on this step.',
        },
      ]);
    }
    const moved = await db.workflowTask.update({
      where: { id: task.id },
      data: { assigneeUserId: to, delegatedFromUserId: task.assigneeUserId },
    });
    await this.#log(instance, 'delegated', {
      stepKey: task.stepKey,
      taskId: task.id,
      detail: {
        fromUserId: task.assigneeUserId,
        toUserId: to,
        by: context.userId ?? null,
        comment: input.comment ?? null,
      },
    });
    this.#announce(instance, 'workflow.task_assigned', {
      ...this.#about(instance, definition),
      taskId: task.id,
      stepKey: step.key,
      stepName: step.name,
      assigneeId: to,
      roleKey: null,
    });
    return moved;
  }

  /** Stops a running workflow: its starter, or someone with the cancel permission. */
  async cancel(instanceId: string, reason: string): Promise<WorkflowInstanceRow> {
    const { context } = currentUnit();
    const { instance, definition, graph } = await this.#lock(instanceId);
    if (instance.status !== 'running') {
      throw new ConflictError('workflow_finished', 'This workflow has already finished.', {
        status: instance.status,
      });
    }
    if (context.userId === undefined || instance.startedBy !== context.userId) {
      await this.#deps.permissions.require('platform.workflow_instance.cancel');
    }
    await this.#log(instance, 'cancel_reason', { detail: { reason } });
    return this.#complete(instance, definition, graph, 'cancelled');
  }

  /* ----------------------------------------------------------------------------------
   * Reading
   * -------------------------------------------------------------------------------- */

  /** Active people of the session's company (id, name), for the pass-on and stand-in pickers. */
  async people(): Promise<{ id: string; displayName: string }[]> {
    const { db, context } = currentUnit();
    const companyId = context.companyIds[0];
    if (companyId === undefined) return [];
    const rows = await db.$queryRaw<{ id: string; display_name: string }[]>`
      SELECT DISTINCT u.id::text AS id, u.display_name
        FROM iam.user_account u
        JOIN iam.company_membership m ON m.user_id = u.id
       WHERE u.status = 'active' AND u.deleted_at IS NULL
         AND m.company_id = ${companyId}::uuid AND m.deleted_at IS NULL
       ORDER BY u.display_name
       LIMIT 500`;
    return rows.map((r) => ({ id: r.id, displayName: r.display_name }));
  }

  /** The caller's open tasks: theirs, their roles' in the session's companies, and delegated ones. */
  async inbox(): Promise<InboxEntry[]> {
    const { db, context } = currentUnit();
    const me = context.userId;
    if (me === undefined) return [];
    const roleIds = new Set<string>();
    for (const companyId of context.companyIds) {
      for (const id of await this.#rolesOf(me, companyId)) roleIds.add(id);
    }
    const delegators = await this.#delegatorsOf(me);
    const tasks = await db.workflowTask.findMany({
      where: {
        status: 'open',
        deletedAt: null,
        OR: [
          { assigneeUserId: me },
          { assigneeRoleId: { in: [...roleIds] } },
          { assigneeUserId: { in: delegators.map((d) => d.userId) } },
        ],
      },
      orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      take: 500,
    });
    const out: InboxEntry[] = [];
    for (const task of tasks) {
      const instance = await db.workflowInstance.findFirstOrThrow({
        where: { id: task.instanceId },
      });
      const definition = await db.workflowDefinition.findFirstOrThrow({
        where: { id: instance.workflowDefinitionId },
      });
      const version = await db.workflowVersion.findFirstOrThrow({
        where: { id: instance.workflowVersionId },
      });
      const graph = workflowGraphSchema.parse(version.graph);
      // A delegated task outside the delegation's scope is not shown.
      if (task.assigneeUserId !== me && task.assigneeUserId !== null) {
        if (!(await this.#mayAct(task, definition.key))) continue;
      }
      out.push({
        task,
        instance,
        definition,
        stepName: locate(graph, task.stepKey)?.step.name ?? task.stepKey,
      });
    }
    return out;
  }

  /** An instance with its tasks and timeline: for those who can see the record, or took part. */
  async view(instanceId: string): Promise<InstanceView> {
    const { db, context } = currentUnit();
    const instance = await db.workflowInstance.findFirst({
      where: { id: instanceId, deletedAt: null },
    });
    if (instance === null) throw new NotFoundError('No such workflow.');
    const tasks = await db.workflowTask.findMany({ where: { instanceId }, orderBy: { id: 'asc' } });
    const me = context.userId;
    const tookPart =
      me !== undefined &&
      (instance.startedBy === me ||
        tasks.some(
          (t) => t.assigneeUserId === me || t.actedBy === me || t.delegatedFromUserId === me,
        ));
    if (!tookPart) {
      const subject = await this.#deps.targets.for(instance.entityType).load(instance.entityId);
      await this.#deps.permissions.require(subject.readPermission);
    }
    const definition = await db.workflowDefinition.findFirstOrThrow({
      where: { id: instance.workflowDefinitionId },
    });
    const events = await db.workflowEvent.findMany({
      where: { instanceId },
      orderBy: { id: 'asc' },
    });
    return { instance, definition, tasks, events };
  }

  /** The workflows of one record, newest first (needs the record's read permission). */
  async forRecord(entityType: string, entityId: string): Promise<WorkflowInstanceRow[]> {
    const subject = await this.#deps.targets.for(entityType).load(entityId);
    await this.#deps.permissions.require(subject.readPermission);
    return currentUnit().db.workflowInstance.findMany({
      where: { entityType, entityId, deletedAt: null },
      orderBy: { id: 'desc' },
    });
  }

  /* ----------------------------------------------------------------------------------
   * SLA (step 8)
   * -------------------------------------------------------------------------------- */

  /**
   * Reminders and escalations for every tenant. Runs outside a request: finds the
   * (tenant, company) pairs with something due through `cfg.workflow_sla_due()`, then
   * works each pair in its own unit of work under row-level security.
   */
  async sweep(prisma: PrismaDb, uow: UnitOfWork): Promise<{ reminded: number; escalated: number }> {
    const pairs = await prisma.$queryRaw<{ tenant_id: string; company_id: string }[]>`
      SELECT tenant_id::text AS tenant_id, company_id::text AS company_id FROM cfg.workflow_sla_due()`;
    const totals = { reminded: 0, escalated: 0 };
    for (const pair of pairs) {
      try {
        const done = await uow.runAs(
          { tenantId: pair.tenant_id, companyIds: [pair.company_id] },
          () => this.#slaFor(),
        );
        totals.reminded += done.reminded;
        totals.escalated += done.escalated;
      } catch (err) {
        // One company's failure (for example nobody to escalate to) must not stop the others.
        this.#deps.logger?.error(
          { err, tenantId: pair.tenant_id, companyId: pair.company_id },
          'workflow SLA failed',
        );
      }
    }
    return totals;
  }

  async #slaFor(): Promise<{ reminded: number; escalated: number }> {
    const { db } = currentUnit();
    const now = this.#now();
    let reminded = 0;
    let escalated = 0;
    const toRemind = await db.workflowTask.findMany({
      where: { status: 'open', deletedAt: null, remindedAt: null, reminderAt: { lte: now } },
    });
    for (const task of toRemind) {
      const instance = await db.workflowInstance.findFirstOrThrow({
        where: { id: task.instanceId },
      });
      const definition = await db.workflowDefinition.findFirstOrThrow({
        where: { id: instance.workflowDefinitionId },
      });
      await db.workflowTask.update({ where: { id: task.id }, data: { remindedAt: now } });
      await this.#log(instance, 'reminded', { stepKey: task.stepKey, taskId: task.id });
      this.#announce(instance, 'workflow.task_reminder', {
        ...this.#about(instance, definition),
        taskId: task.id,
        stepKey: task.stepKey,
        assigneeId: task.assigneeUserId,
        dueAt: task.dueAt?.toISOString() ?? null,
      });
      reminded += 1;
    }
    const overdue = await db.workflowTask.findMany({
      where: { status: 'open', deletedAt: null, escalatedAt: null, dueAt: { lte: now } },
    });
    for (const late of overdue) {
      const { instance, definition, graph } = await this.#lock(late.instanceId);
      const task = await db.workflowTask.findFirstOrThrow({ where: { id: late.id } });
      if (task.status !== 'open' || task.escalatedAt !== null) continue;
      const step = locate(graph, task.stepKey)?.step;
      const targets =
        step?.escalateTo === undefined
          ? []
          : await this.#resolve(step.escalateTo, null, task.companyId, definition.key);
      if (step === undefined || targets.length === 0) {
        await db.workflowTask.update({ where: { id: task.id }, data: { escalatedAt: now } });
        await this.#log(instance, 'overdue', { stepKey: task.stepKey, taskId: task.id });
        this.#announce(instance, 'workflow.task_overdue', {
          ...this.#about(instance, definition),
          taskId: task.id,
          stepKey: task.stepKey,
          assigneeId: task.assigneeUserId,
        });
      } else {
        await db.workflowTask.update({
          where: { id: task.id },
          data: { escalatedAt: now, status: 'expired' },
        });
        await this.#log(instance, 'escalated', { stepKey: task.stepKey, taskId: task.id });
        for (const target of targets) {
          const opened = await this.#openTask(
            instance,
            definition,
            step,
            task.activationNo,
            target,
            task.id,
          );
          this.#announce(instance, 'workflow.task_escalated', {
            ...this.#about(instance, definition),
            taskId: opened.id,
            stepKey: step.key,
            stepName: step.name,
            assigneeId: opened.assigneeUserId,
            roleKey: target.roleKey ?? null,
            escalatedFromTaskId: task.id,
          });
        }
      }
      escalated += 1;
    }
    return { reminded, escalated };
  }

  /* ----------------------------------------------------------------------------------
   * Timeline and announcements
   * -------------------------------------------------------------------------------- */

  async #log(
    instance: WorkflowInstanceRow,
    kind: string,
    extra: { stepKey?: string; taskId?: string; detail?: Record<string, unknown> },
  ): Promise<void> {
    const { db, context } = currentUnit();
    await db.workflowEvent.create({
      data: {
        tenantId: context.tenantId,
        companyId: instance.companyId,
        instanceId: instance.id,
        kind,
        stepKey: extra.stepKey ?? null,
        taskId: extra.taskId ?? null,
        actorId: context.userId ?? null,
        detail: (extra.detail ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  #about(instance: WorkflowInstanceRow, definition: WorkflowDefinitionRow) {
    return {
      instanceId: instance.id,
      definitionKey: definition.key,
      definitionName: definition.name,
      entityType: instance.entityType,
      entityId: instance.entityId,
    };
  }

  /** Step 9 of the header: queued until the transaction commits. */
  #announce(
    instance: WorkflowInstanceRow,
    eventType: string,
    payload: Record<string, unknown>,
  ): void {
    const sink = this.#deps.events;
    if (sink === undefined) return;
    const { context, afterCommit } = currentUnit();
    const event = { tenantId: context.tenantId, companyId: instance.companyId, eventType, payload };
    afterCommit(async () => {
      try {
        await sink.emit(event);
      } catch (err) {
        this.#deps.logger?.error({ err, eventType }, 'workflow notification failed');
      }
    });
  }
}
