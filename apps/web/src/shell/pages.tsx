/**
 * Pages that exist in every installation: Home (greeting) and Not found.
 * Screens for users, roles, organisation, audit and people arrive in commit 12.
 * Used by: App.tsx.
 */
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { EmptyState } from '../ui/components';

export function HomePage() {
  const { t } = useI18n();
  const auth = useAuth();
  return (
    <>
      <h1>{t('shell.welcome', { name: auth.grant?.user.displayName ?? '' })}</h1>
      <EmptyState title={t('shell.noAccess')} />
    </>
  );
}

export function NotFoundPage() {
  const { t } = useI18n();
  return <EmptyState title={t('shell.notFound')} />;
}
