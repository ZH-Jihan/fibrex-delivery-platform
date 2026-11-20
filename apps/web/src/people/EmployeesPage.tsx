/**
 * Employees screen (phase 3 row 3.3a): list with search and filters, create form (a new
 * person with identity numbers, phones, names in English, Arabic and Bangla, nationality,
 * sponsorship, agent and first profession) and edit form (employment fields only).
 * The profile page, documents and placement history are row 3.3b.
 *
 * Rules, and why:
 *   - The form is flat and checked by the shared `employeeFormSchema`; the same file turns it
 *     into the nested API body, so the API's own schema agrees with what the screen sends.
 *   - QID and passport go to the API as typed; it seals them. They are never shown in the list.
 *   - Editing never changes the person or the status (party screen, state machine).
 *   - A phone already used by someone else is a warning (409 possible_duplicate): the person
 *     may tick "create anyway" because families share phones. Same QID or passport is refused.
 *   - Bank account: added on the profile (3.3b) through the party bank-account flow, which
 *     needs a second person's approval, so the form only points to it.
 *
 * Depends on: api client, DataTable, EntityForm, i18n, @fibrex/shared (people). Used by: App.tsx.
 */
import { useCallback, useEffect, useState } from 'react';
import { IdCard, Pencil, Plus } from 'lucide-react';
import {
  employeeEditFormSchema,
  employeeEditToUpdate,
  employeeFormSchema,
  employeeFormToCreate,
  type EmployeeEditFormValues,
  type EmployeeFormValues,
} from '@fibrex/shared';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, Pill, PageHeader } from '../ui/components';
import { DataTable } from '../ui/DataTable';
import { EntityForm, type FormField } from '../ui/EntityForm';

export interface EmployeeRow {
  id: string;
  employeeCode: string;
  displayName: string;
  statusCode: string;
  sponsorship: string;
  sponsorPartyId: string | null;
  recruitingAgentPartyId: string | null;
  joiningDate: string | null;
  version: number;
}
interface Option {
  value: string;
  label: string;
}

const STATUS_TONE: Record<string, 'success' | 'neutral' | 'danger' | 'warning'> = {
  active: 'success',
  inactive: 'neutral',
  blocked: 'danger',
  terminated: 'warning',
};

/** Starting values of the edit form, from a list row. */
export function employeeEditInitial(row: EmployeeRow): Record<string, unknown> {
  return {
    sponsorship: row.sponsorship,
    sponsorPartyId: row.sponsorPartyId ?? '',
    recruitingAgentPartyId: row.recruitingAgentPartyId ?? '',
    joiningDate: row.joiningDate ?? '',
  };
}

/** Organisations (sponsors, agents) and professions for the dropdowns; empty on failure. */
function useChoices(enabled: boolean) {
  const [parties, setParties] = useState<Option[]>([]);
  const [professions, setProfessions] = useState<Option[]>([]);
  useEffect(() => {
    if (!enabled) return;
    api<{ items: { id: string; displayName: string }[] }>('/parties', {
      query: { kind: 'organisation', pageSize: 100 },
    })
      .then((r) => {
        setParties(r.items.map((p) => ({ value: p.id, label: p.displayName })));
      })
      .catch(() => {
        setParties([]);
      });
    api<{ items: { code: string; label: Record<string, string> | string }[] }>(
      '/lookups/profession',
    )
      .then((r) => {
        setProfessions(
          r.items.map((l) => ({
            value: l.code,
            label: typeof l.label === 'string' ? l.label : (l.label.en ?? l.code),
          })),
        );
      })
      .catch(() => {
        setProfessions([]);
      });
  }, [enabled]);
  return { parties, professions };
}

export function EmployeesPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [sponsorship, setSponsorship] = useState('');
  const [data, setData] = useState<{ items: EmployeeRow[]; total: number }>({
    items: [],
    total: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<EmployeeRow | null>(null);
  const pageSize = 25;
  const { parties, professions } = useChoices(creating || editing !== null);

  const load = useCallback(() => {
    setLoading(true);
    api<{ items: EmployeeRow[]; total: number }>('/employees', {
      query: {
        page,
        pageSize,
        q: q.trim() === '' ? undefined : q.trim(),
        statusCode: status === '' ? undefined : status,
        sponsorship: sponsorship === '' ? undefined : sponsorship,
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
  }, [page, q, status, sponsorship]);
  useEffect(() => {
    const timer = setTimeout(load, q === '' ? 0 : 250);
    return () => {
      clearTimeout(timer);
    };
  }, [load, q]);

  const sponsorshipOptions: Option[] = [
    { value: 'company', label: t('employees.sponsorship.company') },
    { value: 'outside', label: t('employees.sponsorship.outside') },
  ];
  const partyOptions: Option[] = [{ value: '', label: t('common.choose') }, ...parties];
  const sharedFields: FormField[] = [
    {
      name: 'sponsorship',
      label: t('employees.sponsorship'),
      type: 'select',
      options: sponsorshipOptions,
    },
    {
      name: 'sponsorPartyId',
      label: t('employees.sponsor'),
      type: 'select',
      options: partyOptions,
      hint: t('employees.sponsorHint'),
    },
    {
      name: 'recruitingAgentPartyId',
      label: t('employees.agent'),
      type: 'select',
      options: partyOptions,
    },
    { name: 'joiningDate', label: t('employees.joiningDate'), hint: 'YYYY-MM-DD' },
  ];
  const createFields: FormField[] = [
    { name: 'displayName', label: t('employees.nameEn') },
    { name: 'nameAr', label: t('employees.nameAr') },
    { name: 'nameBn', label: t('employees.nameBn') },
    { name: 'phones', label: t('employees.phones'), type: 'tel', hint: t('employees.phonesHint') },
    { name: 'qid', label: t('employees.qid') },
    { name: 'passport', label: t('employees.passport') },
    { name: 'nationalityCode', label: t('people.nationality'), hint: 'QA, BD, IN ...' },
    {
      name: 'profession',
      label: t('employees.profession'),
      type: 'select',
      options: [{ value: '', label: t('common.choose') }, ...professions],
    },
    ...sharedFields,
    {
      name: 'acknowledgeDuplicates',
      label: t('employees.createAnyway'),
      type: 'checkbox',
    },
  ];

  return (
    <>
      <PageHeader
        title={t('employees.title')}
        icon={IdCard}
        description={t('employees.intro')}
        actions={
          auth.can('people.employee.create') ? (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setEditing(null);
                setCreating(true);
              }}
            >
              {t('employees.new')}
            </Button>
          ) : null
        }
      />
      {creating ? (
        <section className="card">
          <EntityForm
            fields={createFields}
            initial={{ sponsorship: 'company' }}
            schema={employeeFormSchema}
            onCancel={() => {
              setCreating(false);
            }}
            onSubmit={async (values) => {
              await api('/employees', {
                method: 'POST',
                body: employeeFormToCreate(values as EmployeeFormValues),
              });
              setCreating(false);
              load();
            }}
          />
          <p className="muted">{t('employees.bankLater')}</p>
        </section>
      ) : null}
      {editing ? (
        <section className="card">
          <h2>
            {editing.employeeCode} {editing.displayName}
          </h2>
          <EntityForm
            fields={sharedFields}
            initial={employeeEditInitial(editing)}
            schema={employeeEditFormSchema}
            onCancel={() => {
              setEditing(null);
            }}
            onSubmit={async (values) => {
              await api(`/employees/${editing.id}`, {
                method: 'PATCH',
                body: employeeEditToUpdate(values as EmployeeEditFormValues),
                headers: { 'If-Match': `"${String(editing.version)}"` },
              });
              setEditing(null);
              load();
            }}
          />
        </section>
      ) : null}
      <DataTable
        columns={[
          { key: 'code', header: t('employees.code'), value: (e) => e.employeeCode },
          { key: 'name', header: t('users.displayName'), value: (e) => e.displayName },
          {
            key: 'status',
            header: t('employees.status'),
            value: (e) => e.statusCode,
            render: (e) => (
              <Pill tone={STATUS_TONE[e.statusCode] ?? 'neutral'}>{e.statusCode}</Pill>
            ),
          },
          {
            key: 'sponsorship',
            header: t('employees.sponsorship'),
            value: (e) => e.sponsorship,
          },
          { key: 'joined', header: t('employees.joiningDate'), value: (e) => e.joiningDate },
        ]}
        rows={data.items}
        rowKey={(e) => e.id}
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
        exportName="employees"
        actions={(e) => (
          <>
            <Link to={`/employees/${e.id}`} className="btn btn-link">
              {t('employees.open')}
            </Link>
            {auth.can('people.employee.update') ? (
              <Button
                variant="link"
                icon={Pencil}
                onClick={() => {
                  setCreating(false);
                  setEditing(e);
                }}
              >
                {t('common.edit')}
              </Button>
            ) : null}
          </>
        )}
        toolbar={
          <>
            <select
              aria-label={t('employees.status')}
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">{t('employees.status')}</option>
              {['active', 'inactive', 'blocked', 'terminated'].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select
              aria-label={t('employees.sponsorship')}
              value={sponsorship}
              onChange={(e) => {
                setSponsorship(e.target.value);
                setPage(1);
              }}
            >
              <option value="">{t('employees.sponsorship')}</option>
              {sponsorshipOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </>
        }
      />
    </>
  );
}
