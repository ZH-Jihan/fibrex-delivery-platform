/**
 * App: providers and routes.
 *
 * The route guard decides, from the auth state alone, which screen a visitor gets:
 *   anonymous            -> sign-in (or forgot/reset password, which need no session)
 *   second step pending  -> MFA screen
 *   must change password -> forced password change
 *   must set up TOTP     -> authenticator set-up (their role requires it)
 *   otherwise            -> the shell with its pages
 * The order matters: a user who owes both is asked for the password first, because the
 * set-up token only reaches the set-up routes.
 * Depends on: auth, shell, i18n, theme, ui. Used by: main.tsx.
 */
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { LoginPage } from './auth/LoginPage';
import {
  ChangePasswordPage,
  ForgotPasswordPage,
  MfaPage,
  ResetPasswordPage,
  TotpSetupPage,
} from './auth/StepPages';
import { I18nProvider, useI18n } from './i18n';
import { HomePage, NotFoundPage } from './shell/pages';
import { AppShell } from './shell/AppShell';
import { ThemeProvider } from './theme/theme';
import { Skeleton } from './ui/components';
import { ToastProvider } from './ui/toast';

function ResetRoute() {
  const { hash } = useLocation();
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token') ?? '';
  return <ResetPasswordPage initialToken={token} />;
}

function Gate() {
  const auth = useAuth();
  const { t } = useI18n();

  if (auth.status === 'loading') {
    return (
      <main className="auth-page" aria-label={t('common.loading')}>
        <Skeleton lines={3} />
      </main>
    );
  }

  if (auth.status === 'anonymous') {
    if (auth.mfaPending) return <MfaPage />;
    return (
      <Routes>
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetRoute />} />
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  const grant = auth.grant;
  if (grant?.user.mustChangePassword === true) return <ChangePasswordPage />;
  if (grant?.mfaEnrolmentRequired === true) return <TotpSetupPage />;

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />
        <Route path="login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <ToastProvider>
          <AuthProvider>
            <BrowserRouter>
              <Gate />
            </BrowserRouter>
          </AuthProvider>
        </ToastProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}
