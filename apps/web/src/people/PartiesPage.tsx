/**
 * People screen: search and page through parties (people and organisations), and create one.
 * A party lives once and other modules point to it (SPEC 2.8). Detail screens with contacts,
 * identifiers and documents arrive with Phase 3.
 * Depends on: api client, DataTable, EntityForm, i18n. Used by: App.tsx.
 */
import { useCallback, useEffect, useState } from 'react';
import { Contact, Plus } from 'lucide-react';
import { partyQuickCreateSchema } from '@fibrex/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, PageHeader } from '../ui/components';
import { DataTable } from '../ui/DataTable';
import { EntityForm } from '../ui/EntityForm';

interface Party {
  id: string;
  kind: string;
  displayName: string;
  nationalityCode: string | null;
}

export function PartiesPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [data, setData] = useState<{ items: Party[]; total: number }>({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const pageSize = 25;

  const load = useCallback(() => {
    setLoading(true);
    api<{ items: Party[]; total: number }>('/parties', {
      query: {
        page,
        pageSize,
        q: q.trim() === '' ? undefined : q.trim(),
        kind: kind === '' ? undefined : kind,
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
  }, [page, q, kind]);
  useEffect(() => {
    const timer = setTimeout(load, q === '' ? 0 : 250);
    return () => {
      clearTimeout(timer);
    };
  }, [load, q]);

  return (
    <>
      <PageHeader
        title={t('people.title')}
        icon={Contact}
        description={t('people.intro')}
        actions={
          auth.can('party.party.create') ? (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setCreating(true);
              }}
            >
              {t('people.new')}
            </Button>
          ) : null
        }
      />
      {creating ? (
        <section className="card">
          <EntityForm
            fields={[
              { name: 'displayName', label: t('users.displayName') },
              { name: 'kind', label: t('people.kind'), hint: 'person / organisation' },
            ]}
            initial={{ kind: 'person' }}
            schema={partyQuickCreateSchema}
            onCancel={() => {
              setCreating(false);
            }}
            onSubmit={async (values) => {
              await api('/parties', { method: 'POST', body: values });
              setCreating(false);
              load();
            }}
          />
        </section>
      ) : null}
      <DataTable
        columns={[
          { key: 'name', header: t('users.displayName'), value: (p) => p.displayName },
          { key: 'kind', header: t('people.kind'), value: (p) => p.kind },
          { key: 'nat', header: t('people.nationality'), value: (p) => p.nationalityCode },
        ]}
        rows={data.items}
        rowKey={(p) => p.id}
        total={data.total}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        search={q}
        onSearch={(text) => {
          setQ(text);
          setPage(1);
        }}
        loading={loading}
        error={error}
        exportName="people"
        toolbar={
          <select
            aria-label={t('people.kind')}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setPage(1);
            }}
          >
            <option value="">{t('people.kind')}</option>
            <option value="person">person</option>
            <option value="organisation">organisation</option>
          </select>
        }
      />
    </>
  );
}
