/**
 * Expiry screens (phase 3 row 3.5): "Expiring soon" (list coloured red, amber, green, with a
 * month calendar view) and "Expiry alert settings" (email list and alert windows).
 *
 * Rules, and why:
 *   - Colours come from the API's derived `status` (expired = red, expiring = amber, valid =
 *     green), the same rule the daily job uses, so the screen never disagrees with the email.
 *     The text always says the days left too, so colour is never the only signal.
 *   - Expired documents are shown here (and only here and in-app): by owner decision they
 *     never get an email.
 *   - Settings are checked by the shared `expirySettingsSchema` before saving; the API checks
 *     again. Saving needs `people.expiry_settings.update`; without it the form is read-only.
 *
 * Depends on: api client, auth, i18n, ui components, toast, @fibrex/shared (expiry settings).
 * Used by: App.tsx (routes /documents/expiring and /documents/expiry-settings).
 */
import { useCallback, useEffect, useState } from 'react';
import { CalendarDays, Save, TimerReset } from 'lucide-react';
import { expirySettingsSchema } from '@fibrex/shared';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, EmptyState, ErrorAlert, PageHeader, Pill, Skeleton } from '../ui/components';
import { useToast } from '../ui/toast';

export interface ExpiringItem {
  documentId: string;
  ownerType: string;
  ownerId: string;
  ownerName: string;
  employeeCode: string | null;
  documentName: string;
  expiryDate: string;
  daysLeft: number;
  status: string;
}

/** Pill colour of a document status: red expired, amber expiring soon, green otherwise. */
export function statusTone(status: string): 'danger' | 'warning' | 'success' {
  if (status === 'expired') return 'danger';
  if (status === 'expiring') return 'warning';
  return 'success';
}

function ItemRow({ item }: { item: ExpiringItem }) {
  const { t } = useI18n();
  return (
    <tr>
      <td>
        {item.ownerType === 'party' && item.employeeCode !== null ? (
          <Link to={`/employees/${item.ownerId}`}>{item.ownerName}</Link>
        ) : (
          item.ownerName
        )}
      </td>
      <td>{item.employeeCode ?? ''}</td>
      <td>{item.documentName}</td>
      <td>{item.expiryDate}</td>
      <td>
        <Pill tone={statusTone(item.status)}>
          {item.daysLeft < 0
            ? t('expiry.daysAgo', { n: String(-item.daysLeft) })
            : t('expiry.daysLeft', { n: String(item.daysLeft) })}
        </Pill>
      </td>
    </tr>
  );
}

function ItemTable({ items }: { items: ExpiringItem[] }) {
  const { t } = useI18n();
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{t('expiry.owner')}</th>
            <th>{t('expiry.code')}</th>
            <th>{t('expiry.document')}</th>
            <th>{t('expiry.date')}</th>
            <th>{t('expiry.state')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <ItemRow key={i.documentId} item={i} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ExpiringPage() {
  const { t } = useI18n();
  const [view, setView] = useState<'list' | 'calendar'>('list');
  const [withinDays, setWithinDays] = useState(30);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [items, setItems] = useState<ExpiringItem[]>([]);
  const [days, setDays] = useState<{ date: string; items: ExpiringItem[] }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    setLoading(true);
    const done = () => {
      setLoading(false);
    };
    const fail = (e: unknown) => {
      setError(e);
    };
    if (view === 'list') {
      api<{ items: ExpiringItem[] }>('/documents/expiring', { query: { withinDays } })
        .then((r) => {
          setItems(r.items);
          setError(null);
        })
        .catch(fail)
        .finally(done);
    } else {
      api<{ days: { date: string; items: ExpiringItem[] }[] }>('/documents/expiry-calendar', {
        query: { month },
      })
        .then((r) => {
          setDays(r.days);
          setError(null);
        })
        .catch(fail)
        .finally(done);
    }
  }, [view, withinDays, month]);
  useEffect(load, [load]);

  return (
    <div>
      <PageHeader title={t('expiry.title')} icon={TimerReset} description={t('expiry.intro')} />
      <div className="toolbar" role="group" aria-label={t('expiry.view')}>
        <Button
          variant={view === 'list' ? 'primary' : 'default'}
          onClick={() => {
            setView('list');
          }}
        >
          {t('expiry.viewList')}
        </Button>
        <Button
          variant={view === 'calendar' ? 'primary' : 'default'}
          icon={CalendarDays}
          onClick={() => {
            setView('calendar');
          }}
        >
          {t('expiry.viewCalendar')}
        </Button>
        {view === 'list' ? (
          <label>
            {t('expiry.within')}{' '}
            <select
              value={withinDays}
              onChange={(e) => {
                setWithinDays(Number(e.target.value));
              }}
            >
              {[7, 14, 30, 60, 90].map((n) => (
                <option key={n} value={n}>
                  {t('expiry.nDays', { n: String(n) })}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label>
            {t('expiry.month')}{' '}
            <input
              type="month"
              value={month}
              onChange={(e) => {
                if (e.target.value !== '') setMonth(e.target.value);
              }}
            />
          </label>
        )}
      </div>
      <ErrorAlert error={error} />
      {loading ? (
        <Skeleton />
      ) : view === 'list' ? (
        items.length === 0 ? (
          <EmptyState title={t('expiry.none')} />
        ) : (
          <ItemTable items={items} />
        )
      ) : days.length === 0 ? (
        <EmptyState title={t('expiry.noneMonth')} />
      ) : (
        days.map((d) => (
          <section key={d.date} aria-label={d.date}>
            <h2>{d.date}</h2>
            <ItemTable items={d.items} />
          </section>
        ))
      )}
    </div>
  );
}

interface SettingsBody {
  companyId: string;
  emails: string[];
  windows: number[];
  version: number | null;
}

export function ExpirySettingsPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const canEdit = auth.can('people.expiry_settings.update');
  const [emails, setEmails] = useState('');
  const [windows, setWindows] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    api<SettingsBody>('/documents/expiry-settings')
      .then((s) => {
        setEmails(s.emails.join('\n'));
        setWindows(s.windows.join(', '));
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  const save = () => {
    const parsed = expirySettingsSchema.safeParse({
      emails: emails
        .split(/[\s,;]+/)
        .map((e) => e.trim())
        .filter((e) => e !== ''),
      windows: windows
        .split(/[\s,;]+/)
        .filter((w) => w !== '')
        .map(Number),
    });
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? t('expiry.invalid'));
      return;
    }
    setProblem(null);
    api<SettingsBody>('/documents/expiry-settings', { method: 'PUT', body: parsed.data })
      .then(() => {
        toast.show(t('expiry.saved'), 'success');
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };

  return (
    <div>
      <PageHeader
        title={t('expirySettings.title')}
        icon={TimerReset}
        description={t('expirySettings.intro')}
      />
      <ErrorAlert error={error} />
      {loading ? (
        <Skeleton />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div className="field">
            <label htmlFor="expiry-emails">{t('expirySettings.emails')}</label>
            <textarea
              id="expiry-emails"
              rows={4}
              value={emails}
              disabled={!canEdit}
              onChange={(e) => {
                setEmails(e.target.value);
              }}
            />
            <small>{t('expirySettings.emailsHint')}</small>
          </div>
          <div className="field">
            <label htmlFor="expiry-windows">{t('expirySettings.windows')}</label>
            <input
              id="expiry-windows"
              value={windows}
              disabled={!canEdit}
              onChange={(e) => {
                setWindows(e.target.value);
              }}
            />
            <small>{t('expirySettings.windowsHint')}</small>
          </div>
          {problem !== null ? (
            <div className="alert" role="alert">
              {problem}
            </div>
          ) : null}
          {canEdit ? (
            <Button type="submit" variant="primary" icon={Save}>
              {t('common.save')}
            </Button>
          ) : null}
        </form>
      )}
    </div>
  );
}
