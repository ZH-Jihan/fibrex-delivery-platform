/**
 * Audit log screen: filter by module, action and entity type; page through entries; verify
 * the hash chain. Read-only: it never edits history.
 * Depends on: api client, DataTable, i18n. Used by: App.tsx.
 */
import { useCallback, useEffect, useState } from 'react';
import { CircleCheck, CircleX, ScrollText, ShieldCheck } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, ErrorAlert, PageHeader, Pill } from '../ui/components';
import { DataTable } from '../ui/DataTable';
import type { Column } from '../ui/DataTable';
import { describeDiff } from '../ui/HistoryTab';

interface Entry {
  id: string;
  at: string;
  userId: string | null;
  moduleKey: string;
  entityType: string;
  entityId: string | null;
  action: string;
  diff: unknown;
}
interface Verification {
  ok: boolean;
  sealsChecked: number;
  rowsChecked: number;
}

export function AuditPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const [page, setPage] = useState(1);
  const [moduleKey, setModuleKey] = useState('');
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [data, setData] = useState<{ items: Entry[]; total: number }>({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [verified, setVerified] = useState<Verification | null>(null);
  const pageSize = 50;

  const load = useCallback(() => {
    setLoading(true);
    const blank = (v: string) => (v.trim() === '' ? undefined : v.trim());
    api<{ items: Entry[]; total: number }>('/audit-log', {
      query: {
        page,
        pageSize,
        module: blank(moduleKey),
        action: blank(action),
        entityType: blank(entityType),
      },
    })
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [page, moduleKey, action, entityType]);
  useEffect(() => {
    const timer = setTimeout(load, 250);
    return () => {
      clearTimeout(timer);
    };
  }, [load]);

  const columns: Column<Entry>[] = [
    {
      key: 'at',
      header: t('history.when'),
      value: (e) => e.at,
      render: (e) => new Date(e.at).toLocaleString(),
    },
    { key: 'user', header: t('history.by'), value: (e) => e.userId },
    { key: 'module', header: t('audit.module'), value: (e) => e.moduleKey },
    { key: 'entity', header: t('audit.entity'), value: (e) => e.entityType },
    { key: 'action', header: t('history.action'), value: (e) => e.action },
    {
      key: 'diff',
      header: t('history.changes'),
      value: (e) => describeDiff(e.diff).join('; '),
    },
  ];

  const filter = (label: string, value: string, set: (v: string) => void) => (
    <input
      aria-label={label}
      placeholder={label}
      value={value}
      onChange={(e) => {
        set(e.target.value);
        setPage(1);
      }}
    />
  );

  return (
    <>
      <PageHeader
        title={t('audit.title')}
        icon={ScrollText}
        description={t('audit.intro')}
        actions={
          auth.can('audit.log.verify') ? (
            <Button
              icon={ShieldCheck}
              onClick={() => {
                api<Verification>('/audit-log/verify')
                  .then(setVerified)
                  .catch((e: unknown) => {
                    setError(e);
                  });
              }}
            >
              {t('audit.verify')}
            </Button>
          ) : null
        }
      />
      {verified === null ? null : (
        <p role="status">
          <Pill
            tone={verified.ok ? 'success' : 'danger'}
            icon={verified.ok ? CircleCheck : CircleX}
          >
            {verified.ok ? t('audit.intact') : t('audit.broken')} ({verified.sealsChecked} /{' '}
            {verified.rowsChecked})
          </Pill>
        </p>
      )}
      <ErrorAlert error={error} />
      <DataTable
        columns={columns}
        rows={data.items}
        rowKey={(e) => e.id}
        total={data.total}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        loading={loading}
        exportName="audit-log"
        toolbar={
          <>
            {filter(t('audit.module'), moduleKey, setModuleKey)}
            {filter(t('history.action'), action, setAction)}
            {filter(t('audit.entity'), entityType, setEntityType)}
          </>
        }
      />
    </>
  );
}
