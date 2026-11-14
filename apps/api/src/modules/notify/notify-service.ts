/**
 * Notification service: turns a business event into notifications.
 *
 * Purpose: a module announces that something happened (`emit`); this service finds the
 * rules for that event type, works out who must be told, respects each person's channel
 * preferences, writes one notification per person (visible in the app) and, for the email
 * channel, queues a message. In-app notifications are pushed to open browser tabs through
 * the realtime gateway.
 *
 * Order of work and why:
 *   1. Everything that must be consistent (notification rows, delivery rows) is written in
 *      ONE database transaction.
 *   2. Only after that transaction commits are the realtime push and the email jobs sent.
 *      Otherwise a browser could be told about a notification that a rollback then removes,
 *      or a worker could look for a row that is not visible yet.
 *   3. If queueing an email fails, the failure is recorded as a delivery row; the
 *      notification itself stays valid (the person still sees it in the app).
 *
 * `emit` opens its own transaction for the given tenant, so call it after the business
 * transaction has committed (publish events post-commit), not from inside it.
 *
 * Depends on: kernel/db (UnitOfWork), ./template.ts, ports for realtime and the email
 * queue (interfaces below, so tests and other transports can stand in).
 * Used by: other modules (through ./index.ts), ./router.ts.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../kernel/db/prisma.js';
import type { UnitOfWork } from '../../kernel/db/unit-of-work.js';
import type { Logger } from '../../kernel/observability/logger.js';
import { renderTemplate } from './template.js';

export type Channel = 'in_app' | 'email';

export interface NotifyEvent {
  tenantId: string;
  /** Narrows rules to those for this company (or for all companies). */
  companyId?: string;
  eventType: string;
  /** Merge fields for the rule texts; also read by `payloadUserFields` recipients. */
  payload: Record<string, unknown>;
}

export interface NotificationView {
  id: string;
  eventType: string;
  title: string;
  body: string;
  data: unknown;
  createdAt: string;
}

/** Pushes a new notification to the user's open browser tabs. */
export interface RealtimePublisher {
  notify(tenantId: string, userId: string, notification: NotificationView): void;
}

export interface EmailJob {
  tenantId: string;
  userId: string;
  notificationId: string;
  to: string;
  subject: string;
  text: string;
}

/** Hands an email to the queue; rejects when the queue is unavailable. */
export interface EmailQueuePort {
  enqueue(job: EmailJob): Promise<void>;
}

export interface Recipients {
  userIds?: string[];
  roleKeys?: string[];
  /** Names of payload fields that hold a user id (for example "approverId"). */
  payloadUserFields?: string[];
}

export interface NotifyServiceDeps {
  uow: UnitOfWork;
  realtime: RealtimePublisher;
  email: EmailQueuePort;
  logger: Logger;
}

interface Outbox {
  pushes: { userId: string; notification: NotificationView }[];
  emails: EmailJob[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class NotifyService {
  private readonly deps: NotifyServiceDeps;

  constructor(deps: NotifyServiceDeps) {
    this.deps = deps;
  }

  /** Returns how many notifications were created. */
  async emit(event: NotifyEvent): Promise<number> {
    const { uow } = this.deps;
    const outbox: Outbox = { pushes: [], emails: [] };
    const context = {
      tenantId: event.tenantId,
      companyIds: event.companyId === undefined ? [] : [event.companyId],
    };
    const count = await uow.runAs(context, async (db) => {
      const rules = await db.notificationRule.findMany({
        where: {
          eventTypeKey: event.eventType,
          isActive: true,
          OR: [
            { companyId: null },
            ...(event.companyId === undefined ? [] : [{ companyId: event.companyId }]),
          ],
        },
      });
      let created = 0;
      for (const rule of rules) {
        const recipients = rule.recipients as Recipients;
        const channels = rule.channels.filter((c): c is Channel => c === 'in_app' || c === 'email');
        created += await this.deliverRule(db, event, rule, recipients, channels, outbox);
      }
      return created;
    });

    await this.dispatch(context, outbox);
    return count;
  }

  /**
   * Test send of one rule (for the rule editor): the rule's text and channels are used as
   * written, but the only recipient is the caller, whatever the rule says.
   */
  async sendTest(options: {
    tenantId: string;
    userId: string;
    ruleId: string;
    payload: Record<string, unknown>;
  }): Promise<number> {
    const outbox: Outbox = { pushes: [], emails: [] };
    const context = { tenantId: options.tenantId, companyIds: [] as string[] };
    const count = await this.deps.uow.runAs(context, async (db) => {
      const rule = await db.notificationRule.findFirst({ where: { id: options.ruleId } });
      if (rule === null) return -1;
      const channels = rule.channels.filter((c): c is Channel => c === 'in_app' || c === 'email');
      const event: NotifyEvent = {
        tenantId: options.tenantId,
        eventType: rule.eventTypeKey,
        payload: options.payload,
      };
      return this.deliverRule(db, event, rule, { userIds: [options.userId] }, channels, outbox);
    });
    if (count >= 0) await this.dispatch(context, outbox);
    return count;
  }

  /** After the transaction committed: tell the browsers and queue the emails. */
  private async dispatch(
    context: { tenantId: string; companyIds: string[] },
    outbox: Outbox,
  ): Promise<void> {
    const { uow } = this.deps;
    const event = { tenantId: context.tenantId };
    for (const push of outbox.pushes) {
      try {
        this.deps.realtime.notify(event.tenantId, push.userId, push.notification);
      } catch (err) {
        this.deps.logger.warn({ err }, 'realtime push failed');
      }
    }
    for (const job of outbox.emails) {
      try {
        await this.deps.email.enqueue(job);
      } catch (err) {
        this.deps.logger.error({ err, notificationId: job.notificationId }, 'email enqueue failed');
        await uow.runAs(context, (db) =>
          db.notificationDelivery.create({
            data: {
              tenantId: job.tenantId,
              notificationId: job.notificationId,
              userId: job.userId,
              channel: 'email',
              status: 'failed',
              address: job.to,
              error: 'could not queue the email',
            },
          }),
        );
      }
    }
  }

  /** Sends one rule to its recipients inside the open transaction. */
  private async deliverRule(
    db: Db,
    event: NotifyEvent,
    rule: {
      id: string;
      companyId: string | null;
      titleTemplate: string;
      bodyTemplate: string;
    },
    recipients: Recipients,
    channels: Channel[],
    outbox: Outbox,
  ): Promise<number> {
    const users = await this.resolveRecipients(db, event, rule.companyId, recipients);
    if (users.length === 0) return 0;
    const prefs = await db.notificationPreference.findMany({
      where: {
        userId: { in: users.map((u) => u.id) },
        eventTypeKey: { in: [event.eventType, '*'] },
      },
    });
    const title = renderTemplate(rule.titleTemplate, event.payload).slice(0, 500);
    const body = renderTemplate(rule.bodyTemplate, event.payload);
    let created = 0;

    for (const user of users) {
      // A specific preference beats the "*" (everything) preference; no row = allowed.
      const allowed = (channel: Channel): boolean => {
        const own = prefs.filter((p) => p.userId === user.id && p.channel === channel);
        const specific = own.find((p) => p.eventTypeKey === event.eventType);
        return (specific ?? own.find((p) => p.eventTypeKey === '*'))?.enabled ?? true;
      };
      const wanted = channels.filter(allowed);
      if (wanted.length === 0) continue;

      const row = await db.notification.create({
        data: {
          tenantId: event.tenantId,
          companyId: event.companyId ?? rule.companyId,
          userId: user.id,
          eventTypeKey: event.eventType,
          ruleId: rule.id,
          title,
          body,
          data: event.payload as Prisma.InputJsonValue,
        },
      });
      created += 1;
      const view: NotificationView = {
        id: row.id,
        eventType: row.eventTypeKey,
        title,
        body,
        data: event.payload,
        createdAt: row.createdAt.toISOString(),
      };
      for (const channel of wanted) {
        if (channel === 'in_app') {
          await db.notificationDelivery.create({
            data: {
              tenantId: event.tenantId,
              notificationId: row.id,
              userId: user.id,
              channel,
              status: 'sent',
            },
          });
          outbox.pushes.push({ userId: user.id, notification: view });
        } else if (user.email === null) {
          await db.notificationDelivery.create({
            data: {
              tenantId: event.tenantId,
              notificationId: row.id,
              userId: user.id,
              channel,
              status: 'skipped',
              error: 'the user has no email address',
            },
          });
        } else {
          await db.notificationDelivery.create({
            data: {
              tenantId: event.tenantId,
              notificationId: row.id,
              userId: user.id,
              channel,
              status: 'queued',
              address: user.email,
            },
          });
          outbox.emails.push({
            tenantId: event.tenantId,
            userId: user.id,
            notificationId: row.id,
            to: user.email,
            subject: title,
            text: body === '' ? title : `${title}\n\n${body}`,
          });
        }
      }
    }
    return created;
  }

  /** Active users named by user id, by role, or by a field of the event payload. */
  private async resolveRecipients(
    db: Db,
    event: NotifyEvent,
    ruleCompanyId: string | null,
    recipients: Recipients,
  ): Promise<{ id: string; email: string | null }[]> {
    const ids = new Set<string>((recipients.userIds ?? []).filter((id) => UUID.test(id)));
    for (const field of recipients.payloadUserFields ?? []) {
      const value = event.payload[field];
      if (typeof value === 'string' && UUID.test(value)) ids.add(value);
    }
    const roleKeys = recipients.roleKeys ?? [];
    const companyId = event.companyId ?? ruleCompanyId;
    if (roleKeys.length > 0) {
      const rows = await db.$queryRaw<{ user_id: string }[]>`
        SELECT DISTINCT m.user_id::text AS user_id
          FROM iam.company_membership m
          JOIN iam.membership_role mr ON mr.membership_id = m.id
          JOIN iam.role r ON r.id = mr.role_id
         WHERE r.key = ANY (${roleKeys}::text[])
           AND m.deleted_at IS NULL
           AND (${companyId}::uuid IS NULL OR m.company_id = ${companyId}::uuid)`;
      for (const row of rows) ids.add(row.user_id);
    }
    if (ids.size === 0) return [];
    // Only active people, and only people of this tenant (row-level security enforces the
    // second condition; the query does not rely on the caller's list being clean).
    const users = await db.$queryRaw<{ id: string; email: string | null }[]>`
      SELECT id::text AS id, email
        FROM iam.user_account
       WHERE id = ANY (${[...ids]}::uuid[]) AND status = 'active' AND deleted_at IS NULL`;
    return users;
  }
}
