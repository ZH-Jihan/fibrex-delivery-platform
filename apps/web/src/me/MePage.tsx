/**
 * "My account" screen: who I am, my active sessions (with remote sign-out) and my sign-in
 * history. Everything here is about the signed-in user only.
 * Depends on: api client, auth state, DataTable, i18n. Used by: App.tsx.
 */
import { useCallback, useEffect, useState } from 'react';
import { LogOut, UserRound } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, ErrorAlert, PageHeader, Skeleton } from '../ui/components';
import { DataTable } from '../ui/DataTable';

interface SessionRow {
  id: string;
  device: string | null;
  ip: string | null;
  lastSeenAt: string;
  current?: boolean;
}
interface LoginRow {
  at: string;
  method: string;
  result: string;
  ip: string | null;
}

export function MePage() {
  const { t } = useI18n();
  const auth = useAuth();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [logins, setLogins] = useState<LoginRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    Promise.all([
      api<{ items: SessionRow[] }>('/me/sessions'),
      api<{ items: LoginRow[] }>('/me/login-history'),
    ])
      .then(([s, l]) => {
        setSessions(s.items);
        setLogins(l.items);
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, []);
  useEffect(load, [load]);

  const user = auth.grant?.user;
  return (
    <>
      <PageHeader
        title={t('me.title')}
        icon={UserRound}
        description={user === undefined ? t('me.intro') : `${user.displayName} · ${user.username}`}
      />
      <ErrorAlert error={error} />
      <h2>{t('users.tab.sessions')}</h2>
      {sessions === null ? (
        <Skeleton lines={3} />
      ) : (
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
          rows={sessions}
          rowKey={(s) => s.id}
          total={sessions.length}
          page={1}
          pageSize={Math.max(sessions.length, 1)}
          onPageChange={() => undefined}
          actions={(s) =>
            s.current === true ? null : (
              <Button
                variant="link"
                icon={LogOut}
                onClick={() => {
                  api(`/me/sessions/${s.id}`, { method: 'DELETE' })
                    .then(load)
                    .catch((e: unknown) => {
                      setError(e);
                    });
                }}
              >
                {t('me.signOut')}
              </Button>
            )
          }
        />
      )}
      <h2>{t('users.tab.logins')}</h2>
      {logins === null ? (
        <Skeleton lines={3} />
      ) : (
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
          rows={logins}
          rowKey={(e) => e.at + e.method}
          total={logins.length}
          page={1}
          pageSize={Math.max(logins.length, 1)}
          onPageChange={() => undefined}
        />
      )}
    </>
  );
}
