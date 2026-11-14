/**
 * The screens a user passes through after a first factor: the second step (authenticator
 * code or recovery code), the forced password change, and the authenticator set-up with
 * QR code and recovery codes. Why recovery codes are shown once: the API stores only
 * hashes, so this is the only moment they can be copied. Used by: App.tsx.
 */
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Check } from 'lucide-react';
import QRCode from 'qrcode';
import { api } from '../api/client';
import type { Grant } from '../api/client';
import { useI18n } from '../i18n';
import { Button, ErrorAlert, Field, Skeleton } from '../ui/components';
import { AuthLayout } from './AuthLayout';
import { useAuth } from './AuthContext';

/** Small helper: runs an async action with busy and error state. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function MfaPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const [code, setCode] = useState('');
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => auth.verifyMfa(code));
  };
  return (
    <AuthLayout title={t('auth.mfaTitle')}>
      <p>{t('auth.mfaIntro')}</p>
      <form onSubmit={submit}>
        <ErrorAlert error={error} />
        <Field
          label={t('auth.code')}
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
          }}
          autoComplete="one-time-code"
          autoFocus
          required
        />
        <Button type="submit" variant="primary" icon={Check} block disabled={busy}>
          {t('auth.verify')}
        </Button>
      </form>
      <div className="auth-links">
        <Button variant="link" onClick={auth.cancelMfa}>
          {t('common.back')}
        </Button>
      </div>
    </AuthLayout>
  );
}

export function ChangePasswordPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => auth.changePassword({ currentPassword: current, newPassword: next }));
  };
  return (
    <AuthLayout title={t('auth.changeTitle')}>
      <p>{t('auth.changeIntro')}</p>
      <form onSubmit={submit}>
        <ErrorAlert error={error} />
        <Field
          label={t('auth.currentPassword')}
          type="password"
          value={current}
          onChange={(e) => {
            setCurrent(e.target.value);
          }}
          autoComplete="current-password"
          required
        />
        <Field
          label={t('auth.newPassword')}
          type="password"
          value={next}
          onChange={(e) => {
            setNext(e.target.value);
          }}
          autoComplete="new-password"
          required
        />
        <Button type="submit" variant="primary" icon={Check} block disabled={busy}>
          {t('auth.changePassword')}
        </Button>
        <div className="auth-links">
          <Button variant="link" onClick={() => void auth.logout()}>
            {t('auth.signOut')}
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}

interface TotpSetup {
  secret: string;
  otpauthUrl: string;
}
interface TotpConfirmed extends Grant {
  recoveryCodes: string[];
}

export function TotpSetupPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [confirmed, setConfirmed] = useState<TotpConfirmed | null>(null);
  const { busy, error, run } = useAction();

  // Ask for a new secret once when the page opens.
  useEffect(() => {
    let cancelled = false;
    void run(async () => {
      const result = await api<TotpSetup>('/auth/mfa/totp/setup', { method: 'POST' });
      if (cancelled) return;
      setSetup(result);
      setQr(await QRCode.toDataURL(result.otpauthUrl, { margin: 1, width: 200 }));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run only once on mount
  }, []);

  const confirm = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      setConfirmed(
        await api<TotpConfirmed>('/auth/mfa/totp/confirm', { method: 'POST', body: { code } }),
      );
    });
  };

  if (confirmed !== null) {
    return (
      <AuthLayout title={t('auth.recoveryTitle')}>
        <p>{t('auth.recoveryIntro')}</p>
        <ul className="codes">
          {confirmed.recoveryCodes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <Button
          variant="primary"
          icon={Check}
          block
          onClick={() => void auth.adoptGrant(confirmed)}
        >
          {t('auth.recoverySaved')}
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t('auth.setupTitle')}>
      <p>{t('auth.setupIntro')}</p>
      <ErrorAlert error={error} />
      {setup === null || qr === null ? (
        <Skeleton lines={4} />
      ) : (
        <form onSubmit={confirm}>
          <img className="qr" src={qr} alt="" />
          <p className="hint">
            {t('auth.setupSecret')}: <code>{setup.secret}</code>
          </p>
          <Field
            label={t('auth.code')}
            inputMode="numeric"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
            }}
            autoComplete="one-time-code"
            required
          />
          <Button type="submit" variant="primary" icon={Check} block disabled={busy}>
            {t('auth.verify')}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  const { t } = useI18n();
  const [tenant, setTenant] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api('/auth/password/forgot', {
        method: 'POST',
        body: { tenant, identifier },
        auth: false,
      });
      setSent(true);
    });
  };
  return (
    <AuthLayout title={t('auth.forgotTitle')}>
      {sent ? (
        <p role="status">{t('auth.forgotSent')}</p>
      ) : (
        <form onSubmit={submit}>
          <ErrorAlert error={error} />
          <Field
            label={t('auth.organisation')}
            value={tenant}
            onChange={(e) => {
              setTenant(e.target.value.trim().toLowerCase());
            }}
            required
          />
          <Field
            label={t('auth.identifier')}
            value={identifier}
            onChange={(e) => {
              setIdentifier(e.target.value);
            }}
            required
          />
          <Button type="submit" variant="primary" icon={Check} block disabled={busy}>
            {t('auth.sendLink')}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPasswordPage({ initialToken }: { initialToken: string }) {
  const { t } = useI18n();
  const [token, setToken] = useState(initialToken);
  const [next, setNext] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api('/auth/password/reset', {
        method: 'POST',
        body: { token, newPassword: next },
        auth: false,
      });
      setDone(true);
    });
  };
  return (
    <AuthLayout title={t('auth.resetTitle')}>
      {done ? (
        <p role="status">{t('auth.passwordChanged')}</p>
      ) : (
        <form onSubmit={submit}>
          <ErrorAlert error={error} />
          {initialToken === '' ? (
            <Field
              label={t('auth.resetToken')}
              value={token}
              onChange={(e) => {
                setToken(e.target.value.trim());
              }}
              required
            />
          ) : null}
          <Field
            label={t('auth.newPassword')}
            type="password"
            value={next}
            onChange={(e) => {
              setNext(e.target.value);
            }}
            autoComplete="new-password"
            required
          />
          <Button type="submit" variant="primary" icon={Check} block disabled={busy}>
            {t('auth.changePassword')}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
