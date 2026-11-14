/**
 * Organisation screens: Company settings and Branches.
 * Company: the companies you belong to, edit names, country, time zone, working week,
 * financial year start and status (the base currency is shown but cannot change; companies
 * are not created here). Branches: list, create, edit, set head office, delete with a
 * reason (the head office cannot be deleted; the API refuses it and the message is shown).
 * Zones and teams, number sequences and module flags have no API yet (see PROGRESS.md).
 * Depends on: api client, ui components, shared schemas. Used by: App.tsx routes.
 */
import { useCallback, useEffect, useState } from 'react';
import { Building2, MapPin, Pencil, Plus, Trash2 } from 'lucide-react';
import { branchCreateSchema, branchUpdateSchema, companyFormSchema } from '@fibrex/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, Field, PageHeader, Pill } from '../ui/components';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DataTable } from '../ui/DataTable';
import { EntityForm } from '../ui/EntityForm';
import { HistoryTab } from '../ui/HistoryTab';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

interface CompanyRow {
  id: string;
  legalName: string;
  tradeName: string | null;
  countryCode: string;
  baseCurrency: string;
  timeZone: string;
  workingWeek: string[];
  fiscalYearStartMonth: number;
  status: string;
  version: number;
}

export function CompanyPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const [rows, setRows] = useState<CompanyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<CompanyRow | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api<{ items: CompanyRow[] }>('/companies')
      .then((r) => {
        setRows(r.items);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);
  useEffect(load, [load]);

  const fields = [
    { name: 'legalName', label: t('company.legalName') },
    { name: 'tradeName', label: t('company.tradeName') },
    { name: 'countryCode', label: t('company.country'), hint: 'QA' },
    { name: 'timeZone', label: t('company.timeZone'), hint: 'Asia/Qatar' },
    {
      name: 'fiscalYearStartMonth',
      label: t('company.fiscalStart'),
      type: 'select' as const,
      options: Array.from({ length: 12 }, (_, i) => ({
        value: String(i + 1),
        label: new Date(2000, i, 1).toLocaleString('en', { month: 'long' }),
      })),
    },
    {
      name: 'status',
      label: t('company.status'),
      type: 'select' as const,
      options: [
        { value: 'active', label: t('company.active') },
        { value: 'inactive', label: t('company.inactive') },
      ],
    },
    ...DAYS.map((d) => ({
      name: `day_${d}`,
      label: t(`day.${d}`),
      type: 'checkbox' as const,
    })),
  ];

  return (
    <>
      <PageHeader title={t('company.title')} icon={Building2} description={t('company.intro')} />
      {editing !== null ? (
        <section className="card">
          <p>
            {t('company.baseCurrency')}: <strong>{editing.baseCurrency}</strong>
          </p>
          <EntityForm
            key={`${editing.id}-${String(editing.version)}`}
            fields={fields}
            schema={companyFormSchema}
            initial={{
              legalName: editing.legalName,
              tradeName: editing.tradeName ?? '',
              countryCode: editing.countryCode,
              timeZone: editing.timeZone,
              fiscalYearStartMonth: String(editing.fiscalYearStartMonth),
              status: editing.status,
              ...Object.fromEntries(DAYS.map((d) => [`day_${d}`, editing.workingWeek.includes(d)])),
            }}
            onCancel={() => {
              setEditing(null);
            }}
            onSubmit={async (values) => {
              const workingWeek = DAYS.filter((d) => values[`day_${d}`] === true);
              // The day tick boxes only exist to build workingWeek; they are not API fields.
              const rest = Object.fromEntries(
                Object.entries(values).filter(([k]) => !k.startsWith('day_')),
              );
              await api(`/companies/${editing.id}`, {
                method: 'PATCH',
                body: { ...rest, workingWeek },
                headers: { 'If-Match': `"${String(editing.version)}"` },
              });
              setEditing(null);
              load();
            }}
          />
          <h2>{t('history.title')}</h2>
          <HistoryTab entityType="platform.company" entityId={editing.id} />
        </section>
      ) : null}
      <DataTable
        columns={[
          { key: 'legalName', header: t('company.legalName'), value: (r) => r.legalName },
          { key: 'tradeName', header: t('company.tradeName'), value: (r) => r.tradeName },
          { key: 'country', header: t('company.country'), value: (r) => r.countryCode },
          { key: 'currency', header: t('company.baseCurrency'), value: (r) => r.baseCurrency },
          { key: 'timeZone', header: t('company.timeZone'), value: (r) => r.timeZone },
          {
            key: 'status',
            header: t('company.status'),
            value: (r) => r.status,
            render: (r) => (
              <Pill tone={r.status === 'active' ? 'success' : 'neutral'}>
                {r.status === 'active' ? t('company.active') : t('company.inactive')}
              </Pill>
            ),
          },
        ]}
        rows={rows}
        rowKey={(r) => r.id}
        total={rows.length}
        page={1}
        pageSize={Math.max(rows.length, 1)}
        onPageChange={() => undefined}
        loading={loading}
        error={error}
        exportName="companies"
        actions={(r) =>
          auth.can('platform.company.update') ? (
            <Button
              variant="link"
              icon={Pencil}
              onClick={() => {
                setEditing(r);
              }}
            >
              {t('common.edit')}
            </Button>
          ) : null
        }
      />
    </>
  );
}

interface BranchRow {
  id: string;
  code: string;
  name: string;
  address: string | null;
  isHeadOffice: boolean;
  version: number;
}

export function BranchesPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: BranchRow[]; total: number }>({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<BranchRow | 'new' | null>(null);
  const [removing, setRemoving] = useState<BranchRow | null>(null);
  const [reason, setReason] = useState('');
  const pageSize = 25;

  const load = useCallback(() => {
    setLoading(true);
    api<{ items: BranchRow[]; total: number }>('/branches', { query: { page, pageSize } })
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
  }, [page]);
  useEffect(load, [load]);

  const fields = [
    { name: 'code', label: t('branches.code') },
    { name: 'name', label: t('branches.name') },
    { name: 'address', label: t('branches.address'), type: 'textarea' as const },
    { name: 'isHeadOffice', label: t('branches.headOffice'), type: 'checkbox' as const },
  ];

  return (
    <>
      <PageHeader
        title={t('branches.title')}
        icon={MapPin}
        description={t('branches.intro')}
        actions={
          auth.can('platform.branch.create') ? (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setEditing('new');
              }}
            >
              {t('branches.new')}
            </Button>
          ) : null
        }
      />
      {editing !== null ? (
        <section className="card">
          <EntityForm
            key={editing === 'new' ? 'new' : `${editing.id}-${String(editing.version)}`}
            fields={fields}
            schema={editing === 'new' ? branchCreateSchema : branchUpdateSchema}
            initial={
              editing === 'new'
                ? {}
                : {
                    code: editing.code,
                    name: editing.name,
                    address: editing.address ?? '',
                    isHeadOffice: editing.isHeadOffice,
                  }
            }
            onCancel={() => {
              setEditing(null);
            }}
            onSubmit={async (values) => {
              if (editing === 'new') {
                await api('/branches', { method: 'POST', body: values });
              } else {
                await api(`/branches/${editing.id}`, {
                  method: 'PATCH',
                  body: values,
                  headers: { 'If-Match': `"${String(editing.version)}"` },
                });
              }
              setEditing(null);
              load();
            }}
          />
          {editing !== 'new' ? (
            <>
              <h2>{t('history.title')}</h2>
              <HistoryTab entityType="platform.branch" entityId={editing.id} />
            </>
          ) : null}
        </section>
      ) : null}
      <DataTable
        columns={[
          { key: 'code', header: t('branches.code'), value: (r) => r.code },
          { key: 'name', header: t('branches.name'), value: (r) => r.name },
          { key: 'address', header: t('branches.address'), value: (r) => r.address },
          {
            key: 'head',
            header: t('branches.headOffice'),
            value: (r) => (r.isHeadOffice ? t('common.yes') : t('common.no')),
            render: (r) =>
              r.isHeadOffice ? (
                <Pill tone="accent" icon={Building2}>
                  {t('branches.headOffice')}
                </Pill>
              ) : (
                '—'
              ),
          },
        ]}
        rows={data.items}
        rowKey={(r) => r.id}
        total={data.total}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        loading={loading}
        error={error}
        exportName="branches"
        actions={(r) => (
          <>
            {auth.can('platform.branch.update') ? (
              <Button
                variant="link"
                icon={Pencil}
                onClick={() => {
                  setEditing(r);
                }}
              >
                {t('common.edit')}
              </Button>
            ) : null}
            {auth.can('platform.branch.delete') ? (
              <Button
                variant="link"
                dangerText
                icon={Trash2}
                onClick={() => {
                  setRemoving(r);
                }}
              >
                {t('common.delete')}
              </Button>
            ) : null}
          </>
        )}
      />
      <ConfirmDialog
        open={removing !== null}
        danger
        title={t('common.delete')}
        onCancel={() => {
          setRemoving(null);
        }}
        onConfirm={() => {
          if (removing === null || reason.trim() === '') return;
          api(`/branches/${removing.id}`, {
            method: 'DELETE',
            body: { reason: reason.trim() },
            headers: { 'If-Match': `"${String(removing.version)}"` },
          })
            .then(() => {
              setRemoving(null);
              setReason('');
              load();
            })
            .catch((e: unknown) => {
              setRemoving(null);
              setError(e);
            });
        }}
      >
        <Field
          label={t('users.deleteReason')}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
          }}
        />
      </ConfirmDialog>
    </>
  );
}
