/**
 * Login screen: password sign-in or phone-code sign-in. When the account has an
 * authenticator app the API answers "second step needed" and the user is moved to the
 * MFA screen by the route guard in App.tsx. The organisation code is remembered per
 * browser (try/catch: storage may be blocked). Used by: App.tsx.
 */
import { useState } from 'react';
import type { FormEvent } from 'react';
import { LogIn, Smartphone, KeyRound } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useI18n } from '../i18n';
import { Button, ErrorAlert, Field } from '../ui/components';
import { AuthLayout } from './AuthLayout';
import { useAuth } from './AuthContext';

const TENANT_KEY = 'fibrex.tenant';

function savedTenant(): string {
  try {
    return localStorage.getItem(TENANT_KEY) ?? '';
  } catch {
    return '';
  }
}

export function LoginPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const [mode, setMode] = useState<'password' | 'phone'>('password');
  const [tenant, setTenant] = useState(savedTenant);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      try {
        localStorage.setItem(TENANT_KEY, tenant);
      } catch {
        // Not remembered; harmless.
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (mode === 'password') {
        await auth.login({ tenant, identifier, password });
      } else if (!codeSent) {
        await auth.requestPhoneCode({ tenant, phone });
        setCodeSent(true);
      } else {
        await auth.verifyPhoneCode({ tenant, phone, code });
      }
    });
  };

  return (
    <AuthLayout title={t('auth.title')}>
      <form onSubmit={submit}>
        <ErrorAlert error={error} />
        <Field
          label={t('auth.organisation')}
          value={tenant}
          onChange={(e) => {
            setTenant(e.target.value.trim().toLowerCase());
          }}
          autoComplete="organization"
          required
        />
        {mode === 'password' ? (
          <>
            <Field
              label={t('auth.identifier')}
              value={identifier}
              onChange={(e) => {
                setIdentifier(e.target.value);
              }}
              autoComplete="username"
              required
            />
            <Field
              label={t('auth.password')}
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
              autoComplete="current-password"
              required
            />
          </>
        ) : (
          <>
            <Field
              label={t('auth.phone')}
              type="tel"
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
              }}
              autoComplete="tel"
              required
            />
            {codeSent ? (
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
            ) : null}
          </>
        )}
        <Button type="submit" variant="primary" icon={LogIn} block disabled={busy}>
          {mode === 'phone' && !codeSent ? t('auth.sendCode') : t('auth.signIn')}
        </Button>
      </form>
      <div className="auth-links">
        <Button
          variant="link"
          icon={mode === 'password' ? Smartphone : KeyRound}
          onClick={() => {
            setMode(mode === 'password' ? 'phone' : 'password');
            setCodeSent(false);
            setError(null);
          }}
        >
          {mode === 'password' ? t('auth.usePhone') : t('auth.usePassword')}
        </Button>
        <Link to="/forgot-password">{t('auth.forgot')}</Link>
      </div>
    </AuthLayout>
  );
}
