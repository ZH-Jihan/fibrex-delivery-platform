/**
 * Event browser (phase 2 row 2.12; PLAN 5.10 "GET /events").
 *
 * Purpose: show what happened, newest first: every event written to the outbox for the
 * user's companies (and tenant-level events), with which consumers have handled it
 * (relay, notification rules, webhooks). An event the relay has not handed on yet shows
 * as "waiting", which is how an administrator sees that background work is stuck.
 *
 * Depends on: api client, i18n, ui components. Used by: App.tsx route /organisation/events.
 */
import { useCallback, useEffect, useState } from 'react';
import { Radio } from 'lucide-react';
import { api } from '../api/client';
import { useI18n } from '../i18n';
import { ErrorAlert, PageHeader, Pill, Select } from '../ui/components';
import { DataTable } from '../ui/DataTable';

interface OutboxEvent {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
  handledBy: { consumer: string; processedAt: string }[];
}

const PAGE_SIZE = 50;

/** Consumers that handled the event, the relay itself left out; null while it waits. */
export function handledSummary(event: Pick<OutboxEvent, 'handledBy'>): string[] | null {
  const keys = event.handledBy.map((h) => h.consumer);
  if (!keys.includes('outbox.relay')) return null;
  return keys.filter((k) => k !== 'outbox.relay');
}

export function EventsPage() {
  const { t } = useI18n();
  const [rows, setRows] = useState<OutboxEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [type, setType] = useState('');
  const [types, setTypes] = useState<{ key: string; label: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api<{ items: { key: string; label: string }[] }>('/event-types')
      .then((r) => {
        setTypes(r.items);
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    api<{ items: OutboxEvent[]; total: number }>('/events', {
      query: { page, pageSize: PAGE_SIZE, ...(type === '' ? {} : { type }) },
    })
      .then((r) => {
        setRows(r.items);
        setTotal(r.total);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [page, type]);
  useEffect(load, [load]);

  return (
    <>
      <PageHeader title={t('ev.title')} icon={Radio} description={t('ev.intro')} />
      {error !== null && !loading ? <ErrorAlert error={error} /> : null}
      <Select
        label={t('wh.eventType')}
        placeholder={t('ev.allTypes')}
        value={type}
        options={types.map((x) => ({ value: x.key, label: `${x.label} (${x.key})` }))}
        onChange={(e) => {
          setType(e.target.value);
          setPage(1);
        }}
      />
      <DataTable
        columns={[
          {
            key: 'when',
            header: t('wh.when'),
            value: (r: OutboxEvent) => new Date(r.occurredAt).toLocaleString(),
          },
          { key: 'type', header: t('wh.eventType'), value: (r: OutboxEvent) => r.eventType },
          {
            key: 'about',
            header: t('ev.about'),
            value: (r: OutboxEvent) => `${r.aggregateType} ${r.aggregateId ?? ''}`.trim(),
          },
          {
            key: 'handled',
            header: t('ev.handled'),
            value: (r: OutboxEvent) => handledSummary(r)?.join(', ') ?? t('ev.waiting'),
            render: (r: OutboxEvent) => {
              const done = handledSummary(r);
              return done === null ? (
                <Pill tone="warning">{t('ev.waiting')}</Pill>
              ) : (
                <Pill tone="success">{done.length === 0 ? t('ev.handedOn') : done.join(', ')}</Pill>
              );
            },
          },
          {
            key: 'data',
            header: t('ev.data'),
            value: (r: OutboxEvent) => JSON.stringify(r.payload).slice(0, 200),
          },
        ]}
        rows={rows}
        rowKey={(r) => r.id}
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
        loading={loading}
        error={null}
        exportName="events"
      />
    </>
  );
}
