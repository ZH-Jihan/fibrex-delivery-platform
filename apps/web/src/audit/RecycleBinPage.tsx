/**
 * Recycle bin screen: pick a record type (with its count of deleted records), see the deleted
 * records with when and why, and restore one. Restoring is audited by the API.
 * Depends on: api client, DataTable, i18n. Used by: App.tsx.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, EmptyState, ErrorAlert } from '../ui/components';
import { DataTable } from '../ui/DataTable';
import { useToast } from '../ui/toast';

interface TypeSummary {
  entityType: string;
  label: string;
  count: number;
}
interface Item {
  id: string;
  description: string;
  deletedAt: string | null;
  deleteReason: string | null;
}
interface Answer {
  types: TypeSummary[];
  items: Item[];
  total: number;
}

export function RecycleBinPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Answer>({ types: [], items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const pageSize = 25;

  const load = useCallback(() => {
    setLoading(true);
    api<Answer>('/recycle-bin', {
      query: { page, pageSize, entityType: type === '' ? undefined : type },
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
  }, [page, type]);
  useEffect(load, [load]);

  const restore = (item: Item) => {
    api(`/recycle-bin/${type}/${item.id}/restore`, { method: 'POST', body: {} })
      .then(() => {
        toast.show(t('bin.restored'), 'success');
        load();
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };

  return (
    <>
      <h1>{t('bin.title')}</h1>
      <ErrorAlert error={error} />
      <label>
        {t('bin.type')}
        <select
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            setPage(1);
          }}
        >
          <option value="">—</option>
          {data.types.map((s) => (
            <option key={s.entityType} value={s.entityType}>
              {s.label} ({s.count})
            </option>
          ))}
        </select>
      </label>
      {type === '' ? (
        <EmptyState title={t('bin.pick')} />
      ) : (
        <DataTable
          columns={[
            { key: 'what', header: t('bin.record'), value: (i) => i.description },
            {
              key: 'at',
              header: t('bin.deletedAt'),
              value: (i) => i.deletedAt,
              render: (i) => (i.deletedAt === null ? '—' : new Date(i.deletedAt).toLocaleString()),
            },
            { key: 'why', header: t('users.deleteReason'), value: (i) => i.deleteReason },
          ]}
          rows={data.items}
          rowKey={(i) => i.id}
          total={data.total}
          page={page}
          pageSize={pageSize}
          onPageChange={setPage}
          loading={loading}
          exportName="recycle-bin"
          actions={
            auth.can('recycle_bin.restore')
              ? (i) => (
                  <Button
                    onClick={() => {
                      restore(i);
                    }}
                  >
                    {t('bin.restore')}
                  </Button>
                )
              : undefined
          }
        />
      )}
    </>
  );
}
