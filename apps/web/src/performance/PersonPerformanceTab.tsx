/**
 * Performance tab of the employee profile (phase 4 row 4.6a): one person's cycle, day by
 * day, as a small table and two bar charts (orders and hours per day).
 *
 * Rules, and why:
 *   - Data comes from `GET /performance/person/{partyId}` (needs `performance.report.view`);
 *     the profile shows this tab only to people who hold it.
 *   - "This cycle" and "Last cycle" are the platform's own cycle (Snoonu: 26th to 25th); the
 *     server works the dates out, the screen only shows them.
 *   - Days after the last day the platform reported are left out (the cycle is still running);
 *     a day inside the list that the platform did not report shows "no figures reported", not
 *     a zero (the reset guard rule).
 *   - The table is the exact data; the charts are a quick look and carry text labels.
 *
 * Depends on: api client, i18n, ui components, ./DayBars.tsx. Used by: people/EmployeeProfilePage.tsx.
 */
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useI18n } from '../i18n';
import { EmptyState, ErrorAlert, Skeleton } from '../ui/components';
import { DayBars } from './DayBars';

interface PersonDay {
  date: string;
  reported: boolean;
  orders: number | null;
  hours: number | null;
  acceptanceRate: number | null;
  lateMinutes: number | null;
  km: number | null;
}
interface PersonHistory {
  platformName: string;
  from: string;
  to: string;
  reportedDays: number;
  totals: { orders: number; hours: number; daysWorked: number; zeroDays: number };
  days: PersonDay[];
}

const cell = (value: number | null) => (value === null ? '—' : String(value));

export function PersonPerformanceTab({ partyId }: { partyId: string }) {
  const { t } = useI18n();
  const [cycle, setCycle] = useState<'this' | 'last'>('this');
  const [data, setData] = useState<PersonHistory | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api<PersonHistory>(`/performance/person/${partyId}`, { query: { cycle } })
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [partyId, cycle]);

  // Leave out the days after the last reported one (the cycle has not got there yet).
  const lastReported =
    data === null ? -1 : data.days.reduce((last, d, i) => (d.reported ? i : last), -1);
  const days = data === null ? [] : data.days.slice(0, lastReported + 1);

  return (
    <div className="stack">
      <div className="pick-group" role="group" aria-label={t('perfReports.cycle')}>
        {(['this', 'last'] as const).map((choice) => (
          <button
            key={choice}
            type="button"
            className="btn"
            aria-pressed={cycle === choice}
            onClick={() => {
              setCycle(choice);
            }}
          >
            {choice === 'this' ? t('perfReports.cycleThis') : t('perfReports.cycleLast')}
          </button>
        ))}
      </div>
      <ErrorAlert error={error} />
      {data === null && error === null ? <Skeleton lines={4} /> : null}
      {data === null ? null : (
        <>
          <p className="muted">
            {t('perfReports.cycleDates', { start: data.from, end: data.to })} · {data.platformName}
          </p>
          {days.length === 0 ? (
            <EmptyState title={t('perfReports.empty.title')}>
              <p>{t('perfReports.empty.body')}</p>
            </EmptyState>
          ) : (
            <>
              <dl className="totals-strip">
                <div>
                  <dt>{t('perfReports.col.totalOrders')}</dt>
                  <dd>{data.totals.orders}</dd>
                </div>
                <div>
                  <dt>{t('perfReports.col.totalHours')}</dt>
                  <dd>{data.totals.hours}</dd>
                </div>
                <div>
                  <dt>{t('perfReports.col.daysWorked')}</dt>
                  <dd>{data.totals.daysWorked}</dd>
                </div>
                <div>
                  <dt>{t('perfReports.col.zeroDays')}</dt>
                  <dd>{data.totals.zeroDays}</dd>
                </div>
              </dl>
              <div className="chart-pair">
                <DayBars
                  label={t('perfPerson.chartOrders')}
                  noFigure={t('perfPerson.notReported')}
                  bars={days.map((d) => ({ date: d.date, value: d.orders }))}
                />
                <DayBars
                  label={t('perfPerson.chartHours')}
                  noFigure={t('perfPerson.notReported')}
                  tone="accent"
                  bars={days.map((d) => ({ date: d.date, value: d.hours }))}
                />
              </div>
              <div className="table-card">
                <div className="table-wrap">
                  <table className="stack">
                    <thead>
                      <tr>
                        <th>{t('perfReports.col.date')}</th>
                        <th className="num">{t('perfReports.col.orders')}</th>
                        <th className="num">{t('perfReports.col.hoursActive')}</th>
                        <th className="num">{t('perfReports.col.acceptanceRate')}</th>
                        <th className="num">{t('perfReports.col.lateMinutes')}</th>
                        <th className="num">{t('perfReports.col.km')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {days.map((d) => (
                        <tr key={d.date} className={d.reported ? undefined : 'row-muted'}>
                          <td data-label={t('perfReports.col.date')}>{d.date}</td>
                          {d.reported ? (
                            <>
                              <td className="num" data-label={t('perfReports.col.orders')}>
                                {cell(d.orders)}
                              </td>
                              <td className="num" data-label={t('perfReports.col.hoursActive')}>
                                {cell(d.hours)}
                              </td>
                              <td className="num" data-label={t('perfReports.col.acceptanceRate')}>
                                {cell(d.acceptanceRate)}
                              </td>
                              <td className="num" data-label={t('perfReports.col.lateMinutes')}>
                                {cell(d.lateMinutes)}
                              </td>
                              <td className="num" data-label={t('perfReports.col.km')}>
                                {cell(d.km)}
                              </td>
                            </>
                          ) : (
                            <td colSpan={5}>{t('perfPerson.notReported')}</td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
