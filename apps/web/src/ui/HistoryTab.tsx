/**
 * HistoryTab: who changed a record, when, and which fields, read from
 * GET /history/{entityType}/{entityId} (the audit trail the database trigger writes).
 * Reusable on every record screen: pass the entity type (for example "iam.user_account")
 * and the record id. Shows nothing but the server's answer; it never edits history.
 * Depends on: api client, i18n, ui/components. Used by: record detail screens.
 */
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useI18n } from '../i18n';
import { EmptyState, ErrorAlert, Skeleton } from './components';

interface Entry {
  id: string;
  at: string;
  action: string;
  userId: string | null;
  impersonatorId: string | null;
  diff: unknown;
}

/** "field: old → new" lines from the trigger's diff object; anything else as plain JSON. */
export function describeDiff(diff: unknown): string[] {
  if (diff === null || typeof diff !== 'object') return [];
  return Object.entries(diff as Record<string, unknown>).map(([field, change]) => {
    if (change !== null && typeof change === 'object' && ('old' in change || 'new' in change)) {
      const c = change as { old?: unknown; new?: unknown };
      return `${field}: ${JSON.stringify(c.old ?? null)} → ${JSON.stringify(c.new ?? null)}`;
    }
    return `${field}: ${JSON.stringify(change)}`;
  });
}

export function HistoryTab({ entityType, entityId }: { entityType: string; entityId: string }) {
  const { t } = useI18n();
  const [items, setItems] = useState<Entry[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    api<{ items: Entry[] }>(`/history/${entityType}/${entityId}`, { query: { pageSize: 100 } })
      .then((r) => {
        if (!cancelled) setItems(r.items);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [entityType, entityId]);

  if (error !== null) return <ErrorAlert error={error} />;
  if (items === null) return <Skeleton lines={4} />;
  if (items.length === 0) return <EmptyState title={t('history.empty')} />;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{t('history.when')}</th>
            <th>{t('history.action')}</th>
            <th>{t('history.by')}</th>
            <th>{t('history.changes')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.id}>
              <td>{new Date(e.at).toLocaleString()}</td>
              <td>{e.action}</td>
              <td>{e.userId ?? '—'}</td>
              <td>
                {describeDiff(e.diff).map((line) => (
                  <div key={line}>{line}</div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
