/**
 * Performance summary settings (phase 4 row 4.6b): who gets the daily summary email, at what
 * local time, whether it is on, a "Send now" button and the last sent summaries.
 *
 * Rules, and why:
 *   - Recipients are typed one per line (commas also work) and checked by the same shared
 *     schema the API uses, so a bad address is caught before the request.
 *   - "Send now" uses the SAVED recipients and asks first, because an email to other people
 *     cannot be taken back. The API sends each date once: a second press for the same date
 *     shows its "already sent" message instead of sending again.
 *   - The date defaults to yesterday in the settings' time zone (the API says which).
 *
 * Depends on: api client, auth, i18n, ui components, toast, @fibrex/shared (settings schema).
 * Used by: App.tsx (route /performance/summary, permission performance.summary.manage).
 */
import { useEffect, useState } from 'react';
import { CheckCircle2, Mail, Save, Send, TriangleAlert } from 'lucide-react';
import {
  SUMMARY_REASON_TEXT,
  summarySettingsSchema,
  type SummaryIncompleteReason,
} from '@fibrex/shared';
import { api } from '../api/client';
import { useI18n } from '../i18n';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import {
  Button,
  Checkbox,
  ErrorAlert,
  Field,
  PageHeader,
  Pill,
  Skeleton,
  Textarea,
} from '../ui/components';
import { useToast } from '../ui/toast';

interface RecentRow {
  date: string;
  variant: 'full' | 'incomplete';
  reason: SummaryIncompleteReason | null;
  trigger: 'scheduled' | 'manual';
  recipients: number;
  sentAt: string;
}

interface SummaryState {
  recipients: string[];
  sendTime: string;
  timeZone: string;
  enabled: boolean;
  version: number | null;
  defaultDate: string;
  recent: RecentRow[];
}

/** One address per line or separated by commas, spaces or semicolons. */
function parseRecipients(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

export function SummarySettingsPage() {
  const { t } = useI18n();
  const toast = useToast();
  const [state, setState] = useState<SummaryState | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [recipients, setRecipients] = useState('');
  const [sendTime, setSendTime] = useState('07:00');
  const [timeZone, setTimeZone] = useState('Asia/Qatar');
  const [enabled, setEnabled] = useState(true);
  const [date, setDate] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = (next: SummaryState) => {
    setState(next);
    setRecipients(next.recipients.join('\n'));
    setSendTime(next.sendTime);
    setTimeZone(next.timeZone);
    setEnabled(next.enabled);
    setDate((d) => (d === '' ? next.defaultDate : d));
  };

  useEffect(() => {
    api<SummaryState>('/performance/summary')
      .then(load)
      .catch((e: unknown) => {
        setError(e);
      });
  }, []);

  const save = () => {
    const parsed = summarySettingsSchema.safeParse({
      recipients: parseRecipients(recipients),
      sendTime,
      timeZone,
      enabled,
    });
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? t('summary.invalid'));
      return;
    }
    setProblem(null);
    setError(null);
    setBusy(true);
    api<SummaryState>('/performance/summary', { method: 'PUT', body: parsed.data })
      .then((next) => {
        load(next);
        toast.show(t('summary.saved'), 'success');
      })
      .catch((e: unknown) => {
        setError(e);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const sendNow = () => {
    setConfirm(false);
    setError(null);
    setBusy(true);
    api<{ date: string; variant: 'full' | 'incomplete'; recipients: number }>(
      '/performance/summary/send-now',
      { method: 'POST', body: { date } },
    )
      .then((r) => {
        toast.show(
          t(r.variant === 'full' ? 'summary.sentFull' : 'summary.sentIncomplete', {
            date: r.date,
            count: String(r.recipients),
          }),
          'success',
        );
        return api<SummaryState>('/performance/summary').then(load);
      })
      .catch((e: unknown) => {
        setError(e);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const saved = state?.recipients.length ?? 0;
  return (
    <div>
      <PageHeader title={t('summary.title')} icon={Mail} description={t('summary.intro')} />
      <ErrorAlert error={error} />
      {state === null ? (
        error === null ? (
          <Skeleton />
        ) : null
      ) : (
        <>
          <section className="card" aria-labelledby="summary-settings">
            <h2 id="summary-settings">{t('summary.settings')}</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                save();
              }}
            >
              <Textarea
                label={t('summary.recipients')}
                hint={t('summary.recipientsHint')}
                rows={4}
                value={recipients}
                onChange={(e) => {
                  setRecipients(e.target.value);
                }}
              />
              <Field
                label={t('summary.sendTime')}
                type="time"
                value={sendTime}
                hint={t('summary.sendTimeHint')}
                onChange={(e) => {
                  setSendTime(e.target.value);
                }}
              />
              <Field
                label={t('summary.timeZone')}
                value={timeZone}
                hint={t('summary.timeZoneHint')}
                onChange={(e) => {
                  setTimeZone(e.target.value);
                }}
              />
              <Checkbox
                label={t('summary.enabled')}
                checked={enabled}
                onChange={(e) => {
                  setEnabled(e.target.checked);
                }}
              />
              {problem !== null ? (
                <div className="alert" role="alert">
                  {problem}
                </div>
              ) : null}
              <div className="dialog-actions">
                <Button type="submit" variant="primary" icon={Save} disabled={busy}>
                  {t('summary.save')}
                </Button>
              </div>
            </form>
          </section>

          <section className="card" aria-labelledby="summary-send">
            <h2 id="summary-send">{t('summary.sendNowTitle')}</h2>
            <p className="muted">{t('summary.sendNowHelp')}</p>
            <Field
              label={t('summary.date')}
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
              }}
            />
            {saved === 0 ? <p className="alert">{t('summary.noRecipients')}</p> : null}
            <div className="dialog-actions">
              <Button
                variant="primary"
                icon={Send}
                disabled={busy || saved === 0 || date === ''}
                onClick={() => {
                  setConfirm(true);
                }}
              >
                {t('summary.sendNow')}
              </Button>
            </div>
          </section>

          <section className="card" aria-labelledby="summary-recent">
            <h2 id="summary-recent">{t('summary.recent')}</h2>
            {state.recent.length === 0 ? (
              <p className="muted">{t('summary.recentEmpty')}</p>
            ) : (
              <ul className="summary-recent">
                {state.recent.map((row) => (
                  <li key={row.date}>
                    <strong>{row.date}</strong>
                    {row.variant === 'full' ? (
                      <Pill tone="success" icon={CheckCircle2}>
                        {t('summary.variant.full')}
                      </Pill>
                    ) : (
                      <Pill tone="danger" icon={TriangleAlert}>
                        {t('summary.variant.incomplete')}
                      </Pill>
                    )}
                    <span className="muted">
                      {row.reason === null ? '' : `${SUMMARY_REASON_TEXT[row.reason]} `}
                      {t(row.trigger === 'manual' ? 'summary.manual' : 'summary.scheduled')},{' '}
                      {t('summary.toCount', { count: String(row.recipients) })},{' '}
                      {new Date(row.sentAt).toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      <ConfirmDialog
        open={confirm}
        title={t('summary.confirmTitle')}
        confirmLabel={t('summary.sendNow')}
        onConfirm={sendNow}
        onCancel={() => {
          setConfirm(false);
        }}
      >
        {t('summary.confirmBody', { date, count: String(saved) })}
      </ConfirmDialog>
    </div>
  );
}
