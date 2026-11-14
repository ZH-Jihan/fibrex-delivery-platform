/**
 * Users screens: the list (search, status filter, paging, create) and the user detail with
 * tabs for profile, sessions, sign-in history and the record History.
 * Every button is shown only when `can()` says the user may press it; the API checks again.
 * Edits send the version in If-Match, so two people editing one user get a 409, not a
 * silent overwrite. Deleting needs a reason (the API refuses without one).
 * Depends on: api client, ui components, shared schemas. Used by: App.tsx routes.
 */
import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Lock, LockOpen, LogOut, Plus, Trash2, Users } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { userCreateSchema, userUpdateSchema } from '@fibrex/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, ErrorAlert, Field, PageHeader, Pill, Skeleton } from '../ui/components';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DataTable } from '../ui/DataTable';
import type { Column } from '../ui/DataTable';
import { EntityForm } from '../ui/EntityForm';
import type { FormField } from '../ui/EntityForm';
import { MembershipsTab } from './MembershipsTab';
import { HistoryTab } from '../ui/HistoryTab';
import { useToast } from '../ui/toast';

interface UserRow {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  status: string;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  version: number;
}
interface Page<T> {
  items: T[];
  total: number;
}

export function UsersPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [data, setData] = useState<Page<UserRow>>({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const pageSize = 25;

  const load = useCallback(() => {
    setLoading(true);
    api<Page<UserRow>>('/users', {
      query: {
        page,
        pageSize,
        q: q.trim() === '' ? undefined : q.trim(),
        status: status === '' ? undefined : status,
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
  }, [page, q, status]);
  useEffect(() => {
    // A short pause while typing, so each keystroke does not become a request.
    const timer = setTimeout(load, q === '' ? 0 : 250);
    return () => {
      clearTimeout(timer);
    };
  }, [load, q]);

  const columns: Column<UserRow>[] = [
    {
      key: 'username',
      header: t('users.username'),
      value: (u) => u.username,
      render: (u) => <Link to={`/users/${u.id}`}>{u.username}</Link>,
    },
    { key: 'name', header: t('users.displayName'), value: (u) => u.displayName },
    { key: 'email', header: t('users.email'), value: (u) => u.email },
    { key: 'phone', header: t('users.phone'), value: (u) => u.phone },
    {
      key: 'status',
      header: t('users.status'),
      value: (u) =>
        u.lockedUntil !== null && new Date(u.lockedUntil) > new Date()
          ? t('users.locked')
          : u.status,
      render: (u) => {
        const locked = u.lockedUntil !== null && new Date(u.lockedUntil) > new Date();
        return (
          <Pill tone={locked ? 'danger' : u.status === 'active' ? 'success' : 'neutral'}>
            {locked ? t('users.locked') : u.status}
          </Pill>
        );
      },
    },
    {
      key: 'last',
      header: t('users.lastLogin'),
      value: (u) => u.lastLoginAt,
      render: (u) => (u.lastLoginAt === null ? '—' : new Date(u.lastLoginAt).toLocaleString()),
    },
  ];

  return (
    <>
      <PageHeader
        title={t('users.title')}
        icon={Users}
        description={t('users.intro')}
        actions={
          auth.can('iam.user.create') ? (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setCreating(true);
              }}
            >
              {t('users.new')}
            </Button>
          ) : null
        }
      />
      {creating ? (
        <section className="card">
          <EntityForm
            fields={userFields(t, true)}
            schema={userCreateSchema}
            onCancel={() => {
              setCreating(false);
            }}
            onSubmit={async (values) => {
              const made = await api<UserRow>('/users', { method: 'POST', body: values });
              setCreating(false);
              void navigate(`/users/${made.id}`);
            }}
          />
        </section>
      ) : null}
      <DataTable
        columns={columns}
        rows={data.items}
        rowKey={(u) => u.id}
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
        exportName="users"
        toolbar={
          <select
            aria-label={t('users.status')}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">{t('users.status')}</option>
            <option value="active">active</option>
            <option value="disabled">disabled</option>
          </select>
        }
      />
    </>
  );
}

function userFields(t: ReturnType<typeof useI18n>['t'], withUsername: boolean): FormField[] {
  return [
    ...(withUsername ? [{ name: 'username', label: t('users.username') }] : []),
    { name: 'displayName', label: t('users.displayName') },
    { name: 'email', label: t('users.email'), type: 'email' as const },
    { name: 'phone', label: t('users.phone'), type: 'tel' as const, hint: '+97455512345' },
  ];
}

type Tab = 'profile' | 'memberships' | 'sessions' | 'logins' | 'history';

export function UserDetailPage() {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [user, setUser] = useState<UserRow | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<Tab>('profile');
  const [deleting, setDeleting] = useState(false);
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    api<UserRow>(`/users/${id}`)
      .then(setUser)
      .catch((e: unknown) => {
        setError(e);
      });
  }, [id]);
  useEffect(load, [load]);

  const act = (path: string) => {
    api(`/users/${id}/${path}`, { method: 'POST', body: {} })
      .then(() => {
        toast.show(t('users.done'), 'success');
        load();
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };

  if (error !== null && user === null) return <ErrorAlert error={error} />;
  if (user === null) return <Skeleton lines={4} />;
  const locked = user.lockedUntil !== null && new Date(user.lockedUntil) > new Date();

  return (
    <>
      <PageHeader
        title={user.displayName}
        description={user.username}
        actions={
          <>
            {auth.can('iam.user.lock') ? (
              <Button
                icon={locked ? LockOpen : Lock}
                onClick={() => {
                  act(locked ? 'unlock' : 'lock');
                }}
              >
                {locked ? t('users.unlock') : t('users.lock')}
              </Button>
            ) : null}
            {auth.can('iam.user.lock') ? (
              <Button
                icon={LogOut}
                onClick={() => {
                  act('force-logout');
                }}
              >
                {t('users.forceLogout')}
              </Button>
            ) : null}
            {auth.can('iam.user.reset_password') ? (
              <Button
                icon={KeyRound}
                onClick={() => {
                  act('reset-password');
                }}
              >
                {t('users.resetPassword')}
              </Button>
            ) : null}
            {auth.can('iam.user.delete') ? (
              <Button
                variant="danger"
                icon={Trash2}
                onClick={() => {
                  setDeleting(true);
                }}
              >
                {t('users.delete')}
              </Button>
            ) : null}
          </>
        }
      />
      <ErrorAlert error={error} />
      <div role="tablist" className="tabs">
        {(['profile', 'memberships', 'sessions', 'logins', 'history'] as const).map((k) => (
          <button
            key={k}
            role="tab"
            type="button"
            aria-selected={tab === k}
            className="tab"
            onClick={() => {
              setTab(k);
            }}
          >
            {t(`users.tab.${k}` as const)}
          </button>
        ))}
      </div>
      {tab === 'profile' ? (
        <EntityForm
          // Reload the form when a newer version arrives after a save.
          key={user.version}
          fields={userFields(t, false)}
          schema={userUpdateSchema}
          initial={{
            displayName: user.displayName,
            email: user.email ?? '',
            phone: user.phone ?? '',
          }}
          onSubmit={async (values) => {
            const saved = await api<UserRow>(`/users/${id}`, {
              method: 'PATCH',
              body: values,
              headers: { 'If-Match': `"${String(user.version)}"` },
            });
            setUser(saved);
            toast.show(t('users.done'), 'success');
          }}
        />
      ) : null}
      {tab === 'memberships' ? <MembershipsTab userId={id} /> : null}
      {tab === 'sessions' ? <SessionsTab userId={id} /> : null}
      {tab === 'logins' ? <LoginsTab userId={id} /> : null}
      {tab === 'history' ? <HistoryTab entityType="iam.user_account" entityId={id} /> : null}
      <ConfirmDialog
        open={deleting}
        danger
        title={t('users.delete')}
        onCancel={() => {
          setDeleting(false);
        }}
        onConfirm={() => {
          if (reason.trim() === '') return;
          api(`/users/${id}`, {
            method: 'DELETE',
            body: { reason: reason.trim() },
            headers: { 'If-Match': `"${String(user.version)}"` },
          })
            .then(() => {
              void navigate('/users');
            })
            .catch((e: unknown) => {
              setDeleting(false);
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

function useList<T>(path: string, fetcher: (path: string) => Promise<{ items: T[] }>) {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    fetcher(path)
      .then((r) => {
        setItems(r.items);
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, [path, fetcher]);
  return { items, error };
}

function SessionsTab({ userId }: { userId: string }) {
  const { t } = useI18n();
  const { items, error } = useList<{
    id: string;
    device: string | null;
    ip: string | null;
    lastSeenAt: string;
  }>(`/users/${userId}/sessions`, api);
  if (error !== null) return <ErrorAlert error={error} />;
  if (items === null) return <Skeleton lines={3} />;
  return (
    <DataTable
      columns={[
        { key: 'device', header: t('users.device'), value: (s) => s.device },
        { key: 'ip', header: 'IP', value: (s) => s.ip },
        {
          key: 'seen',
          header: t('users.lastSeen'),
          value: (s) => s.lastSeenAt,
          render: (s) => new Date(s.lastSeenAt).toLocaleString(),
        },
      ]}
      rows={items}
      rowKey={(s) => s.id}
      total={items.length}
      page={1}
      pageSize={Math.max(items.length, 1)}
      onPageChange={() => undefined}
      exportName="sessions"
    />
  );
}

function LoginsTab({ userId }: { userId: string }) {
  const { t } = useI18n();
  const { items, error } = useList<{
    at: string;
    method: string;
    result: string;
    ip: string | null;
  }>(`/users/${userId}/login-history`, api);
  if (error !== null) return <ErrorAlert error={error} />;
  if (items === null) return <Skeleton lines={3} />;
  return (
    <DataTable
      columns={[
        {
          key: 'at',
          header: t('history.when'),
          value: (e) => e.at,
          render: (e) => new Date(e.at).toLocaleString(),
        },
        { key: 'method', header: t('users.method'), value: (e) => e.method },
        { key: 'result', header: t('users.result'), value: (e) => e.result },
        { key: 'ip', header: 'IP', value: (e) => e.ip },
      ]}
      rows={items}
      rowKey={(e) => e.at + e.method}
      total={items.length}
      page={1}
      pageSize={Math.max(items.length, 1)}
      onPageChange={() => undefined}
      exportName="logins"
    />
  );
}
