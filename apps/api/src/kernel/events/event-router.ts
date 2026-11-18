/**
 * Integration API for events and webhooks (phase 2 row 2.12; PLAN 5.10).
 *
 *   GET  /event-types                              registered event types (any signed-in user)
 *   GET  /events?type=&from=&to=&aggregateId=      outbox browser, with who handled each event
 *                                                  (`integration.event.read`)
 *   /webhook-subscriptions                         CRUD (`integration.webhook_subscription.*`);
 *                                                  POST answers with the signing secret, once
 *   POST /webhook-subscriptions/{id}/rotate-secret new secret, shown once (`...rotate_secret`)
 *   GET  /webhook-deliveries?subscriptionId=&eventId=&status=   delivery log
 *                                                  (`integration.webhook_delivery.read`)
 *   POST /webhook-deliveries/{id}/retry            send again now (`...webhook_delivery.retry`)
 *
 * The secret is generated here, never chosen by the caller, and stored only sealed with
 * the secret box under the row's own id (so a sealed value copied to another row does not
 * open). Responses never contain it except the create and rotate answers.
 *
 * Depends on: express, zod, @fibrex/shared (webhook schemas), kernel/http, kernel/db,
 * kernel/crypto/secret-box.ts, ./webhooks.ts. Used by: src/main.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  webhookEventTypesSchema,
  webhookSubscriptionFormSchema,
  webhookUrlSchema,
} from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { SecretBox } from '../crypto/secret-box.js';
import type { Db } from '../db/prisma.js';
import { createRepository, mapDbError, MAX_PAGE_SIZE, type Repository } from '../db/repository.js';
import { currentUnit, type UnitOfWork } from '../db/unit-of-work.js';
import { createCrudRouter } from '../http/crud-router.js';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from '../http/errors.js';
import { registerRoute } from '../http/openapi.js';
import { requireContext } from '../context/request-context.js';
import type { EventTypeDef } from '../module-registry/manifest.js';
import type { PermissionService } from '../permissions/permission-service.js';
import {
  checkWebhookUrl,
  newWebhookSecret,
  secretContext,
  type WebhookDispatcher,
} from './webhooks.js';

export type WebhookSubscriptionRow = NonNullable<
  Awaited<ReturnType<Db['webhookSubscription']['findFirst']>>
>;
type DeliveryRow = NonNullable<Awaited<ReturnType<Db['webhookDelivery']['findFirst']>>>;

const subscriptionUpdate = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    url: webhookUrlSchema,
    eventTypeKeys: webhookEventTypesSchema,
    active: z.boolean(),
  })
  .partial();
const subscriptionCreate = webhookSubscriptionFormSchema.extend({
  companyId: z.uuid().optional(),
  apiClientId: z.uuid().nullable().optional(),
});
const subscriptionItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    name: z.string(),
    url: z.string(),
    eventTypeKeys: z.array(z.string()),
    active: z.boolean(),
    apiClientId: z.uuid().nullable(),
    /** Only in the answer to POST: store it now, it is not shown again. */
    secret: z.string().optional(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'WebhookSubscription' });

const eventList = z.object({
  type: z.string().max(200).optional(),
  aggregateId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
});
const eventItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid().nullable(),
    eventType: z.string(),
    eventVersion: z.number().int(),
    aggregateType: z.string(),
    aggregateId: z.uuid().nullable(),
    payload: z.record(z.string(), z.unknown()),
    occurredAt: z.iso.datetime(),
    handledBy: z.array(z.object({ consumer: z.string(), processedAt: z.iso.datetime() })),
  })
  .meta({ id: 'OutboxEvent' });

const deliveryList = z.object({
  subscriptionId: z.uuid().optional(),
  eventId: z.uuid().optional(),
  status: z.enum(['succeeded', 'failed']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
});
const deliveryItem = z
  .object({
    id: z.uuid(),
    subscriptionId: z.uuid(),
    eventId: z.uuid(),
    eventType: z.string(),
    attempt: z.number().int(),
    status: z.string(),
    statusCode: z.number().int().nullable(),
    responseMs: z.number().int().nullable(),
    error: z.string().nullable(),
    nextRetryAt: z.iso.datetime().nullable(),
    manual: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'WebhookDelivery' });
const idParams = z.object({ id: z.uuid() });

type SubscriptionWithSecret = WebhookSubscriptionRow & { plainSecret?: string };

export function toSubscriptionItem(row: SubscriptionWithSecret) {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    url: row.url,
    eventTypeKeys: row.eventTypeKeys,
    active: row.active,
    apiClientId: row.apiClientId,
    ...(row.plainSecret === undefined ? {} : { secret: row.plainSecret }),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

const toDeliveryItem = (row: DeliveryRow) => ({
  id: row.id,
  subscriptionId: row.subscriptionId,
  eventId: row.eventId,
  eventType: row.eventTypeKey,
  attempt: row.attempt,
  status: row.status,
  statusCode: row.statusCode,
  responseMs: row.responseMs,
  error: row.error,
  nextRetryAt: row.nextRetryAt?.toISOString() ?? null,
  manual: row.manual,
  createdAt: row.createdAt.toISOString(),
});

/** The plain subscription repository (also behind the recycle bin). */
export const createWebhookSubscriptionRepository = () =>
  createRepository<WebhookSubscriptionRow>({ model: 'webhookSubscription', scope: 'company' });

export interface EventRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  box: SecretBox;
  webhooks: WebhookDispatcher;
  /** Every registered event type (module manifests and the kernel's own). */
  eventTypes: () => readonly EventTypeDef[];
}

export function createEventRouter(deps: EventRouterDeps): Router {
  const { uow, registry, permissions, box, webhooks } = deps;
  const router = Router();
  const tags = ['Events and webhooks'];

  /** Event types must exist: a typo would subscribe to nothing, silently. */
  const checkSubscription = (data: Record<string, unknown>) => {
    const issues = [];
    if (typeof data.url === 'string') {
      const problem = checkWebhookUrl(data.url, webhooks.allowInsecure);
      if (problem !== null) issues.push({ path: 'url', code: 'url_not_allowed', message: problem });
    }
    if (Array.isArray(data.eventTypeKeys)) {
      const known = new Set(deps.eventTypes().map((t) => t.key));
      for (const key of data.eventTypeKeys as string[]) {
        if (key !== '*' && !known.has(key)) {
          issues.push({
            path: 'eventTypeKeys',
            code: 'unknown_event_type',
            message: `Unknown event type: ${key}`,
          });
        }
      }
    }
    if (issues.length > 0) throw new ValidationError(issues);
  };

  const base = createWebhookSubscriptionRepository();
  const repository: Repository<WebhookSubscriptionRow> = {
    ...base,
    create: async (data) => {
      checkSubscription(data);
      const body = subscriptionCreate.parse(data);
      const { db, context } = currentUnit();
      // Same company rule as the repository: named in the body, or the session's only one.
      const companyId =
        body.companyId ?? (context.companyIds.length === 1 ? context.companyIds[0] : undefined);
      if (companyId === undefined) {
        throw new BadRequestError('company_required', 'State which company this belongs to.');
      }
      if (!context.companyIds.includes(companyId)) {
        throw new ForbiddenError('You do not have access to this company');
      }
      // The id is taken first (the repository does not accept one), so the secret is sealed
      // to this row from the start and a sealed value copied to another row will not open.
      const [fresh] = await db.$queryRaw<
        { id: string }[]
      >`SELECT app.uuid_generate_v7()::text AS id`;
      const id = fresh?.id ?? '';
      const secret = newWebhookSecret();
      try {
        const row = await db.webhookSubscription.create({
          data: {
            id,
            tenantId: context.tenantId,
            companyId,
            name: body.name,
            url: body.url,
            eventTypeKeys: body.eventTypeKeys,
            active: body.active,
            apiClientId: body.apiClientId ?? null,
            secretEncrypted: box.seal(Buffer.from(secret, 'utf8'), secretContext(id)),
          },
        });
        const withSecret: SubscriptionWithSecret = { ...row, plainSecret: secret };
        return withSecret;
      } catch (err) {
        throw mapDbError(err);
      }
    },
    update: (id, version, data) => {
      checkSubscription(data);
      return base.update(id, version, data);
    },
  };

  router.use(
    createCrudRouter<WebhookSubscriptionRow>(
      { uow, authorize: permissions.authorize, registry },
      {
        path: '/webhook-subscriptions',
        resource: 'integration.webhook_subscription',
        tag: 'Events and webhooks',
        repository,
        schemas: {
          create: subscriptionCreate,
          update: subscriptionUpdate,
          item: subscriptionItem,
          filter: z.object({ active: z.enum(['true', 'false']).optional() }),
        },
        toItem: toSubscriptionItem,
        toWhere: (filter) =>
          filter.active === undefined ? {} : { active: filter.active === 'true' },
      },
    ),
  );

  router.post('/webhook-subscriptions/:id/rotate-secret', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const secret = await uow.run(async (db) => {
      await permissions.authorize('integration.webhook_subscription.rotate_secret');
      const row = await db.webhookSubscription.findFirst({ where: { id, deletedAt: null } });
      if (row === null) throw new NotFoundError();
      const next = newWebhookSecret();
      await db.webhookSubscription.update({
        where: { id },
        data: { secretEncrypted: box.seal(Buffer.from(next, 'utf8'), secretContext(id)) },
      });
      return next;
    });
    res.json({ secret });
  });
  registerRoute(registry, {
    method: 'post',
    path: '/webhook-subscriptions/{id}/rotate-secret',
    tags,
    summary: 'Replace the signing secret; the new one is shown once',
    request: { params: idParams },
    responses: {
      200: {
        description: 'The new secret',
        content: { 'application/json': { schema: z.object({ secret: z.string() }) } },
      },
    },
  });

  router.get('/event-types', (_req, res) => {
    if (requireContext().principal === undefined) throw new UnauthenticatedError();
    const items = [...deps.eventTypes()].sort((a, b) => a.key.localeCompare(b.key));
    res.json({ items });
  });
  registerRoute(registry, {
    method: 'get',
    path: '/event-types',
    tags,
    summary: 'Registered event types',
    responses: {
      200: {
        description: 'Event types',
        content: {
          'application/json': {
            schema: z.object({
              items: z.array(
                z.object({
                  key: z.string(),
                  moduleKey: z.string(),
                  label: z.string(),
                  description: z.string().optional(),
                }),
              ),
            }),
          },
        },
      },
    },
  });

  router.get('/events', async (req, res) => {
    const query = eventList.parse(req.query);
    const page = await uow.run(async (db) => {
      await permissions.authorize('integration.event.read');
      // Row-level security limits the rows to tenant-level events and the caller's companies.
      const where = {
        ...(query.type === undefined ? {} : { eventTypeKey: query.type }),
        ...(query.aggregateId === undefined ? {} : { aggregateId: query.aggregateId }),
        ...(query.from === undefined && query.to === undefined
          ? {}
          : {
              occurredAt: {
                ...(query.from === undefined ? {} : { gte: new Date(query.from) }),
                ...(query.to === undefined ? {} : { lt: new Date(query.to) }),
              },
            }),
      };
      const [rows, total] = await Promise.all([
        db.outboxEvent.findMany({
          where,
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
        db.outboxEvent.count({ where }),
      ]);
      const handled = await db.eventConsumption.findMany({
        where: { eventId: { in: rows.map((r) => r.id) } },
        orderBy: { processedAt: 'asc' },
      });
      const items = rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        eventType: row.eventTypeKey,
        eventVersion: row.eventVersion,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        payload: row.payload as Record<string, unknown>,
        occurredAt: row.occurredAt.toISOString(),
        handledBy: handled
          .filter((h) => h.eventId === row.id)
          .map((h) => ({ consumer: h.consumerKey, processedAt: h.processedAt.toISOString() })),
      }));
      return { items, total, page: query.page, pageSize: query.pageSize };
    });
    res.json(page);
  });
  registerRoute(registry, {
    method: 'get',
    path: '/events',
    tags,
    summary: 'Browse the event outbox',
    request: { query: eventList },
    responses: {
      200: {
        description: 'A page of events, newest first',
        content: {
          'application/json': {
            schema: z.object({ items: z.array(eventItem), total: z.number().int() }),
          },
        },
      },
    },
  });

  router.get('/webhook-deliveries', async (req, res) => {
    const query = deliveryList.parse(req.query);
    const page = await uow.run(async (db) => {
      await permissions.authorize('integration.webhook_delivery.read');
      const where = {
        ...(query.subscriptionId === undefined ? {} : { subscriptionId: query.subscriptionId }),
        ...(query.eventId === undefined ? {} : { eventId: query.eventId }),
        ...(query.status === undefined ? {} : { status: query.status }),
      };
      const [rows, total] = await Promise.all([
        db.webhookDelivery.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
        db.webhookDelivery.count({ where }),
      ]);
      return { items: rows.map(toDeliveryItem), total, page: query.page, pageSize: query.pageSize };
    });
    res.json(page);
  });
  registerRoute(registry, {
    method: 'get',
    path: '/webhook-deliveries',
    tags,
    summary: 'Webhook delivery log (one row per attempt)',
    request: { query: deliveryList },
    responses: {
      200: {
        description: 'A page of attempts, newest first',
        content: {
          'application/json': {
            schema: z.object({ items: z.array(deliveryItem), total: z.number().int() }),
          },
        },
      },
    },
  });

  router.post('/webhook-deliveries/:id/retry', async (req, res) => {
    const { id } = idParams.parse(req.params);
    await uow.run(async () => {
      await permissions.authorize('integration.webhook_delivery.retry');
      await webhooks.retry(id);
    });
    res.status(202).json({ queued: true });
  });
  registerRoute(registry, {
    method: 'post',
    path: '/webhook-deliveries/{id}/retry',
    tags,
    summary: 'Send a delivery again now (one attempt)',
    request: { params: idParams },
    responses: {
      202: {
        description: 'Queued',
        content: { 'application/json': { schema: z.object({ queued: z.boolean() }) } },
      },
    },
  });

  return router;
}
