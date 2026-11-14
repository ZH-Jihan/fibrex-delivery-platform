/**
 * Notify module: public entry point (SPEC 2.13: other modules import only this file).
 *
 * Purpose: notification rules, in-app notifications with realtime push, email through a
 * queue. Other modules announce events with `NotifyService.emit` (after their own
 * transaction commits) and register their event types with `syncEventTypes` at start-up.
 *
 * Depends on: ./notify-service.ts, ./router.ts, ./realtime.ts, ./email-queue.ts.
 * Used by: src/main.ts.
 */
import type { PrismaDb } from '../../kernel/db/prisma.js';
import { crudPermissions, type PermissionDef } from '../../kernel/permissions/catalogue.js';

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

export const NOTIFY_PERMISSIONS: readonly PermissionDef[] = [
  ...crudPermissions('notify', 'notify.rule', 'notification rules'),
];

export interface EventTypeDef {
  key: string;
  moduleKey: string;
  label: string;
  description?: string;
}

/** Events the kernel itself announces. Modules add theirs through `syncEventTypes`. */
export const KERNEL_EVENT_TYPES: readonly EventTypeDef[] = [
  {
    key: 'system.test',
    moduleKey: 'notify',
    label: 'Test event',
    description: 'Used to try out a notification rule.',
  },
];

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
