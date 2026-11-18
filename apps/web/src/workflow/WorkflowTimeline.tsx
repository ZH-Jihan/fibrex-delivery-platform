/**
 * Workflow timeline (phase 2 row 2.11b; PLAN 5.9 "Workflow").
 *
 * Purpose: shows what happened in the approval workflows of one record (who was asked,
 * who approved, rejected, sent back or commented, reminders and escalations), read from
 * GET /workflow-instances. `InstanceTimeline` draws one workflow by id (the task inbox
 * uses it); `WorkflowTimeline` finds the workflows of a record and draws each one (record
 * pages use it). It only reads: acting on tasks happens in the inbox.
 *
 * Depends on: api client, i18n, ui components.
 * Used by: records/RecordPages.tsx, workflow/InboxPage.tsx.
 */
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useI18n } from '../i18n';
import { ErrorAlert, Pill, Skeleton } from '../ui/components';

export interface WorkflowInstanceItem {
  id: string;
  status: 'running' | 'approved' | 'rejected' | 'cancelled';
  createdAt: string;
  completedAt: string | null;
}
export interface WorkflowEventItem {
  id: string;
  kind: string;
  stepKey: string | null;
  actorId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}
interface InstanceView {
  instance: WorkflowInstanceItem;
  definition: { name: string };
  events: WorkflowEventItem[];
}

const TONES = {
  running: 'info',
  approved: 'success',
  rejected: 'danger',
  cancelled: 'neutral',
} as const;

/** The comment or reason an event carries, if any (kept in the event's detail). */
export function eventNote(detail: Record<string, unknown>): string {
  const note = detail.comment ?? detail.reason;
  return typeof note === 'string' ? note : '';
}

/** One workflow: its status and every event, oldest first. */
export function InstanceTimeline({ instanceId }: { instanceId: string }) {
  const { t, tOr } = useI18n();
  const [view, setView] = useState<InstanceView | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    api<InstanceView>(`/workflow-instances/${instanceId}`)
      .then((r) => {
        if (!cancelled) setView(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [instanceId]);

  if (error !== null) return <ErrorAlert error={error} />;
  if (view === null) return <Skeleton lines={3} />;
  const events = [...view.events].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return (
    <div role="group" aria-label={view.definition.name}>
      <h3>
        {view.definition.name}{' '}
        <Pill tone={TONES[view.instance.status]}>{t(`wf.status.${view.instance.status}`)}</Pill>
      </h3>
      <ol className="timeline">
        {events.map((e) => (
          <li key={e.id}>
            <strong>{tOr(`wf.event.${e.kind}`, e.kind)}</strong>
            {e.stepKey === null ? null : <span> · {e.stepKey}</span>}
            <span> · {new Date(e.createdAt).toLocaleString()}</span>
            {eventNote(e.detail) === '' ? null : <p>{eventNote(e.detail)}</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Every workflow of a record. Shows nothing when there are none (or none may be read). */
export function WorkflowTimeline({
  entityType,
  entityId,
}: {
  entityType: string;
  entityId: string;
}) {
  const { t } = useI18n();
  const [items, setItems] = useState<WorkflowInstanceItem[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ items: WorkflowInstanceItem[] }>('/workflow-instances', {
      query: { entityType, entityId },
    })
      .then((r) => {
        if (!cancelled) setItems(r.items);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [entityType, entityId]);

  if (items === null || items.length === 0) return null;
  return (
    <section aria-label={t('wf.timeline')}>
      <h3>{t('wf.timeline')}</h3>
      {items.map((i) => (
        <InstanceTimeline key={i.id} instanceId={i.id} />
      ))}
    </section>
  );
}
