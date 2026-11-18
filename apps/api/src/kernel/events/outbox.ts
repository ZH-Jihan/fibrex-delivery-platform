/**
 * Event outbox writer (phase 2 row 2.12; PLAN 2.6 "Outbox").
 *
 * Purpose: a service announces that something happened by writing one row to
 * `integration.outbox_event` inside the transaction that made the change. The change and
 * its event therefore commit together or not at all: there is no window in which a
 * notification or webhook goes out for a change a rollback removed, and no crash between
 * "saved" and "announced" can lose an event.
 *
 * Nothing is sent from here. After the commit the unit of work's `afterCommit` hook nudges
 * the relay (./relay.ts), which hands the event to its consumers in the background; the
 * relay's recurring run catches anything a nudge missed (for example after a restart).
 *
 * The tenant comes from the open unit of work, never from the caller. The company must be
 * one the transaction may write (row-level security checks it again).
 *
 * Depends on: kernel/db/unit-of-work.ts. Used by: src/main.ts (workflow events), modules
 * through their service code, ./relay.ts (nudge target), test/integration/events.test.ts.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { currentUnit } from '../db/unit-of-work.js';

const EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const AGGREGATE_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

export interface OutboxEventInput {
  /** Registered event type key, for example "workflow.task_assigned". */
  eventType: string;
  /** Shape version of the payload; consumers branch on it when a payload changes. */
  eventVersion?: number;
  /** The company the event belongs to; null for tenant-level events. */
  companyId: string | null;
  /** What changed, for example "platform.workflow_instance". */
  aggregateType: string;
  aggregateId?: string | null;
  /** Plain JSON. Never secrets: webhook subscribers receive it as written. */
  payload: Record<string, unknown>;
}

/** Called after a commit that wrote at least one event (the relay's nudge). */
export type OutboxNudge = () => void;

export class EventOutbox {
  #nudge: OutboxNudge | undefined;

  /** Set by the relay once it runs; before that, the recurring job picks events up. */
  onCommitted(nudge: OutboxNudge): void {
    this.#nudge = nudge;
  }

  /** Writes the event in the open transaction; returns its id. */
  async record(event: OutboxEventInput): Promise<string> {
    if (!EVENT_TYPE.test(event.eventType)) {
      throw new Error(`Outbox: invalid event type "${event.eventType}"`);
    }
    if (!AGGREGATE_TYPE.test(event.aggregateType)) {
      throw new Error(`Outbox: invalid aggregate type "${event.aggregateType}"`);
    }
    const { db, context, afterCommit } = currentUnit();
    const row = await db.outboxEvent.create({
      data: {
        tenantId: context.tenantId,
        companyId: event.companyId,
        eventTypeKey: event.eventType,
        eventVersion: event.eventVersion ?? 1,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId ?? null,
        payload: event.payload as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    afterCommit(() => {
      this.#nudge?.();
      return Promise.resolve();
    });
    return row.id;
  }
}
