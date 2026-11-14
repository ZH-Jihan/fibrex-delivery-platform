/**
 * Notifications API (PLAN 5.7).
 *
 *   GET  /notifications                 my notifications (newest first; ?unreadOnly=true)
 *   GET  /notifications/unread-count    number for the bell
 *   POST /notifications/{id}/read       mark one read (repeat is harmless)
 *   POST /notifications/read-all        mark all of mine read
 *   GET  /notification-preferences      my channel choices
 *   PUT  /notification-preferences      switch a channel on or off for an event type ("*" = all)
 *   GET  /notification-event-types      what can be subscribed to
 *   /notification-rules                 CRUD of rules (permission notify.rule.*)
 *   POST /notification-rules/{id}/test  send the rule to me only, to see how it reads
 *
 * "Mine" always means the signed-in user: the user id comes from the verified request, never
 * from a parameter, so nobody can read or mark another person's notifications. Row-level
 * security keeps everything inside the caller's tenant.
 *
 * Depends on: express, zod, kernel/http, kernel/db, ./notify-service.ts, ./template.ts.
 * Used by: ./index.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { Router } from 'express';
import { z } from 'zod';
import { requireContext } from '../../kernel/context/request-context.js';
import type { Db } from '../../kernel/db/prisma.js';
import { createRepository } from '../../kernel/db/repository.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { createCrudRouter } from '../../kernel/http/crud-router.js';
import { NotFoundError, UnauthenticatedError, ValidationError } from '../../kernel/http/errors.js';
import { registerRoute } from '../../kernel/http/openapi.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import type { NotifyService } from './notify-service.js';
import { validateTemplate } from './template.js';

type RuleRow = NonNullable<Awaited<ReturnType<Db['notificationRule']['findFirst']>>>;

const idParams = z.object({ id: z.uuid() });
const channel = z.enum(['in_app', 'email']);
const eventKey = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);

const notificationItem = z
  .object({
    id: z.uuid(),
    eventType: z.string(),
    title: z.string(),
    body: z.string(),
    data: z.unknown(),
    read: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Notification' });
const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
  unreadOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
const preferenceBody = z.strictObject({
  eventType: z.union([z.literal('*'), eventKey]).default('*'),
  channel,
  enabled: z.boolean(),
});
const recipients = z.strictObject({
  userIds: z.array(z.uuid()).max(100).optional(),
  roleKeys: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,63}$/i))
    .max(50)
    .optional(),
  payloadUserFields: z
    .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,49}$/))
    .max(10)
    .optional(),
});
const templateText = (max: number) =>
  z
    .string()
    .max(max)
    .superRefine((text, ctx) => {
      const problem = validateTemplate(text);
      if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem });
    });
const ruleCreate = z.strictObject({
  name: z.string().trim().min(1).max(200),
  eventTypeKey: eventKey,
  channels: z.array(channel).min(1).max(2),
  recipients,
  titleTemplate: templateText(500).min(1),
  bodyTemplate: templateText(5000).default(''),
  isActive: z.boolean().default(true),
});
const ruleUpdate = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  eventTypeKey: eventKey.optional(),
  channels: z.array(channel).min(1).max(2).optional(),
  recipients: recipients.optional(),
  titleTemplate: templateText(500).min(1).optional(),
  bodyTemplate: templateText(5000).optional(),
  isActive: z.boolean().optional(),
});
const ruleItem = z
  .object({
    id: z.uuid(),
    version: z.number().int(),
    name: z.string(),
    eventTypeKey: z.string(),
    channels: z.array(z.string()),
    recipients: z.unknown(),
    titleTemplate: z.string(),
    bodyTemplate: z.string(),
    isActive: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'NotificationRule' });
const testBody = z.strictObject({ payload: z.record(z.string(), z.unknown()).default({}) });

interface RawNotification {
  id: string;
  event_type_key: string;
  title: string;
  body: string;
  data: unknown;
  created_at: Date;
  is_read: boolean;
}

/** The signed-in person; API clients have no notifications. */
function callerId(): string {
  const principal = requireContext().principal;
  if (principal?.kind !== 'user') throw new UnauthenticatedError();
  return principal.userId;
}

export function createNotifyRouter(deps: {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  notify: NotifyService;
}): Router {
  const { uow, registry, permissions, notify } = deps;
  const router = Router();
  const tags = ['Notifications'];

  router.get('/notifications', async (req, res) => {
    const { page, pageSize, unreadOnly } = listQuery.parse(req.query);
    const userId = callerId();
    const offset = (page - 1) * pageSize;
    const rows = await uow.run(
      (db) =>
        db.$queryRaw<RawNotification[]>`
        SELECT n.id::text AS id, n.event_type_key, n.title, n.body, n.data, n.created_at,
               (r.id IS NOT NULL) AS is_read
          FROM notify.notification n
          LEFT JOIN notify.notification_read r
                 ON r.notification_id = n.id AND r.user_id = n.user_id
         WHERE n.user_id = ${userId}::uuid AND (NOT ${unreadOnly} OR r.id IS NULL)
         ORDER BY n.created_at DESC, n.id DESC
         LIMIT ${pageSize} OFFSET ${offset}`,
    );
    res.json({
      page,
      pageSize,
      items: rows.map((n) => ({
        id: n.id,
        eventType: n.event_type_key,
        title: n.title,
        body: n.body,
        data: n.data,
        read: n.is_read,
        createdAt: n.created_at.toISOString(),
      })),
    });
  });

  router.get('/notifications/unread-count', async (_req, res) => {
    const userId = callerId();
    const rows = await uow.run(
      (db) =>
        db.$queryRaw<{ unread: bigint }[]>`
        SELECT count(*) AS unread
          FROM notify.notification n
          LEFT JOIN notify.notification_read r
                 ON r.notification_id = n.id AND r.user_id = n.user_id
         WHERE n.user_id = ${userId}::uuid AND r.id IS NULL`,
    );
    res.json({ unread: Number(rows[0]?.unread ?? 0) });
  });

  router.post('/notifications/read-all', async (_req, res) => {
    const userId = callerId();
    const marked = await uow.run(
      (db) =>
        db.$executeRaw`
        INSERT INTO notify.notification_read (tenant_id, user_id, notification_id)
        SELECT n.tenant_id, n.user_id, n.id
          FROM notify.notification n
         WHERE n.user_id = ${userId}::uuid
           AND NOT EXISTS (SELECT 1 FROM notify.notification_read r
                            WHERE r.user_id = n.user_id AND r.notification_id = n.id)
        ON CONFLICT (user_id, notification_id) DO NOTHING`,
    );
    res.json({ marked });
  });

  router.post('/notifications/:id/read', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const userId = callerId();
    await uow.run(async (db) => {
      const own = await db.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM notify.notification
         WHERE id = ${id}::uuid AND user_id = ${userId}::uuid LIMIT 1`;
      // Someone else's notification looks exactly like one that does not exist.
      if (own.length === 0) throw new NotFoundError();
      await db.$executeRaw`
        INSERT INTO notify.notification_read (tenant_id, user_id, notification_id)
        VALUES (app.current_tenant_id(), ${userId}::uuid, ${id}::uuid)
        ON CONFLICT (user_id, notification_id) DO NOTHING`;
    });
    res.status(204).end();
  });

  router.get('/notification-preferences', async (_req, res) => {
    const userId = callerId();
    const rows = await uow.run((db) =>
      db.notificationPreference.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    );
    res.json({
      items: rows.map((p) => ({
        eventType: p.eventTypeKey,
        channel: p.channel,
        enabled: p.enabled,
      })),
    });
  });

  router.put('/notification-preferences', async (req, res) => {
    const body = preferenceBody.parse(req.body);
    const userId = callerId();
    await uow.run(async (db) => {
      if (body.eventType !== '*') {
        const known = await db.eventType.findFirst({ where: { key: body.eventType } });
        if (known === null) {
          throw new ValidationError([
            { path: 'eventType', code: 'unknown_event_type', message: 'No such event type' },
          ]);
        }
      }
      await db.$executeRaw`
        INSERT INTO notify.notification_preference (tenant_id, user_id, event_type_key, channel, enabled)
        VALUES (app.current_tenant_id(), ${userId}::uuid, ${body.eventType}, ${body.channel}, ${body.enabled})
        ON CONFLICT (user_id, event_type_key, channel) WHERE deleted_at IS NULL
        DO UPDATE SET enabled = EXCLUDED.enabled`;
    });
    res.json(body);
  });

  router.get('/notification-event-types', async (_req, res) => {
    callerId();
    const rows = await uow.run((db) => db.eventType.findMany({ orderBy: { key: 'asc' } }));
    res.json({
      items: rows.map((e) => ({
        key: e.key,
        moduleKey: e.moduleKey,
        label: e.label,
        description: e.description,
      })),
    });
  });

  router.post('/notification-rules/:id/test', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { payload } = testBody.parse(req.body ?? {});
    await permissions.require('notify.rule.update');
    const principal = requireContext().principal;
    if (principal === undefined) throw new UnauthenticatedError();
    const sent = await notify.sendTest({
      tenantId: principal.tenantId,
      userId: callerId(),
      ruleId: id,
      payload,
    });
    if (sent < 0) throw new NotFoundError();
    res.json({ sent });
  });

  // Rules: standard CRUD, plus a check that the event type exists.
  const base = createRepository<RuleRow>({ model: 'notificationRule', scope: 'tenant' });
  const mustKnowEventType = async (key: unknown): Promise<void> => {
    if (typeof key !== 'string') return;
    const known = await currentUnit().db.eventType.findFirst({ where: { key } });
    if (known === null) {
      throw new ValidationError([
        { path: 'eventTypeKey', code: 'unknown_event_type', message: 'No such event type' },
      ]);
    }
  };
  const repository = {
    ...base,
    create: async (data: Record<string, unknown>) => {
      await mustKnowEventType(data.eventTypeKey);
      return base.create(data);
    },
    update: async (id: string, version: number, changes: Record<string, unknown>) => {
      await mustKnowEventType(changes.eventTypeKey);
      return base.update(id, version, changes);
    },
  };
  router.use(
    createCrudRouter(
      { uow, authorize: permissions.authorize, registry },
      {
        path: '/notification-rules',
        resource: 'notify.rule',
        tag: 'Notification rules',
        repository,
        schemas: { create: ruleCreate, update: ruleUpdate, item: ruleItem },
        toItem: (row: RuleRow) => ({
          id: row.id,
          version: row.version,
          name: row.name,
          eventTypeKey: row.eventTypeKey,
          channels: row.channels,
          recipients: row.recipients,
          titleTemplate: row.titleTemplate,
          bodyTemplate: row.bodyTemplate,
          isActive: row.isActive,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        }),
      },
    ),
  );

  const ok = (description: string, schema: z.ZodType) => ({
    200: { description, content: { 'application/json': { schema } } },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/notifications',
    tags,
    summary: 'My notifications',
    request: { query: listQuery },
    responses: ok(
      'A page of notifications',
      z.object({ page: z.number(), pageSize: z.number(), items: z.array(notificationItem) }),
    ),
  });
  registerRoute(registry, {
    method: 'get',
    path: '/notifications/unread-count',
    tags,
    summary: 'How many of my notifications are unread',
    responses: ok('The count', z.object({ unread: z.number().int() })),
  });
  registerRoute(registry, {
    method: 'post',
    path: '/notifications/read-all',
    tags,
    summary: 'Mark all my notifications read',
    responses: ok('How many were marked', z.object({ marked: z.number().int() })),
  });
  registerRoute(registry, {
    method: 'post',
    path: '/notifications/{id}/read',
    tags,
    summary: 'Mark one of my notifications read',
    request: { params: idParams },
    responses: { 204: { description: 'Marked' } },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/notification-preferences',
    tags,
    summary: 'My notification channel choices',
    responses: ok('The choices', z.object({ items: z.array(preferenceBody) })),
  });
  registerRoute(registry, {
    method: 'put',
    path: '/notification-preferences',
    tags,
    summary: 'Switch a channel on or off for an event type',
    request: { body: { content: { 'application/json': { schema: preferenceBody } } } },
    responses: ok('The saved choice', preferenceBody),
  });
  registerRoute(registry, {
    method: 'get',
    path: '/notification-event-types',
    tags,
    summary: 'Event types a rule or preference can name',
    responses: ok('The catalogue', z.object({ items: z.array(z.unknown()) })),
  });
  registerRoute(registry, {
    method: 'post',
    path: '/notification-rules/{id}/test',
    tags: ['Notification rules'],
    summary: 'Send a rule to me only, with sample merge fields',
    request: {
      params: idParams,
      body: { content: { 'application/json': { schema: testBody } } },
    },
    responses: ok('How many notifications were created', z.object({ sent: z.number().int() })),
  });

  return router;
}
