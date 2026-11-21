/**
 * Google connection screens (phase 4 row 4.4): "Google connection" settings (status,
 * connect, disconnect, test read of the header row) and the page Google sends the browser
 * back to after consent.
 *
 * Rules, and why:
 *   - Connect asks the API for the consent URL (which carries a one-time state for this
 *     user) and sends the browser there. Access is read-only; the page says so.
 *   - The callback page posts Google's `code` and `state` to the API exactly once (React may
 *     run effects twice in development; a ref stops the second post, since a state is
 *     single-use). The API refuses a state it did not give this user.
 *   - No token ever reaches the browser: the API returns only the status.
 *   - "Reconnect needed" explains that the day's Excel upload works until someone reconnects.
 *
 * Depends on: api client, auth, i18n, ui components, toast, @fibrex/shared (header test).
 * Used by: App.tsx (routes /settings/google-connection and .../callback).
 */
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Link2, Link2Off, PlugZap, Sheet, TriangleAlert } from 'lucide-react';
import { sheetHeaderTestSchema } from '@fibrex/shared';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useI18n } from '../i18n';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Button, ErrorAlert, Field, PageHeader, Pill, Skeleton } from '../ui/components';
import { useToast } from '../ui/toast';

export interface GoogleStatus {
  state: 'not_configured' | 'not_connected' | 'connected' | 'reconnect_needed';
  configured: boolean;
  redirectUri: string | null;
  scope: string | null;
  connectedAt: string | null;
  connectedBy: string | null;
  connectedByName: string | null;
  problem: { code: string; message: string; at: string } | null;
}

export interface HeaderTest {
  ok: boolean;
  headers: string[];
  message: string | null;
}

/** Headers found, or why the read failed; shared with the sync source form. */
export function HeaderTestResult({ result }: { result: HeaderTest | null }) {
  const { t } = useI18n();
  if (result === null) return null;
  if (!result.ok) {
    return (
      <div className="alert" role="alert">
        {result.message ?? t('google.testFailed')}
      </div>
    );
  }
  return (
    <div role="status">
      <p>
        <Pill tone="success" icon={CheckCircle2}>
          {t('google.testOk', { count: String(result.headers.filter((h) => h !== '').length) })}
        </Pill>
      </p>
      <p className="muted">{result.headers.filter((h) => h !== '').join(' · ')}</p>
    </div>
  );
}

export function GoogleConnectionPage() {
  const { t } = useI18n();
  const toast = useToast();
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [spreadsheet, setSpreadsheet] = useState('');
  const [tab, setTab] = useState('Daily Report');
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<HeaderTest | null>(null);

  useEffect(() => {
    api<GoogleStatus>('/google-connection')
      .then(setStatus)
      .catch((e: unknown) => {
        setError(e);
      });
  }, []);

  const connect = () => {
    setBusy(true);
    api<{ authorizationUrl: string }>('/google-connection/start', { method: 'POST' })
      .then((r) => {
        window.location.assign(r.authorizationUrl);
      })
      .catch((e: unknown) => {
        setError(e);
        setBusy(false);
      });
  };

  const disconnect = () => {
    setConfirm(false);
    api<GoogleStatus>('/google-connection/disconnect', { method: 'POST' })
      .then((s) => {
        setStatus(s);
        toast.show(t('google.disconnected'), 'success');
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };

  const test = () => {
    const parsed = sheetHeaderTestSchema.safeParse({ spreadsheet, tab });
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? t('google.testFailed'));
      return;
    }
    setProblem(null);
    setResult(null);
    api<HeaderTest>('/google-connection/test', { method: 'POST', body: parsed.data })
      .then(setResult)
      .catch((e: unknown) => {
        setError(e);
      });
  };

  const connected = status?.state === 'connected' || status?.state === 'reconnect_needed';
  return (
    <div>
      <PageHeader title={t('google.title')} icon={PlugZap} description={t('google.intro')} />
      <ErrorAlert error={error} />
      {status === null ? (
        <Skeleton />
      ) : (
        <>
          <section className="card" aria-labelledby="google-status">
            <h2 id="google-status">{t('google.status')}</h2>
            <p>
              {status.state === 'connected' ? (
                <Pill tone="success" icon={CheckCircle2}>
                  {t('google.state.connected')}
                </Pill>
              ) : status.state === 'reconnect_needed' ? (
                <Pill tone="danger" icon={TriangleAlert}>
                  {t('google.state.reconnect')}
                </Pill>
              ) : (
                <Pill tone="neutral">
                  {t(
                    status.state === 'not_configured'
                      ? 'google.state.notConfigured'
                      : 'google.state.notConnected',
                  )}
                </Pill>
              )}
            </p>
            {status.state === 'not_configured' ? <p>{t('google.notConfiguredHelp')}</p> : null}
            {status.state === 'reconnect_needed' ? (
              <div className="alert" role="alert">
                {t('google.reconnectHelp')}
              </div>
            ) : null}
            {connected && status.connectedAt !== null ? (
              <p className="muted">
                {t('google.connectedOn', {
                  date: new Date(status.connectedAt).toLocaleString(),
                  name: status.connectedByName ?? '—',
                })}
              </p>
            ) : null}
            <p className="muted">{t('google.readOnly')}</p>
            <div className="dialog-actions">
              {status.configured ? (
                <Button variant="primary" icon={Link2} onClick={connect} disabled={busy}>
                  {connected ? t('google.reconnect') : t('google.connect')}
                </Button>
              ) : null}
              {connected ? (
                <Button
                  variant="danger"
                  icon={Link2Off}
                  onClick={() => {
                    setConfirm(true);
                  }}
                >
                  {t('google.disconnect')}
                </Button>
              ) : null}
            </div>
          </section>

          {status.state === 'connected' ? (
            <section className="card" aria-labelledby="google-test">
              <h2 id="google-test">{t('google.testTitle')}</h2>
              <p className="muted">{t('google.testIntro')}</p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  test();
                }}
              >
                <Field
                  label={t('syncSource.spreadsheet')}
                  value={spreadsheet}
                  hint={t('syncSource.spreadsheetHint')}
                  onChange={(e) => {
                    setSpreadsheet(e.target.value);
                  }}
                />
                <Field
                  label={t('syncSource.tab')}
                  value={tab}
                  onChange={(e) => {
                    setTab(e.target.value);
                  }}
                />
                {problem !== null ? (
                  <div className="alert" role="alert">
                    {problem}
                  </div>
                ) : null}
                <Button type="submit" icon={Sheet}>
                  {t('google.testButton')}
                </Button>
              </form>
              <HeaderTestResult result={result} />
            </section>
          ) : null}
        </>
      )}
      <ConfirmDialog
        open={confirm}
        title={t('google.disconnectTitle')}
        confirmLabel={t('google.disconnect')}
        danger
        onConfirm={disconnect}
        onCancel={() => {
          setConfirm(false);
        }}
      >
        <p>{t('google.disconnectBody')}</p>
      </ConfirmDialog>
    </div>
  );
}

/** Where Google sends the browser back to (GOOGLE_OAUTH_REDIRECT_URI). */
export function GoogleCallbackPage() {
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<unknown>(null);
  const [denied, setDenied] = useState<string | null>(null);
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    const googleError = params.get('error');
    const code = params.get('code');
    const state = params.get('state');
    if (googleError !== null || code === null || state === null) {
      setDenied(googleError ?? 'missing_code');
      return;
    }
    api<GoogleStatus>('/google-connection/callback', { method: 'POST', body: { code, state } })
      .then(() => {
        toast.show(t('google.connected'), 'success');
        void navigate('/settings/google-connection', { replace: true });
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, [navigate, params, t, toast]);

  return (
    <div>
      <PageHeader title={t('google.title')} icon={PlugZap} />
      {error === null && denied === null ? <p>{t('google.finishing')}</p> : null}
      <ErrorAlert error={error} />
      {denied !== null ? (
        <div className="alert" role="alert">
          {t('google.denied', { reason: denied })}
        </div>
      ) : null}
      {error !== null || denied !== null ? (
        <p>
          <Link to="/settings/google-connection">{t('google.backToSettings')}</Link>
        </p>
      ) : null}
    </div>
  );
}
