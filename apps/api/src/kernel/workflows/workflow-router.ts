/**
 * Workflow API (phase 2 plan row 2.11a; PLAN 5.9 "Workflow").
 *
 *   /workflow-definitions                       CRUD: key, name, entity type, active/inactive
 *   /workflow-versions                          CRUD of drafts: the graph (steps); filter workflowDefinitionId
 *   POST /workflow-definitions/{id}/versions/publish   publish the newest draft
 *   /workflow-bindings                          CRUD: start on create, on a move into a state, or by hand
 *   /delegations                                CRUD: someone stands in for someone else between two dates
 *   GET  /tasks                                 my open tasks (inbox)
 *   POST /tasks/{id}/approve | reject | send-back | comment | delegate
 *   POST /workflow-instances                    start a workflow by hand (needs a manual binding)
 *   GET  /workflow-instances?entityType=&entityId=   the workflows of a record
 *   GET  /workflow-instances/{id}               one workflow with its tasks and timeline
 *   POST /workflow-instances/{id}/cancel        stop it (its starter, or the cancel permission)
 *
 * Rules of the configuration, and why:
 *   1. A definition's key and entity type never change: instances and bindings hold them.
 *   2. Only a draft version can be edited or deleted; a published or retired one is the
 *      record of what instances ran on. Its graph is checked on every save, and again when
 *      published (the data it names may have changed).
 *   3. A binding takes its entity type from its workflow. "On transition" names a state of
 *      that type's machine; a condition is a formula that gives true or false.
 *   4. A definition with running instances or live bindings is not deleted.
 *
 * The walk of a workflow and the task rules are in ./workflow-service.ts.
 *
 * Depends on: express, zod, @fibrex/shared (workflow schemas), kernel/db, kernel/http,
 * kernel/permissions, ./workflow-service.
 * Used by: src/main.ts, the recycle bin.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  stateCodeSchema,
  stateEntityKeySchema,
  taskApproveSchema,
  taskCommentSchema,
  taskDelegateSchema,
  workflowEntityKeySchema,
  workflowKeySchema,
  workflowTriggerSchema,
} from '@fibrex/shared';
import { formulaKeySchema } from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import { createRepository, type Repository } from '../db/repository.js';
import { currentUnit, type UnitOfWork } from '../db/unit-of-work.js';
import { createCrudRouter } from '../http/crud-router.js';
import { ConflictError, ForbiddenError, ValidationError } from '../http/errors.js';
import { problemSchema, registerRoute } from '../http/openapi.js';
import type { PermissionService } from '../permissions/permission-service.js';
import type {
  TaskAction,
  WorkflowBindingRow,
  WorkflowDefinitionRow,
  WorkflowDelegationRow,
  WorkflowEventRow,
  WorkflowInstanceRow,
  WorkflowService,
  WorkflowTaskRow,
  WorkflowVersionRow,
} from './workflow-service.js';

const stamps = {
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
};
const rowStamps = (row: {
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}) => ({
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  deletedAt: row.deletedAt?.toISOString() ?? null,
});
const iso = (d: Date | null) => d?.toISOString() ?? null;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDay = (text: string) => new Date(`${text}T00:00:00.000Z`);
const invalid = (path: string, message: string, code: string) =>
  new ValidationError([{ path, message, code }]);

/* -------------------------------- definitions -------------------------------- */

const statusSchema = z.enum(['active', 'inactive']);
const definitionCreate = z.strictObject({
  key: workflowKeySchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().default(null),
  entityKey: workflowEntityKeySchema,
  status: statusSchema.default('active'),
});
const definitionUpdate = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).nullable(),
    status: statusSchema,
  })
  .partial();
const definitionItem = z
  .object({
    id: z.uuid(),
    key: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    entityKey: z.string(),
    status: statusSchema,
    ...stamps,
  })
  .meta({ id: 'WorkflowDefinition' });
const definitionFilter = z.object({
  entityKey: stateEntityKeySchema.optional(),
  status: statusSchema.optional(),
});

export function toDefinitionItem(row: WorkflowDefinitionRow) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    entityKey: row.entityKey,
    status: row.status as 'active' | 'inactive',
    ...rowStamps(row),
  };
}

/** The repository behind `/workflow-definitions` and the recycle bin; adds rule 4. */
export function createWorkflowDefinitionRepository(): Repository<WorkflowDefinitionRow> {
  const base = createRepository<WorkflowDefinitionRow>({
    model: 'workflowDefinition',
    scope: 'tenant',
  });
  return {
    ...base,
    softDelete: async (id, version, reason) => {
      const { db } = currentUnit();
      const running = await db.workflowInstance.count({
        where: { workflowDefinitionId: id, status: 'running', deletedAt: null },
      });
      const bindings = await db.workflowBinding.count({
        where: { workflowDefinitionId: id, deletedAt: null },
      });
      if (running > 0 || bindings > 0) {
        throw new ConflictError(
          'workflow_in_use',
          'Finish its running workflows and delete its bindings first.',
          { running, bindings },
        );
      }
      return base.softDelete(id, version, reason);
    },
  };
}

/* -------------------------------- versions -------------------------------- */

const versionCreate = z.strictObject({ workflowDefinitionId: z.uuid(), graph: z.unknown() });
const versionUpdate = z.strictObject({ graph: z.unknown() }).partial();
const versionItem = z
  .object({
    id: z.uuid(),
    workflowDefinitionId: z.uuid(),
    versionNo: z.number().int(),
    graph: z.unknown(),
    status: z.enum(['draft', 'published', 'retired']),
    publishedAt: z.iso.datetime().nullable(),
    publishedBy: z.uuid().nullable(),
    ...stamps,
  })
  .meta({ id: 'WorkflowVersion' });
const versionFilter = z.object({ workflowDefinitionId: z.uuid().optional() });

export function toVersionItem(row: WorkflowVersionRow) {
  return {
    id: row.id,
    workflowDefinitionId: row.workflowDefinitionId,
    versionNo: row.versionNo,
    graph: row.graph,
    status: row.status as 'draft' | 'published' | 'retired',
    publishedAt: iso(row.publishedAt),
    publishedBy: row.publishedBy,
    ...rowStamps(row),
  };
}

async function liveDefinition(id: string): Promise<WorkflowDefinitionRow> {
  const definition = await currentUnit().db.workflowDefinition.findFirst({
    where: { id, deletedAt: null },
  });
  if (definition === null) {
    throw invalid('workflowDefinitionId', 'This workflow does not exist.', 'unknown_workflow');
  }
  return definition;
}

/** The repository behind `/workflow-versions`; adds rule 2. */
export function createWorkflowVersionRepository(
  service: Pick<WorkflowService, 'checkGraph'>,
): Repository<WorkflowVersionRow> {
  const base = createRepository<WorkflowVersionRow>({ model: 'workflowVersion', scope: 'tenant' });
  const draftOnly = async (id: string) => {
    const current = await base.get(id);
    if (current.status !== 'draft') {
      throw new ConflictError(
        'workflow_version_frozen',
        'A published version cannot be changed; make a new draft.',
      );
    }
    return current;
  };
  return {
    ...base,
    create: async (data) => {
      const body = data as z.infer<typeof versionCreate>;
      const definition = await liveDefinition(body.workflowDefinitionId);
      const graph = await service.checkGraph(definition.entityKey, body.graph);
      const last = await currentUnit().db.workflowVersion.findFirst({
        where: { workflowDefinitionId: definition.id },
        orderBy: { versionNo: 'desc' },
        select: { versionNo: true },
      });
      return base.create({
        workflowDefinitionId: definition.id,
        versionNo: (last?.versionNo ?? 0) + 1,
        graph,
      });
    },
    update: async (id, version, changes) => {
      const body = changes as z.infer<typeof versionUpdate>;
      const current = await draftOnly(id);
      if (body.graph === undefined) return base.update(id, version, {});
      const definition = await liveDefinition(current.workflowDefinitionId);
      const graph = await service.checkGraph(definition.entityKey, body.graph);
      return base.update(id, version, { graph });
    },
    softDelete: async (id, version, reason) => {
      await draftOnly(id);
      return base.softDelete(id, version, reason);
    },
  };
}

/* -------------------------------- bindings -------------------------------- */

const bindingCreate = z.strictObject({
  workflowDefinitionId: z.uuid(),
  trigger: workflowTriggerSchema,
  toStateCode: stateCodeSchema.nullable().default(null),
  conditionFormulaKey: formulaKeySchema.nullable().default(null),
  active: z.boolean().default(true),
});
const bindingUpdate = z
  .strictObject({ conditionFormulaKey: formulaKeySchema.nullable(), active: z.boolean() })
  .partial();
const bindingItem = z
  .object({
    id: z.uuid(),
    entityKey: z.string(),
    trigger: workflowTriggerSchema,
    toStateCode: z.string().nullable(),
    workflowDefinitionId: z.uuid(),
    conditionFormulaKey: z.string().nullable(),
    active: z.boolean(),
    ...stamps,
  })
  .meta({ id: 'WorkflowBinding' });
const bindingFilter = z.object({
  entityKey: stateEntityKeySchema.optional(),
  workflowDefinitionId: z.uuid().optional(),
});

export function toBindingItem(row: WorkflowBindingRow) {
  return {
    id: row.id,
    entityKey: row.entityKey,
    trigger: row.trigger as z.infer<typeof workflowTriggerSchema>,
    toStateCode: row.toStateCode,
    workflowDefinitionId: row.workflowDefinitionId,
    conditionFormulaKey: row.conditionFormulaKey,
    active: row.active,
    ...rowStamps(row),
  };
}

/** The repository behind `/workflow-bindings`; adds rule 3. */
export function createWorkflowBindingRepository(
  service: Pick<WorkflowService, 'checkBindingFormula'>,
): Repository<WorkflowBindingRow> {
  const base = createRepository<WorkflowBindingRow>({ model: 'workflowBinding', scope: 'tenant' });
  return {
    ...base,
    create: async (data) => {
      const body = data as z.infer<typeof bindingCreate>;
      const definition = await liveDefinition(body.workflowDefinitionId);
      if ((body.trigger === 'on_transition') !== (body.toStateCode !== null)) {
        throw invalid(
          'toStateCode',
          'Name the state for "on_transition", and only then.',
          'invalid',
        );
      }
      if (body.toStateCode !== null) {
        const state = await currentUnit().db.state.findFirst({
          where: {
            code: body.toStateCode,
            deletedAt: null,
            machine: { entityKey: definition.entityKey, deletedAt: null },
          },
          select: { id: true },
        });
        if (state === null) {
          throw invalid(
            'toStateCode',
            `"${definition.entityKey}" has no state "${body.toStateCode}".`,
            'unknown_state',
          );
        }
      }
      if (body.conditionFormulaKey !== null)
        await service.checkBindingFormula(body.conditionFormulaKey);
      return base.create({ ...body, entityKey: definition.entityKey });
    },
    update: async (id, version, changes) => {
      const body = changes as z.infer<typeof bindingUpdate>;
      if (typeof body.conditionFormulaKey === 'string') {
        await service.checkBindingFormula(body.conditionFormulaKey);
      }
      return base.update(id, version, body);
    },
  };
}

/* -------------------------------- delegations -------------------------------- */

const delegationScope = z.strictObject({
  definitionKeys: z.array(workflowKeySchema).max(50).optional(),
});
const delegationCreate = z.strictObject({
  userId: z.uuid(),
  delegateUserId: z.uuid(),
  validFrom: z.iso.date(),
  validTo: z.iso.date(),
  scope: delegationScope.default({}),
  note: z.string().max(2000).nullable().default(null),
});
const delegationUpdate = z
  .strictObject({
    validFrom: z.iso.date(),
    validTo: z.iso.date(),
    scope: delegationScope,
    note: z.string().max(2000).nullable(),
  })
  .partial();
const delegationItem = z
  .object({
    id: z.uuid(),
    userId: z.uuid(),
    delegateUserId: z.uuid(),
    validFrom: z.iso.date(),
    validTo: z.iso.date(),
    scope: delegationScope,
    note: z.string().nullable(),
    ...stamps,
  })
  .meta({ id: 'WorkflowDelegation' });
const delegationFilter = z.object({
  userId: z.uuid().optional(),
  delegateUserId: z.uuid().optional(),
});

export function toDelegationItem(row: WorkflowDelegationRow) {
  return {
    id: row.id,
    userId: row.userId,
    delegateUserId: row.delegateUserId,
    validFrom: isoDay(row.validFrom),
    validTo: isoDay(row.validTo),
    scope: row.scope as z.infer<typeof delegationScope>,
    note: row.note,
    ...rowStamps(row),
  };
}

/**
 * The repository behind `/delegations`: dates in order, two different people, and the stand-in
 * works in the session's company. With `permissions` (the API router) a person without
 * `platform.workflow_delegation.manage_all` sees the delegations they gave or received, and
 * creates, changes or deletes only their own (self-service: nobody else's tasks can be
 * redirected by an ordinary user). Without it (the recycle bin) no extra rule applies.
 */
export function createWorkflowDelegationRepository(
  permissions?: Pick<PermissionService, 'current'>,
): Repository<WorkflowDelegationRow> {
  const base = createRepository<WorkflowDelegationRow>({
    model: 'workflowDelegation',
    scope: 'tenant',
  });
  const checkDates = (from: string, to: string) => {
    if (to < from) throw invalid('validTo', 'The end is before the start.', 'invalid');
  };
  /** Who the caller is, and whether they may manage everyone's delegations. */
  const caller = async (): Promise<{ me: string | undefined; all: boolean }> => {
    if (permissions === undefined) return { me: undefined, all: true };
    const access = await permissions.current();
    return {
      me: access.userId,
      all: access.permissions.includes('platform.workflow_delegation.manage_all'),
    };
  };
  /** Rule: only the person who delegates may change or delete it (403 for anyone else). */
  const ownOnly = async (id: string): Promise<void> => {
    const { me, all } = await caller();
    if (all) return;
    const current = await base.get(id);
    if (current.userId !== me)
      throw new ForbiddenError('You can only change your own delegations.');
  };
  const checkMember = async (userId: string): Promise<void> => {
    const { db, context } = currentUnit();
    const companyId = context.companyIds[0];
    if (companyId === undefined) return;
    const found = await db.$queryRaw<{ id: string }[]>`
      SELECT u.id::text AS id
        FROM iam.user_account u
        JOIN iam.company_membership m ON m.user_id = u.id
       WHERE u.id = ${userId}::uuid AND u.status = 'active' AND u.deleted_at IS NULL
         AND m.company_id = ${companyId}::uuid AND m.deleted_at IS NULL
       LIMIT 1`;
    if (found.length === 0) {
      throw invalid('delegateUserId', 'This person cannot act in this company.', 'unknown_user');
    }
  };
  return {
    ...base,
    list: async (options) => {
      const { me, all } = await caller();
      if (all) return base.list(options);
      return base.list({
        ...options,
        where: {
          AND: [options.where ?? {}, { OR: [{ userId: me }, { delegateUserId: me }] }],
        },
      });
    },
    softDelete: async (id, version, reason) => {
      await ownOnly(id);
      return base.softDelete(id, version, reason);
    },
    create: async (data) => {
      const body = data as z.infer<typeof delegationCreate>;
      const { me, all } = await caller();
      if (!all && body.userId !== me) {
        throw new ForbiddenError('You can only delegate your own tasks.');
      }
      if (body.userId === body.delegateUserId) {
        throw invalid('delegateUserId', 'Someone cannot stand in for themselves.', 'invalid');
      }
      checkDates(body.validFrom, body.validTo);
      if (permissions !== undefined) await checkMember(body.delegateUserId);
      return base.create({
        ...body,
        validFrom: toDay(body.validFrom),
        validTo: toDay(body.validTo),
      });
    },
    update: async (id, version, changes) => {
      const body = changes as z.infer<typeof delegationUpdate>;
      await ownOnly(id);
      const current = await base.get(id);
      checkDates(
        body.validFrom ?? isoDay(current.validFrom),
        body.validTo ?? isoDay(current.validTo),
      );
      return base.update(id, version, {
        ...body,
        ...(body.validFrom === undefined ? {} : { validFrom: toDay(body.validFrom) }),
        ...(body.validTo === undefined ? {} : { validTo: toDay(body.validTo) }),
      });
    },
  };
}

/* -------------------------------- runtime -------------------------------- */

const taskItem = z
  .object({
    id: z.uuid(),
    instanceId: z.uuid(),
    stepKey: z.string(),
    activationNo: z.number().int(),
    assigneeUserId: z.uuid().nullable(),
    assigneeRoleId: z.uuid().nullable(),
    status: z.enum(['open', 'done', 'skipped', 'expired']),
    dueAt: z.iso.datetime().nullable(),
    reminderAt: z.iso.datetime().nullable(),
    remindedAt: z.iso.datetime().nullable(),
    escalatedAt: z.iso.datetime().nullable(),
    escalatedFromTaskId: z.uuid().nullable(),
    actedBy: z.uuid().nullable(),
    actedAt: z.iso.datetime().nullable(),
    action: z.enum(['approve', 'reject', 'send_back']).nullable(),
    comment: z.string().nullable(),
    delegatedFromUserId: z.uuid().nullable(),
    payload: z.unknown().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'WorkflowTask' });

export function toTaskItem(row: WorkflowTaskRow) {
  return {
    id: row.id,
    instanceId: row.instanceId,
    stepKey: row.stepKey,
    activationNo: row.activationNo,
    assigneeUserId: row.assigneeUserId,
    assigneeRoleId: row.assigneeRoleId,
    status: row.status as 'open' | 'done' | 'skipped' | 'expired',
    dueAt: iso(row.dueAt),
    reminderAt: iso(row.reminderAt),
    remindedAt: iso(row.remindedAt),
    escalatedAt: iso(row.escalatedAt),
    escalatedFromTaskId: row.escalatedFromTaskId,
    actedBy: row.actedBy,
    actedAt: iso(row.actedAt),
    action: row.action as 'approve' | 'reject' | 'send_back' | null,
    comment: row.comment,
    delegatedFromUserId: row.delegatedFromUserId,
    payload: row.payload ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

const instanceItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    workflowDefinitionId: z.uuid(),
    workflowVersionId: z.uuid(),
    entityType: z.string(),
    entityId: z.uuid(),
    trigger: workflowTriggerSchema,
    status: z.enum(['running', 'approved', 'rejected', 'cancelled']),
    startedBy: z.uuid().nullable(),
    currentStepKeys: z.array(z.string()),
    completedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    version: z.number().int(),
  })
  .meta({ id: 'WorkflowInstance' });

export function toInstanceItem(row: WorkflowInstanceRow) {
  return {
    id: row.id,
    companyId: row.companyId,
    workflowDefinitionId: row.workflowDefinitionId,
    workflowVersionId: row.workflowVersionId,
    entityType: row.entityType,
    entityId: row.entityId,
    trigger: row.trigger as z.infer<typeof workflowTriggerSchema>,
    status: row.status as 'running' | 'approved' | 'rejected' | 'cancelled',
    startedBy: row.startedBy,
    currentStepKeys: row.currentStepKeys,
    completedAt: iso(row.completedAt),
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

const eventItem = z
  .object({
    id: z.uuid(),
    kind: z.string(),
    stepKey: z.string().nullable(),
    taskId: z.uuid().nullable(),
    actorId: z.uuid().nullable(),
    detail: z.record(z.string(), z.unknown()),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'WorkflowEvent' });

const toEventItem = (row: WorkflowEventRow) => ({
  id: row.id,
  kind: row.kind,
  stepKey: row.stepKey,
  taskId: row.taskId,
  actorId: row.actorId,
  detail: row.detail as Record<string, unknown>,
  createdAt: row.createdAt.toISOString(),
});

const inboxItem = z
  .object({
    task: taskItem,
    instance: instanceItem,
    definition: z.object({ id: z.uuid(), key: z.string(), name: z.string() }),
    stepName: z.string(),
  })
  .meta({ id: 'WorkflowInboxEntry' });
const inboxList = z.object({ items: z.array(inboxItem) }).meta({ id: 'WorkflowInbox' });
const instanceView = z
  .object({
    instance: instanceItem,
    definition: definitionItem,
    tasks: z.array(taskItem),
    events: z.array(eventItem),
  })
  .meta({ id: 'WorkflowInstanceView' });
const instanceList = z.object({ items: z.array(instanceItem) }).meta({ id: 'WorkflowInstances' });

const idParams = z.object({ id: z.uuid() });
const startBody = z.strictObject({
  definitionKey: workflowKeySchema,
  entityType: stateEntityKeySchema,
  entityId: z.uuid(),
});
const recordQuery = z.object({ entityType: stateEntityKeySchema, entityId: z.uuid() });
const cancelBody = z.strictObject({ reason: z.string().trim().min(1).max(2000) });

/** URL segment → action, with the body each action takes. */
const ACTIONS: {
  path: string;
  action: TaskAction;
  body: z.ZodType<Record<string, unknown>>;
  summary: string;
}[] = [
  { path: 'approve', action: 'approve', body: taskApproveSchema, summary: 'Approve a task' },
  {
    path: 'reject',
    action: 'reject',
    body: taskCommentSchema,
    summary: 'Reject: the workflow ends as rejected',
  },
  {
    path: 'send-back',
    action: 'send_back',
    body: taskCommentSchema,
    summary: 'Send back to the previous approval',
  },
  {
    path: 'comment',
    action: 'comment',
    body: taskCommentSchema,
    summary: 'Comment on a task (it stays open)',
  },
  {
    path: 'delegate',
    action: 'delegate',
    body: taskDelegateSchema,
    summary: 'Pass a task to someone else',
  },
];

export interface WorkflowRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  workflows: WorkflowService;
}

export function createWorkflowRouter(deps: WorkflowRouterDeps): Router {
  const { uow, registry, permissions, workflows } = deps;
  const router = Router();
  const crud = { uow, authorize: permissions.authorize, registry };

  router.post('/workflow-definitions/:id/versions/publish', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const published = await uow.run(async () => {
      await permissions.require('platform.workflow_definition.publish');
      return workflows.publish(id);
    });
    res.json(toVersionItem(published));
  });

  router.get('/tasks', async (_req, res) => {
    const entries = await uow.run(() => workflows.inbox());
    res.json({
      items: entries.map((e) => ({
        task: toTaskItem(e.task),
        instance: toInstanceItem(e.instance),
        definition: { id: e.definition.id, key: e.definition.key, name: e.definition.name },
        stepName: e.stepName,
      })),
    });
  });

  // The people of the session's company, for the "pass to" and "stand-in" pickers. Open to
  // every signed-in person (names only): passing on a task you hold needs no permission.
  router.get('/workflow-people', async (_req, res) => {
    const people = await uow.run(() => workflows.people());
    res.json({ items: people });
  });

  for (const { path, action, body } of ACTIONS) {
    router.post(`/tasks/:id/${path}`, async (req, res) => {
      const { id } = idParams.parse(req.params);
      const input = body.parse(req.body ?? {});
      const task = await uow.run(() => workflows.act(id, action, input));
      res.json(toTaskItem(task));
    });
  }

  router.post('/workflow-instances', async (req, res) => {
    const input = startBody.parse(req.body);
    const instance = await uow.run(() =>
      workflows.startManual(input.definitionKey, input.entityType, input.entityId),
    );
    res.status(201).json(toInstanceItem(instance));
  });

  router.get('/workflow-instances', async (req, res) => {
    const query = recordQuery.parse(req.query);
    const rows = await uow.run(() => workflows.forRecord(query.entityType, query.entityId));
    res.json({ items: rows.map(toInstanceItem) });
  });

  router.get('/workflow-instances/:id', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const view = await uow.run(() => workflows.view(id));
    res.json({
      instance: toInstanceItem(view.instance),
      definition: toDefinitionItem(view.definition),
      tasks: view.tasks.map(toTaskItem),
      events: view.events.map(toEventItem),
    });
  });

  router.post('/workflow-instances/:id/cancel', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { reason } = cancelBody.parse(req.body);
    const instance = await uow.run(() => workflows.cancel(id, reason));
    res.json(toInstanceItem(instance));
  });

  router.use(
    createCrudRouter<WorkflowDefinitionRow>(crud, {
      path: '/workflow-definitions',
      resource: 'platform.workflow_definition',
      tag: 'Workflows',
      repository: createWorkflowDefinitionRepository(),
      schemas: {
        create: definitionCreate,
        update: definitionUpdate,
        item: definitionItem,
        filter: definitionFilter,
      },
      toItem: toDefinitionItem,
      toWhere: (filter) => filter,
    }),
  );
  router.use(
    createCrudRouter<WorkflowVersionRow>(crud, {
      path: '/workflow-versions',
      resource: 'platform.workflow_version',
      tag: 'Workflows',
      repository: createWorkflowVersionRepository(workflows),
      schemas: {
        create: versionCreate,
        update: versionUpdate,
        item: versionItem,
        filter: versionFilter,
      },
      toItem: toVersionItem,
      toWhere: (filter) => filter,
    }),
  );
  router.use(
    createCrudRouter<WorkflowBindingRow>(crud, {
      path: '/workflow-bindings',
      resource: 'platform.workflow_binding',
      tag: 'Workflows',
      repository: createWorkflowBindingRepository(workflows),
      schemas: {
        create: bindingCreate,
        update: bindingUpdate,
        item: bindingItem,
        filter: bindingFilter,
      },
      toItem: toBindingItem,
      toWhere: (filter) => filter,
    }),
  );
  router.use(
    createCrudRouter<WorkflowDelegationRow>(crud, {
      path: '/delegations',
      resource: 'platform.workflow_delegation',
      tag: 'Workflows',
      repository: createWorkflowDelegationRepository(permissions),
      schemas: {
        create: delegationCreate,
        update: delegationUpdate,
        item: delegationItem,
        filter: delegationFilter,
      },
      toItem: toDelegationItem,
      toWhere: (filter) => filter,
    }),
  );

  const tags = ['Workflows'];
  const problem = (description: string) => ({
    description,
    content: { 'application/problem+json': { schema: problemSchema } },
  });
  const json = (description: string, schema: z.ZodType) => ({
    description,
    content: { 'application/json': { schema } },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/workflow-definitions/{id}/versions/publish',
    tags,
    summary: 'Publish the newest draft version (running workflows keep theirs)',
    request: { params: idParams },
    responses: {
      200: json('The published version', versionItem),
      400: problem('The graph names something that does not exist'),
      422: problem('There is no draft'),
    },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/tasks',
    tags,
    summary: 'My open workflow tasks',
    responses: { 200: json('Open tasks, soonest deadline first', inboxList) },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/workflow-people',
    tags,
    summary: 'People of my company who can take workflow tasks (id and name)',
    responses: {
      200: json(
        'People',
        z.object({ items: z.array(z.object({ id: z.uuid(), displayName: z.string() })) }),
      ),
    },
  });
  for (const { path, body, summary } of ACTIONS) {
    registerRoute(registry, {
      method: 'post',
      path: `/tasks/{id}/${path}`,
      tags,
      summary,
      request: { params: idParams, body: { content: { 'application/json': { schema: body } } } },
      responses: {
        200: json('The task after the action', taskItem),
        403: problem('The task is not yours, or you started this workflow'),
        404: problem('No such task'),
        409: problem('The task is no longer open'),
        422: problem('The action is not possible here'),
      },
    });
  }
  registerRoute(registry, {
    method: 'post',
    path: '/workflow-instances',
    tags,
    summary: 'Start a workflow by hand on a record',
    request: { body: { content: { 'application/json': { schema: startBody } } } },
    responses: {
      201: json('The new workflow', instanceItem),
      409: problem('It is already running for this record'),
      422: problem('Not startable by hand on this type, or nobody can approve'),
    },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/workflow-instances',
    tags,
    summary: 'The workflows of one record, newest first',
    request: { query: recordQuery },
    responses: { 200: json('Workflows', instanceList) },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/workflow-instances/{id}',
    tags,
    summary: 'One workflow with its tasks and timeline',
    request: { params: idParams },
    responses: { 200: json('The workflow', instanceView), 404: problem('No such workflow') },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/workflow-instances/{id}/cancel',
    tags,
    summary: 'Stop a running workflow',
    request: {
      params: idParams,
      body: { content: { 'application/json': { schema: cancelBody } } },
    },
    responses: {
      200: json('The stopped workflow', instanceItem),
      403: problem('Only its starter or someone with the cancel permission'),
      409: problem('It has already finished'),
    },
  });

  return router;
}
