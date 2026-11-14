/**
 * Pages that exist in every installation: Home (greeting and a tile for each screen the user
 * may open) and Not found.
 * Used by: App.tsx.
 */
import { Hash, SearchX, ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { EmptyState, PageHeader } from '../ui/components';
import { NAV, filterNav } from './nav';

export function HomePage() {
  const { t } = useI18n();
  const auth = useAuth();
  // Same filtered list the sidebar uses, so the message shows only when the menu is empty.
  const visible = filterNav(NAV, auth.can);
  return (
    <>
      <PageHeader
        title={t('shell.welcome', { name: auth.grant?.user.displayName ?? '' })}
        description={visible.length > 0 ? t('shell.homeIntro') : undefined}
      />
      {visible.length === 0 ? (
        <EmptyState icon={ShieldAlert} title={t('shell.noAccess')} />
      ) : (
        <div className="home-grid" aria-label={t('shell.quickLinks')}>
          {visible.flatMap((g) =>
            g.items.map((item) => {
              const Icon = item.icon ?? Hash;
              return (
                <Link key={item.to} to={item.to} className="home-tile">
                  <span className="home-tile-icon">
                    <Icon aria-hidden />
                  </span>
                  <span>
                    {t(item.label)}
                    <span className="home-tile-group">{t(g.label)}</span>
                  </span>
                </Link>
              );
            }),
          )}
        </div>
      )}
    </>
  );
}

export function NotFoundPage() {
  const { t } = useI18n();
  return <EmptyState icon={SearchX} title={t('shell.notFound')} />;
}
