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
import { EntityBuilderPage } from './org/EntityBuilderPage';
import { LookupsPage } from './org/LookupsPage';
import { NumberSequencesPage } from './org/NumberSequencesPage';
import { TemplatesPage } from './org/TemplatesPage';
import { FormulasPage } from './org/FormulasPage';
import { RateTablesPage } from './org/RateTablesPage';
import { BulkUploadPage } from './people/BulkUploadPage';
import { ExpiringPage, ExpirySettingsPage } from './people/ExpiryPages';
import { AccountsPage } from './ledger/AccountsPage';
import { JournalsPage } from './ledger/JournalsPage';
import { ManualJournalsPage } from './ledger/ManualJournalsPage';
import { SimulatePage } from './ledger/SimulatePage';
import { BankPage } from './ledger/BankPage';
import { MatchRulesPage } from './ledger/MatchRulesPage';
import { ReconciliationPage } from './ledger/ReconciliationPage';
import { StatementsPage } from './ledger/StatementsPage';
import { StateMachinesPage } from './org/StateMachinesPage';
import { WorkflowBuilderPage } from './org/WorkflowBuilderPage';
import { WorkflowBindingsPage } from './org/WorkflowBindingsPage';
import { EventsPage } from './org/EventsPage';
import { WebhooksPage } from './org/WebhooksPage';
import { DelegationsPage } from './workflow/DelegationsPage';
import { InboxPage } from './workflow/InboxPage';
import { DataExchangePage } from './data/DataExchangePage';
import { ReportsPage } from './reports/ReportsPage';
import { BranchesPage, CompanyPage } from './org/OrganisationPages';
import { RolesPage } from './admin/RolesPage';
import { UserDetailPage, UsersPage } from './admin/UsersPage';
import { AuditPage } from './audit/AuditPage';
import { RecycleBinPage } from './audit/RecycleBinPage';
import { MePage } from './me/MePage';
import { RecordsPage, RecordTypesIndexPage } from './records/RecordPages';
import { EmployeesPage } from './people/EmployeesPage';
import { EmployeeProfilePage } from './people/EmployeeProfilePage';
import { PartiesPage } from './people/PartiesPage';
import { GoogleCallbackPage, GoogleConnectionPage } from './performance/GoogleConnectionPage';
import { MappingEditorPage } from './performance/MappingEditor';
import { PerformanceReportsPage } from './performance/PerformanceReportsPage';
import { SyncRunDetailPage } from './performance/SyncRunDetailPage';
import { SyncRunsPage } from './performance/SyncRunsPage';
import { SyncSourcesPage } from './performance/SyncSourcesPage';
import { SummarySettingsPage } from './performance/SummarySettingsPage';
import { UnmatchedPage } from './performance/UnmatchedPage';
import { CallSheetPage } from './tracking/CallSheetPage';
import { StatusDifferencesPage } from './tracking/StatusDifferencesPage';
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
        <Route path="me" element={<MePage />} />
        <Route
          path="audit"
          element={
            <Guarded permission="audit.log.read">
              <AuditPage />
            </Guarded>
          }
        />
        <Route
          path="recycle-bin"
          element={
            <Guarded permission="recycle_bin.view">
              <RecycleBinPage />
            </Guarded>
          }
        />
        <Route
          path="people"
          element={
            <Guarded permission="party.party.read">
              <PartiesPage />
            </Guarded>
          }
        />
        <Route
          path="employees"
          element={
            <Guarded permission="people.employee.read">
              <EmployeesPage />
            </Guarded>
          }
        />
        <Route
          path="documents/expiring"
          element={
            <Guarded permission="people.document.read">
              <ExpiringPage />
            </Guarded>
          }
        />
        <Route
          path="documents/bulk"
          element={
            <Guarded permission="people.bulk_upload.read">
              <BulkUploadPage />
            </Guarded>
          }
        />
        <Route
          path="documents/expiry-settings"
          element={
            <Guarded permission="people.expiry_settings.read">
              <ExpirySettingsPage />
            </Guarded>
          }
        />
        <Route
          path="performance/reports/daily"
          element={
            <Guarded permission="performance.report.view">
              <PerformanceReportsPage kind="daily" />
            </Guarded>
          }
        />
        <Route
          path="performance/reports/cycle"
          element={
            <Guarded permission="performance.report.view">
              <PerformanceReportsPage kind="cycle" />
            </Guarded>
          }
        />
        <Route
          path="performance/reports/top-bottom"
          element={
            <Guarded permission="performance.report.view">
              <PerformanceReportsPage kind="topBottom" />
            </Guarded>
          }
        />
        <Route
          path="performance/sync-sources"
          element={
            <Guarded permission="performance.sync_source.read">
              <SyncSourcesPage />
            </Guarded>
          }
        />
        <Route
          path="performance/sync-sources/:id/mapping"
          element={
            <Guarded permission="performance.sync_source.read">
              <MappingEditorPage />
            </Guarded>
          }
        />
        <Route
          path="performance/sync-runs"
          element={
            <Guarded permission="performance.sync_run.read">
              <SyncRunsPage />
            </Guarded>
          }
        />
        <Route
          path="performance/unmatched"
          element={
            <Guarded permission="performance.unmatched.read">
              <UnmatchedPage />
            </Guarded>
          }
        />
        <Route
          path="tracking"
          element={
            <Guarded permission="tracking.entry.view">
              <CallSheetPage />
            </Guarded>
          }
        />
        <Route
          path="performance/status-differences"
          element={
            <Guarded permission="tracking.entry.view">
              <StatusDifferencesPage />
            </Guarded>
          }
        />
        <Route
          path="performance/summary"
          element={
            <Guarded permission="performance.summary.manage">
              <SummarySettingsPage />
            </Guarded>
          }
        />
        <Route
          path="performance/sync-runs/:id"
          element={
            <Guarded permission="performance.sync_run.read">
              <SyncRunDetailPage />
            </Guarded>
          }
        />
        <Route
          path="settings/google-connection"
          element={
            <Guarded permission="performance.google_connection.manage">
              <GoogleConnectionPage />
            </Guarded>
          }
        />
        <Route
          path="settings/google-connection/callback"
          element={
            <Guarded permission="performance.google_connection.manage">
              <GoogleCallbackPage />
            </Guarded>
          }
        />
        <Route
          path="employees/:id"
          element={
            <Guarded permission="people.employee.read">
              <EmployeeProfilePage />
            </Guarded>
          }
        />
        <Route
          path="organisation/company"
          element={
            <Guarded permission="platform.company.read">
              <CompanyPage />
            </Guarded>
          }
        />
        <Route
          path="organisation/branches"
          element={
            <Guarded permission="platform.branch.read">
              <BranchesPage />
            </Guarded>
          }
        />
        <Route
          path="organisation/numbering"
          element={
            <Guarded permission="platform.number_sequence.read">
              <NumberSequencesPage />
            </Guarded>
          }
        />
        <Route
          path="organisation/lookups"
          element={
            <Guarded permission="platform.lookup_type.read">
              <LookupsPage />
            </Guarded>
          }
        />
        <Route
          path="organisation/templates"
          element={
            <Guarded permission="platform.template.read">
              <TemplatesPage />
            </Guarded>
          }
        />
        <Route
          path="organisation/formulas"
          element={
            <Guarded permission="platform.formula.read">
              <FormulasPage />
            </Guarded>
          }
        />
        <Route
          path="ledger/accounts"
          element={
            <Guarded permission="gl.account.read">
              <AccountsPage />
            </Guarded>
          }
        />
        <Route
          path="ledger/journals"
          element={
            <Guarded permission="gl.journal.read">
              <JournalsPage />
            </Guarded>
          }
        />
        <Route
          path="ledger/manual-journals"
          element={
            <Guarded permission="gl.manual_journal.read">
              <ManualJournalsPage />
            </Guarded>
          }
        />
        <Route
          path="ledger/simulate"
          element={
            <Guarded permission="gl.posting_rule.read">
              <SimulatePage />
            </Guarded>
          }
        />
        <Route
          path="ledger/cash-bank"
          element={
            <Guarded permission="gl.cash_location.read">
              <BankPage />
            </Guarded>
          }
        />
        <Route
          path="ledger/statements"
          element={
            <Guarded permission="gl.bank_statement.read">
              <StatementsPage />
            </Guarded>
          }
        />
        <Route
          path="ledger/reconciliation"
          element={
            <Guarded permission="gl.reconciliation.read">
              <ReconciliationPage />
            </Guarded>
          }
        />
        <Route
          path="ledger/match-rules"
          element={
            <Guarded permission="gl.bank_match_rule.read">
              <MatchRulesPage />
            </Guarded>
          }
        />
        <Route
          path="organisation/rate-tables"
          element={
            <Guarded permission="platform.rate_table.read">
              <RateTablesPage />
            </Guarded>
          }
        />
        <Route
          path="organisation/state-machines"
          element={
            <Guarded permission="platform.state_machine.read">
              <StateMachinesPage />
            </Guarded>
          }
        />
        <Route
          path="organisation/workflows"
          element={
            <Guarded permission="platform.workflow_definition.read">
              <WorkflowBuilderPage />
            </Guarded>
          }
        />
        <Route path="tasks" element={<InboxPage />} />
        <Route
          path="delegations"
          element={
            <Guarded permission="platform.workflow_delegation.read">
              <DelegationsPage />
            </Guarded>
          }
        />
        <Route
          path="organisation/workflow-bindings"
          element={
            <Guarded permission="platform.workflow_binding.read">
              <WorkflowBindingsPage />
            </Guarded>
          }
        />
        <Route
          path="organisation/webhooks"
          element={
            <Guarded permission="integration.webhook_subscription.read">
              <WebhooksPage />
            </Guarded>
          }
        />
        <Route
          path="organisation/events"
          element={
            <Guarded permission="integration.event.read">
              <EventsPage />
            </Guarded>
          }
        />
        <Route
          path="organisation/record-types"
          element={
            <Guarded permission="platform.entity_definition.read">
              <EntityBuilderPage />
            </Guarded>
          }
        />
        <Route
          path="data"
          element={
            <Guarded permission="integration.import_job.create">
              <DataExchangePage />
            </Guarded>
          }
        />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="records" element={<RecordTypesIndexPage />} />
        <Route path="records/:key" element={<RecordsPage />} />
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
