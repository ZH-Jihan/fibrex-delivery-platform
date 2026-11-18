/**
 * Notify module: public entry point (SPEC 2.13: other modules import only this file).
 *
 * Purpose: notification rules, in-app notifications with realtime push, email through a
 * queue. Other modules write events to the outbox (kernel/events, row 2.12) and declare
 * their event types in their manifest; the "notify.rules" consumer below turns every
 * event into notifications. `main.ts` writes the combined type list with `syncEventTypes`
 * at start-up and registers the consumer with the outbox relay.
 *
 * Depends on: ./notify-service.ts, ./router.ts, ./realtime.ts, ./email-queue.ts,
 * kernel/module-registry, kernel/events (consumer type). Used by: src/main.ts.
 */
import type { PrismaDb } from '../../kernel/db/prisma.js';
import type { EventConsumer } from '../../kernel/events/relay.js';
import type { EventTypeDef, ModuleManifest } from '../../kernel/module-registry/index.js';
import { crudPermissions, type PermissionDef } from '../../kernel/permissions/catalogue.js';
import { createNotifyRouter } from './router.js';
import type { NotifyService } from './notify-service.js';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import type { UnitOfWork } from '../../kernel/db/unit-of-work.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';

export { EmailQueue, EMAIL_QUEUE } from './email-queue.js';
export {
  NotifyService,
  type EmailJob,
  type EmailQueuePort,
  type NotificationView,
  type NotifyEvent,
  type RealtimePublisher,
  type Recipients,
} from './notify-service.js';
export { RealtimeGateway, REALTIME_NAMESPACE } from './realtime.js';
export { createNotifyRouter } from './router.js';
export type { EventTypeDef } from '../../kernel/module-registry/index.js';

export const NOTIFY_PERMISSIONS: readonly PermissionDef[] = [
  ...crudPermissions('notify', 'notify.rule', 'notification rules'),
];

/** Events the kernel itself announces. Modules add theirs through their manifest. */
export const KERNEL_EVENT_TYPES: readonly EventTypeDef[] = [
  {
    key: 'system.test',
    moduleKey: 'notify',
    label: 'Test event',
    description: 'Used to try out a notification rule.',
  },
];

export interface NotifyModuleDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  notify: NotifyService;
}

export function createNotifyModule(deps: NotifyModuleDeps): ModuleManifest {
  return {
    key: 'notify',
    label: 'Notifications',
    permissions: NOTIFY_PERMISSIONS,
    routers: [createNotifyRouter(deps)],
    eventTypes: KERNEL_EVENT_TYPES,
  };
}

export const NOTIFY_CONSUMER = 'notify.rules';

/**
 * Outbox consumer: runs the notification rules for every event. It runs inside the relay's
 * unit of work for the event's tenant and company, so the notifications and the
 * "consumed" mark commit together (an event never notifies twice).
 */
export function createNotifyConsumer(notify: NotifyService): EventConsumer {
  return {
    key: NOTIFY_CONSUMER,
    eventTypes: '*',
    handle: async (event) => {
      await notify.emit({
        tenantId: event.tenantId,
        ...(event.companyId === null ? {} : { companyId: event.companyId }),
        eventType: event.eventType,
        payload: event.payload,
      });
    },
  };
}

/** Writes the event type catalogue (new keys inserted, changed wording updated). */
export async function syncEventTypes(
  prisma: PrismaDb,
  defs: readonly EventTypeDef[] = KERNEL_EVENT_TYPES,
): Promise<void> {
  if (defs.length === 0) return;
  await prisma.$executeRaw`
    INSERT INTO notify.event_type (key, module_key, label, description)
    SELECT * FROM unnest(
      ${defs.map((d) => d.key)}::text[],
      ${defs.map((d) => d.moduleKey)}::text[],
      ${defs.map((d) => d.label)}::text[],
      ${defs.map((d) => d.description ?? '')}::text[])
    ON CONFLICT (key) DO UPDATE
      SET module_key = EXCLUDED.module_key, label = EXCLUDED.label,
          description = EXCLUDED.description
      WHERE (notify.event_type.module_key, notify.event_type.label, notify.event_type.description)
            IS DISTINCT FROM (EXCLUDED.module_key, EXCLUDED.label, EXCLUDED.description)`;
}
