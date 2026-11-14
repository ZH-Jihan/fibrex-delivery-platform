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
import { MatrixPage } from './admin/MatrixPage';
import { RolesPage } from './admin/RolesPage';
import { UserDetailPage, UsersPage } from './admin/UsersPage';
import type { ReactNode } from 'react';
import { ThemeProvider } from './theme/theme';
import { Skeleton } from './ui/components';
import { ToastProvider } from './ui/toast';

/** A screen only for people holding `permission`; others see "not found". The API checks too. */
function Guarded({ permission, children }: { permission: string; children: ReactNode }) {
  const auth = useAuth();
  return auth.can(permission) ? <>{children}</> : <NotFoundPage />;
}

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
        <Route
          path="users"
          element={
            <Guarded permission="iam.user.read">
              <UsersPage />
            </Guarded>
          }
        />
        <Route
          path="users/:id"
          element={
            <Guarded permission="iam.user.read">
              <UserDetailPage />
            </Guarded>
          }
        />
        <Route
          path="roles"
          element={
            <Guarded permission="iam.role.read">
              <RolesPage />
            </Guarded>
          }
        />
        <Route
          path="permission-matrix"
          element={
            <Guarded permission="iam.permission_matrix.read">
              <MatrixPage />
            </Guarded>
          }
        />
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
