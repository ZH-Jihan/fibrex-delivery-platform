/**
 * State machines API (phase 2 plan row 2.10; PLAN 5.9 "State machines").
 *
 *   /state-machines                        CRUD: entity type, name
 *   /states                                CRUD: code, labels, category, first/final; filter stateMachineId
 *   /state-transitions                     CRUD: from, to, permission, required fields, reason; filter stateMachineId
 *   GET  /transitions/{entityType}/{id}    where the record is and the moves it could make
 *   POST /transitions/{entityType}/{id}    move the record (any entity type with a machine)
 *   POST /records/{entityKey}/{id}/transition   the same for a custom record (PLAN 5.9)
 *   GET  /state-history/{entityType}/{id}  the dated history of the record
 *
 * States and transitions are served flat (`?stateMachineId=`), as rate rows and formula
 * versions are, so the one CRUD factory gives them paging, If-Match, audit and recycle bin.
 *
 * Rules of the configuration, and why:
 *   1. A machine's entity type never changes, and a type has one live machine: that is how
 *      a record finds its machine.
 *   2. A state's code never changes (records and history hold it). A machine has at most
 *      one initial state; a state is not both initial and final.
 *   3. Nothing leaves a final state: a transition cannot start at one, and a state with
 *      transitions out cannot be made final.
 *   4. A transition joins two live states of its machine; its ends never change (delete it
 *      and add another), so the history of what was allowed stays readable in the audit.
 *   5. A transition's permission must be a known permission key, its reason list a live
 *      lookup list and its workflow (row 2.11a, started by the move) a live workflow, so a
 *      typing mistake cannot lock a move for everyone.
 *   6. A state that a live transition uses is not deleted, and a machine with live states
 *      is not deleted.
 *
 * The rules of a move itself are in ./state-service.ts.
 *
 * Depends on: express, zod, @fibrex/shared (state schemas), kernel/db, kernel/http,
 * kernel/permissions, ./state-service.
 * Used by: src/main.ts, the recycle bin.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  stateCategorySchema,
  stateCodeSchema,
  stateColourSchema,
  stateEntityKeySchema,
  stateLabelsSchema,
  statePermissionKeySchema,
  stateRequiredFieldsSchema,
  transitionRequestSchema,
} from '@fibrex/shared';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createRepository, type Repository } from '../db/repository.js';
import { currentUnit, type UnitOfWork } from '../db/unit-of-work.js';
import { createCrudRouter } from '../http/crud-router.js';
import { ConflictError, UnprocessableError, ValidationError } from '../http/errors.js';
import { problemSchema, registerRoute } from '../http/openapi.js';
import type { PermissionService } from '../permissions/permission-service.js';
import type {
  StateHistoryRecord,
  StateMachineRecord,
  StateRecord,
  StateService,
  StateTransitionRecord,
} from './state-service.js';

const stamps = {
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
};

const machineCreate = z.strictObject({
  entityKey: stateEntityKeySchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().default(null),
});
const machineUpdate = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).nullable(),
  })
  .partial();
const machineItem = z
  .object({
    id: z.uuid(),
    entityKey: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    ...stamps,
  })
  .meta({ id: 'StateMachine' });
const machineFilter = z.object({ entityKey: stateEntityKeySchema.optional() });

const stateCreate = z.strictObject({
  stateMachineId: z.uuid(),
  code: stateCodeSchema,
  labels: stateLabelsSchema,
  category: stateCategorySchema.default('open'),
  isInitial: z.boolean().default(false),
  isFinal: z.boolean().default(false),
  colour: stateColourSchema.nullable().default(null),
  sortOrder: z.number().int().min(0).max(100_000).default(0),
});
const stateUpdate = z
  .strictObject({
    labels: stateLabelsSchema,
    category: stateCategorySchema,
    isInitial: z.boolean(),
    isFinal: z.boolean(),
    colour: stateColourSchema.nullable(),
    sortOrder: z.number().int().min(0).max(100_000),
  })
  .partial();
const stateItem = z
  .object({
    id: z.uuid(),
    stateMachineId: z.uuid(),
    code: z.string(),
    labels: z.record(z.string(), z.string()),
    category: stateCategorySchema,
    isInitial: z.boolean(),
    isFinal: z.boolean(),
    colour: z.string().nullable(),
    sortOrder: z.number().int(),
    ...stamps,
  })
  .meta({ id: 'State' });
const childFilter = z.object({ stateMachineId: z.uuid().optional() });

const transitionCreate = z.strictObject({
  stateMachineId: z.uuid(),
  fromCode: stateCodeSchema,
  toCode: stateCodeSchema,
  permissionKey: statePermissionKeySchema.nullable().default(null),
  requiredFields: stateRequiredFieldsSchema.default([]),
  reasonRequired: z.boolean().default(false),
  reasonLookupTypeId: z.uuid().nullable().default(null),
  workflowDefinitionId: z.uuid().nullable().default(null),
});
const transitionUpdate = z
  .strictObject({
    permissionKey: statePermissionKeySchema.nullable(),
    requiredFields: stateRequiredFieldsSchema,
    reasonRequired: z.boolean(),
    reasonLookupTypeId: z.uuid().nullable(),
    workflowDefinitionId: z.uuid().nullable(),
  })
  .partial();
const transitionItem = z
  .object({
    id: z.uuid(),
    stateMachineId: z.uuid(),
    fromCode: z.string(),
    toCode: z.string(),
    permissionKey: z.string().nullable(),
    requiredFields: z.array(z.string()),
    reasonRequired: z.boolean(),
    reasonLookupTypeId: z.uuid().nullable(),
    workflowDefinitionId: z.uuid().nullable(),
    ...stamps,
  })
  .meta({ id: 'StateTransition' });

const historyItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    entityType: z.string(),
    entityId: z.uuid(),
    fromCode: z.string().nullable(),
    toCode: z.string(),
    effectiveDate: z.iso.date(),
    reasonId: z.uuid().nullable(),
    note: z.string().nullable(),
    actorId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'StateHistoryEntry' });
const historyList = z.object({ items: z.array(historyItem) }).meta({ id: 'StateHistory' });
const moveResult = z
  .object({
    entityType: z.string(),
    entityId: z.uuid(),
    stateCode: z.string(),
    history: historyItem,
  })
  .meta({ id: 'StateTransitionResult' });
const overviewResult = z
  .object({
    entityType: z.string(),
    entityId: z.uuid(),
    stateMachineId: z.uuid(),
    stateCode: z.string().nullable(),
    current: stateItem.nullable(),
    available: z.array(
      z.object({ transition: transitionItem, to: stateItem, allowed: z.boolean() }),
    ),
  })
  .meta({ id: 'StateOverview' });

const subjectParams = z.object({ entityType: stateEntityKeySchema, id: z.uuid() });
const recordParams = z.object({ entityKey: stateCodeSchema, id: z.uuid() });

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
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

export function toStateMachineItem(row: StateMachineRecord) {
  return {
    id: row.id,
    entityKey: row.entityKey,
    name: row.name,
    description: row.description,
    ...rowStamps(row),
  };
}

export function toStateItem(row: StateRecord) {
  return {
    id: row.id,
    stateMachineId: row.stateMachineId,
    code: row.code,
    labels: row.labels as Record<string, string>,
    category: row.category,
    isInitial: row.isInitial,
    isFinal: row.isFinal,
    colour: row.colour,
    sortOrder: row.sortOrder,
    ...rowStamps(row),
  };
}

export function toStateTransitionItem(row: StateTransitionRecord) {
  return {
    id: row.id,
    stateMachineId: row.stateMachineId,
    fromCode: row.fromCode,
    toCode: row.toCode,
    permissionKey: row.permissionKey,
    requiredFields: row.requiredFields,
    reasonRequired: row.reasonRequired,
    reasonLookupTypeId: row.reasonLookupTypeId,
    workflowDefinitionId: row.workflowDefinitionId,
    ...rowStamps(row),
  };
}

export function toStateHistoryItem(row: StateHistoryRecord) {
  return {
    id: row.id,
    companyId: row.companyId,
    entityType: row.entityType,
    entityId: row.entityId,
    fromCode: row.fromCode,
    toCode: row.toCode,
    effectiveDate: isoDay(row.effectiveDate),
    reasonId: row.reasonId,
    note: row.note,
    actorId: row.actorId,
    createdAt: row.createdAt.toISOString(),
  };
}

const invalid = (path: string, message: string, code: string) =>
  new ValidationError([{ path, message, code }]);

async function liveMachine(id: string): Promise<StateMachineRecord> {
  const machine = await currentUnit().db.stateMachine.findFirst({
    where: { id, deletedAt: null },
  });
  if (machine === null) {
    throw invalid('stateMachineId', 'This state machine does not exist.', 'unknown_state_machine');
  }
  return machine;
}

/** The repository behind `/state-machines` and the recycle bin; adds rule 6. */
export function createStateMachineRepository(): Repository<StateMachineRecord> {
  const base = createRepository<StateMachineRecord>({ model: 'stateMachine', scope: 'tenant' });
  return {
    ...base,
    softDelete: async (id, version, reason) => {
      const states = await currentUnit().db.state.count({
        where: { stateMachineId: id, deletedAt: null },
      });
      if (states > 0) {
        throw new ConflictError(
          'state_machine_has_states',
          'Delete the states of this machine first.',
          { states },
        );
      }
      return base.softDelete(id, version, reason);
    },
  };
}

/** The repository behind `/states` and the recycle bin; adds rules 2, 3 and 6. */
export function createStateRepository(): Repository<StateRecord> {
  const base = createRepository<StateRecord>({ model: 'state', scope: 'tenant' });

  /** Rule 2: one initial state per machine, said in words before the unique index says it. */
  const assertNoOtherInitial = async (machineId: string, exceptId?: string) => {
    const other = await currentUnit().db.state.findFirst({
      where: {
        stateMachineId: machineId,
        isInitial: true,
        deletedAt: null,
        ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
      },
    });
    if (other !== null) {
      throw new ConflictError(
        'state_initial_exists',
        `"${other.code}" is already the first state; a machine has one.`,
      );
    }
  };

  return {
    ...base,
    create: async (data) => {
      const body = data as z.infer<typeof stateCreate>;
      if (body.isInitial && body.isFinal) {
        throw invalid('isFinal', 'A state cannot be both the first and a final state.', 'invalid');
      }
      const machine = await liveMachine(body.stateMachineId);
      if (body.isInitial) await assertNoOtherInitial(machine.id);
      return base.create({ ...body, stateMachineId: machine.id });
    },
    update: async (id, version, changes) => {
      const body = changes as z.infer<typeof stateUpdate>;
      const current = await base.get(id);
      const isInitial = body.isInitial ?? current.isInitial;
      const isFinal = body.isFinal ?? current.isFinal;
      if (isInitial && isFinal) {
        throw invalid('isFinal', 'A state cannot be both the first and a final state.', 'invalid');
      }
      if (isInitial && !current.isInitial) {
        await assertNoOtherInitial(current.stateMachineId, id);
      }
      if (isFinal && !current.isFinal) {
        // Rule 3.
        const out = await currentUnit().db.stateTransition.count({
          where: {
            stateMachineId: current.stateMachineId,
            fromCode: current.code,
            deletedAt: null,
          },
        });
        if (out > 0) {
          throw new UnprocessableError(
            'state_has_transitions_out',
            'Records can still leave this state; delete those transitions before making it final.',
          );
        }
      }
      return base.update(id, version, body);
    },
    softDelete: async (id, version, reason) => {
      const current = await base.get(id);
      const used = await currentUnit().db.stateTransition.count({
        where: {
          stateMachineId: current.stateMachineId,
          deletedAt: null,
          OR: [{ fromCode: current.code }, { toCode: current.code }],
        },
      });
      if (used > 0) {
        throw new ConflictError(
          'state_in_use',
          'Delete the transitions to and from this state first.',
          { transitions: used },
        );
      }
      return base.softDelete(id, version, reason);
    },
  };
}

/** The repository behind `/state-transitions` and the recycle bin; adds rules 3 to 5. */
export function createStateTransitionRepository(): Repository<StateTransitionRecord> {
  const base = createRepository<StateTransitionRecord>({
    model: 'stateTransition',
    scope: 'tenant',
  });

  /** Rules 3 and 4: both ends are live states of the machine and the start is not final. */
  const assertEnds = async (machineId: string, fromCode: string, toCode: string) => {
    const states = await currentUnit().db.state.findMany({
      where: { stateMachineId: machineId, deletedAt: null, code: { in: [fromCode, toCode] } },
    });
    const from = states.find((s) => s.code === fromCode);
    if (from === undefined) {
      throw invalid('fromCode', `This machine has no state "${fromCode}".`, 'unknown_state');
    }
    if (!states.some((s) => s.code === toCode)) {
      throw invalid('toCode', `This machine has no state "${toCode}".`, 'unknown_state');
    }
    if (from.isFinal) {
      throw new UnprocessableError(
        'transition_from_final',
        `"${fromCode}" is a final state; nothing leaves it.`,
      );
    }
  };

  /** Rule 5. */
  const assertReferences = async (body: {
    permissionKey?: string | null | undefined;
    reasonLookupTypeId?: string | null | undefined;
    workflowDefinitionId?: string | null | undefined;
  }) => {
    const { db } = currentUnit();
    if (typeof body.workflowDefinitionId === 'string') {
      const workflow = await db.workflowDefinition.findFirst({
        where: { id: body.workflowDefinitionId, deletedAt: null },
        select: { id: true },
      });
      if (workflow === null) {
        throw invalid('workflowDefinitionId', 'This workflow does not exist.', 'unknown_workflow');
      }
    }
    if (typeof body.permissionKey === 'string') {
      const known = await db.permission.findFirst({
        where: { key: body.permissionKey, isActive: true },
        select: { id: true },
      });
      if (known === null) {
        throw invalid('permissionKey', 'There is no such permission.', 'unknown_permission');
      }
    }
    if (typeof body.reasonLookupTypeId === 'string') {
      const list = await db.lookupType.findFirst({
        where: { id: body.reasonLookupTypeId, deletedAt: null },
        select: { id: true },
      });
      if (list === null) {
        throw invalid('reasonLookupTypeId', 'This list does not exist.', 'unknown_lookup_type');
      }
    }
  };

  return {
    ...base,
    create: async (data) => {
      const body = data as z.infer<typeof transitionCreate>;
      const machine = await liveMachine(body.stateMachineId);
      await assertEnds(machine.id, body.fromCode, body.toCode);
      await assertReferences(body);
      return base.create({ ...body, stateMachineId: machine.id });
    },
    update: async (id, version, changes) => {
      const body = changes as z.infer<typeof transitionUpdate>;
      await assertReferences(body);
      return base.update(id, version, body);
    },
    restore: async (id, version) => {
      // A restored transition must still join two live states (they may have gone since).
      const deleted = await currentUnit().db.stateTransition.findFirst({
        where: { id, deletedAt: { not: null } },
      });
      if (deleted !== null) {
        await assertEnds(deleted.stateMachineId, deleted.fromCode, deleted.toCode);
      }
      return base.restore(id, version);
    },
  };
}

export interface StateRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  states: StateService;
}

export function createStateRouter(deps: StateRouterDeps): Router {
  const { uow, registry, permissions, states } = deps;
  const router = Router();
  const crud = { uow, authorize: permissions.authorize, registry };

  // Moving a record. The permission depends on the transition, so it is checked inside the
  // service (step 4), in the same transaction as the move.
  const move = async (entityType: string, id: string, req: Request, res: Response) => {
    const body = transitionRequestSchema.parse(req.body);
    const done = await uow.run(() => states.transition(entityType, id, body));
    res.json({
      entityType,
      entityId: id,
      stateCode: done.stateCode,
      history: toStateHistoryItem(done.history),
    });
  };
  router.post('/transitions/:entityType/:id', async (req, res) => {
    const { entityType, id } = subjectParams.parse(req.params);
    await move(entityType, id, req, res);
  });
  router.post('/records/:entityKey/:id/transition', async (req, res) => {
    const { entityKey, id } = recordParams.parse(req.params);
    await move(entityKey, id, req, res);
  });

  router.get('/transitions/:entityType/:id', async (req, res) => {
    const { entityType, id } = subjectParams.parse(req.params);
    const view = await uow.run(() => states.overview(entityType, id));
    res.json({
      entityType,
      entityId: id,
      stateMachineId: view.machine.id,
      stateCode: view.stateCode,
      current: view.current === null ? null : toStateItem(view.current),
      available: view.available.map((a) => ({
        transition: toStateTransitionItem(a.transition),
        to: toStateItem(a.to),
        allowed: a.allowed,
      })),
    });
  });

  router.get('/state-history/:entityType/:id', async (req, res) => {
    const { entityType, id } = subjectParams.parse(req.params);
    const rows = await uow.run(() => states.history(entityType, id));
    res.json({ items: rows.map(toStateHistoryItem) });
  });

  router.use(
    createCrudRouter<StateMachineRecord>(crud, {
      path: '/state-machines',
      resource: 'platform.state_machine',
      tag: 'State machines',
      repository: createStateMachineRepository(),
      schemas: {
        create: machineCreate,
        update: machineUpdate,
        item: machineItem,
        filter: machineFilter,
      },
      toItem: toStateMachineItem,
      toWhere: (filter) => filter,
    }),
  );
  router.use(
    createCrudRouter<StateRecord>(crud, {
      path: '/states',
      resource: 'platform.state',
      tag: 'State machines',
      repository: createStateRepository(),
      schemas: { create: stateCreate, update: stateUpdate, item: stateItem, filter: childFilter },
      toItem: toStateItem,
      toWhere: (filter) => filter,
    }),
  );
  router.use(
    createCrudRouter<StateTransitionRecord>(crud, {
      path: '/state-transitions',
      resource: 'platform.state_transition',
      tag: 'State machines',
      repository: createStateTransitionRepository(),
      schemas: {
        create: transitionCreate,
        update: transitionUpdate,
        item: transitionItem,
        filter: childFilter,
      },
      toItem: toStateTransitionItem,
      toWhere: (filter) => filter,
    }),
  );

  const tags = ['State machines'];
  const problem = (description: string) => ({
    description,
    content: { 'application/problem+json': { schema: problemSchema } },
  });
  const moveResponses = {
    200: {
      description: 'The new state and its history entry',
      content: { 'application/json': { schema: moveResult } },
    },
    400: problem('A required field, the reason or the effective date is missing or wrong'),
    403: problem('The transition needs a permission you do not have'),
    404: problem('No such record, or its type has no state machine'),
    409: problem('The record changed meanwhile'),
    422: problem('This move is not allowed from the current state'),
  };
  const moveBody = { content: { 'application/json': { schema: transitionRequestSchema } } };
  registerRoute(registry, {
    method: 'post',
    path: '/transitions/{entityType}/{id}',
    tags,
    summary: 'Move a record to another state (checked against its state machine)',
    request: { params: subjectParams, body: moveBody },
    responses: moveResponses,
  });
  registerRoute(registry, {
    method: 'post',
    path: '/records/{entityKey}/{id}/transition',
    tags: ['Custom records'],
    summary: 'Move a custom record to another state',
    request: { params: recordParams, body: moveBody },
    responses: moveResponses,
  });
  registerRoute(registry, {
    method: 'get',
    path: '/transitions/{entityType}/{id}',
    tags,
    summary: 'The state of a record and the moves it could make now',
    request: { params: subjectParams },
    responses: {
      200: {
        description: 'Current state and available transitions',
        content: { 'application/json': { schema: overviewResult } },
      },
      404: problem('No such record, or its type has no state machine'),
    },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/state-history/{entityType}/{id}',
    tags,
    summary: 'The dated state history of a record, oldest first',
    request: { params: subjectParams },
    responses: {
      200: { description: 'The history', content: { 'application/json': { schema: historyList } } },
      404: problem('No such record'),
    },
  });

  return router;
}
