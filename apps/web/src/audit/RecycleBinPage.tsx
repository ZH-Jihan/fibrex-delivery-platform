/**
 * Recycle bin screen: pick a record type (with its count of deleted records), see the deleted
 * records with when and why, and restore one. Restoring is audited by the API.
 * Depends on: api client, DataTable, i18n. Used by: App.tsx.
 */
import { useCallback, useEffect, useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, EmptyState, ErrorAlert, PageHeader, Select } from '../ui/components';
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
      <PageHeader title={t('bin.title')} icon={Trash2} description={t('bin.intro')} />
      <ErrorAlert error={error} />
      <Select
        label={t('bin.type')}
        value={type}
        placeholder="—"
        options={data.types.map((s) => ({
          value: s.entityType,
          label: `${s.label} (${String(s.count)})`,
        }))}
        onChange={(e) => {
          setType(e.target.value);
          setPage(1);
        }}
      />
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
                    variant="link"
                    icon={RotateCcw}
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
