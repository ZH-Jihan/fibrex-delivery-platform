/**
 * Performance reports (phase 4 row 4.6a): daily performance, cycle summary, and top and
 * bottom performers. One screen, three routes (`/performance/reports/daily|cycle|top-bottom`),
 * each running a report of the report engine (`POST /reports/performance.<name>/run`) so the
 * CSV and Excel export is the engine's own (`POST /reports/.../export`, needs
 * `platform.report.export`, downloaded through the audited files endpoint).
 *
 * Rules, and why:
 *   - Every report needs `performance.report.view`; the menu and the routes are guarded.
 *   - The company is the one the person is signed in to (the company switcher): the API reads
 *     only that company's rows, so there is no second company picker.
 *   - Daily: one day, default yesterday (the Qatar date the server gives). Cycle summary and
 *     Top and bottom: "This cycle" or "Last cycle" of the chosen platform (Snoonu: 26th to
 *     25th, dates from the server), or a free date range.
 *   - The report runs when a filter changes; nothing is typed into a "Run" button flow.
 *   - A day or range the platform did not report shows an explanation, never a table of zeros.
 *   - Rows are shown as the API returns them; the `list` column of Top and bottom is a code
 *     that is translated here.
 *   - On a phone the table turns into cards (`table.stack`, labels in `data-label`).
 *
 * Depends on: api client, auth, i18n, ui components, toast. Used by: App.tsx.
 */
import { useCallback, useEffect, useState } from 'react';
import { BarChart3, Download } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/en';
import { Button, EmptyState, ErrorAlert, Field, PageHeader, Select, Skeleton } from '../ui/components';
import { useToast } from '../ui/toast';

export type ReportKind = 'daily' | 'cycle' | 'topBottom';

interface Cycle {
  start: string;
  end: string;
}
interface Platform {
  id: string;
  code: string;
  name: string;
  thisCycle: Cycle;
  lastCycle: Cycle;
}
interface Options {
  today: string;
  yesterday: string;
  platforms: Platform[];
}
type Cell = string | number | boolean | null;
type Row = Record<string, Cell>;
interface RunResult {
  rows: Row[];
  total: number;
  page: number;
  pageSize: number;
}

const REPORT_KEY: Record<ReportKind, string> = {
  daily: 'performance.daily',
  cycle: 'performance.cycle_summary',
  topBottom: 'performance.top_bottom',
};

const COLUMNS = {
  daily: [
    'personName',
    'falconId',
    'orders',
    'hoursActive',
    'acceptanceRate',
    'lateMinutes',
    'km',
  ],
  cycle: [
    'personName',
    'falconId',
    'cycleStart',
    'cycleEnd',
    'totalOrders',
    'totalHours',
    'avgOrdersPerActiveDay',
    'daysWorked',
    'zeroDays',
    'ordersPerHour',
  ],
  topBottom: [
    'list',
    'rank',
    'personName',
    'falconId',
    'totalOrders',
    'totalHours',
    'streakDays',
    'streakFrom',
    'streakTo',
  ],
} as const;
type ColumnKey = (typeof COLUMNS)[ReportKind][number];

const TEXT_COLUMNS = new Set<string>([
  'personName',
  'falconId',
  'list',
  'cycleStart',
  'cycleEnd',
  'streakFrom',
  'streakTo',
]);
const PAGE_SIZE = 50;
type Range = 'this' | 'last' | 'custom';

async function downloadFile(fileId: string): Promise<void> {
  const { url } = await api<{ url: string }>(`/files/${fileId}/download-url`);
  window.location.assign(url);
}

export function PerformanceReportsPage({ kind }: { kind: ReportKind }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const toast = useToast();
  const [options, setOptions] = useState<Options | null>(null);
  const [platformId, setPlatformId] = useState('');
  const [day, setDay] = useState('');
  const [range, setRange] = useState<Range>('this');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState<{ key: string; direction: 'asc' | 'desc' } | undefined>();
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const canExport = can('platform.report.export');

  // A different report: start again from the defaults.
  useEffect(() => {
    setResult(null);
    setSort(undefined);
    setPage(1);
    setError(null);
    setRange('this');
  }, [kind]);

  useEffect(() => {
    api<Options>('/performance/report-options')
      .then((o) => {
        setOptions(o);
        setPlatformId((current) => (current === '' ? (o.platforms[0]?.id ?? '') : current));
        setDay((current) => (current === '' ? o.yesterday : current));
      })
      .catch((e: unknown) => {
        setError(e);
        setOptions({ today: '', yesterday: '', platforms: [] });
      });
  }, []);

  const platform = options?.platforms.find((p) => p.id === platformId);

  /** The filters for the chosen controls, or null when they are not complete yet. */
  const filters = useCallback((): Record<string, string> | null => {
    if (platformId === '') return null;
    if (kind === 'daily') return day === '' ? null : { platformId, date: day };
    if (range === 'custom') return from === '' || to === '' ? null : { platformId, from, to };
    return { platformId, cycle: range };
  }, [kind, platformId, day, range, from, to]);

  // Run whenever the filters, sort or page change.
  useEffect(() => {
    const chosen = filters();
    if (chosen === null) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    api<RunResult>(`/reports/${REPORT_KEY[kind]}/run`, {
      method: 'POST',
      body: { filters: chosen, page, pageSize: PAGE_SIZE, ...(sort ? { sort } : {}) },
    })
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e);
          setResult(null);
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, filters, sort, page]);

  async function exportAs(format: 'csv' | 'xlsx') {
    const chosen = filters();
    if (chosen === null) return;
    setBusy(true);
    setError(null);
    try {
      const done = await api<{ fileId: string; fileName: string }>(
        `/reports/${REPORT_KEY[kind]}/export`,
        { method: 'POST', body: { format, filters: chosen, ...(sort ? { sort } : {}) } },
      );
      toast.show(t('perfReports.exported', { name: done.fileName }), 'success');
      await downloadFile(done.fileId);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const columns: readonly ColumnKey[] = COLUMNS[kind];
  const label = (key: string) => t(`perfReports.col.${key}` as MessageKey);
  const cycleShown =
    kind === 'daily' || platform === undefined
      ? null
      : range === 'custom'
        ? from !== '' && to !== ''
          ? { start: from, end: to }
          : null
        : range === 'last'
          ? platform.lastCycle
          : platform.thisCycle;
  const pages = result === null ? 1 : Math.max(1, Math.ceil(result.total / result.pageSize));

  function show(key: string, value: Cell | undefined): string {
    if (value === null || value === undefined) return '—';
    if (key === 'list') return t(`perfReports.list.${String(value)}` as MessageKey);
    return String(value);
  }

  const titleKey = `perfReports.title.${kind}` as MessageKey;
  const introKey = `perfReports.intro.${kind}` as MessageKey;

  return (
    <div>
      <PageHeader title={t(titleKey)} icon={BarChart3} description={t(introKey)} />
      <ErrorAlert error={error} />
      {options === null ? (
        <Skeleton lines={4} />
      ) : options.platforms.length === 0 ? (
        <EmptyState title={t('perfReports.noPlatform')}>
          <p>{t('perfReports.noPlatformBody')}</p>
        </EmptyState>
      ) : (
        <div className="stack">
          <div className="form-grid">
            <Select
              label={t('perfReports.platform')}
              value={platformId}
              options={options.platforms.map((p) => ({ value: p.id, label: p.name }))}
              onChange={(e) => {
                setPlatformId(e.target.value);
                setPage(1);
              }}
            />
            {kind === 'daily' ? (
              <Field
                label={t('perfReports.day')}
                type="date"
                value={day}
                max={options.today}
                onChange={(e) => {
                  setDay(e.target.value);
                  setPage(1);
                }}
              />
            ) : null}
          </div>

          {kind === 'daily' ? null : (
            <div className="stack">
              <div className="pick-group" role="group" aria-label={t('perfReports.cycle')}>
                {(['this', 'last', 'custom'] as const).map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    className="btn"
                    aria-pressed={range === choice}
                    onClick={() => {
                      setRange(choice);
                      setPage(1);
                    }}
                  >
                    {choice === 'this'
                      ? t('perfReports.cycleThis')
                      : choice === 'last'
                        ? t('perfReports.cycleLast')
                        : t('perfReports.cycleCustom')}
                  </button>
                ))}
              </div>
              {range === 'custom' ? (
                <div className="form-grid">
                  <Field
                    label={t('perfReports.from')}
                    type="date"
                    value={from}
                    onChange={(e) => {
                      setFrom(e.target.value);
                      setPage(1);
                    }}
                  />
                  <Field
                    label={t('perfReports.to')}
                    type="date"
                    value={to}
                    min={from}
                    onChange={(e) => {
                      setTo(e.target.value);
                      setPage(1);
                    }}
                  />
                </div>
              ) : null}
              {cycleShown === null ? null : (
                <p className="muted">
                  {t('perfReports.cycleDates', { start: cycleShown.start, end: cycleShown.end })}
                </p>
              )}
            </div>
          )}

          {canExport ? (
            <div className="toolbar">
              {(['csv', 'xlsx'] as const).map((format) => (
                <Button
                  key={format}
                  icon={Download}
                  disabled={busy || filters() === null}
                  onClick={() => {
                    void exportAs(format);
                  }}
                >
                  {format === 'csv' ? t('perfReports.exportCsv') : t('perfReports.exportExcel')}
                </Button>
              ))}
            </div>
          ) : null}

          {result === null ? (
            busy ? (
              <Skeleton lines={4} />
            ) : null
          ) : result.rows.length === 0 ? (
            <EmptyState title={t('perfReports.empty.title')}>
              <p>{t('perfReports.empty.body')}</p>
            </EmptyState>
          ) : (
            <>
              <div className="table-card">
                <div className="table-wrap">
                  <table className="stack">
                    <thead>
                      <tr>
                        {columns.map((key) => (
                          <th key={key} className={TEXT_COLUMNS.has(key) ? undefined : 'num'}>
                            <button
                              type="button"
                              className="link-button"
                              aria-label={t('perfReports.sortBy', { column: label(key) })}
                              onClick={() => {
                                setSort((s) => ({
                                  key,
                                  direction: s?.key === key && s.direction === 'asc' ? 'desc' : 'asc',
                                }));
                                setPage(1);
                              }}
                            >
                              {label(key)}
                              {sort?.key === key ? (sort.direction === 'asc' ? ' ▲' : ' ▼') : ''}
                            </button>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.map((row, i) => (
                        <tr key={i}>
                          {columns.map((key) => (
                            <td
                              key={key}
                              data-label={label(key)}
                              className={TEXT_COLUMNS.has(key) ? undefined : 'num'}
                            >
                              {show(key, row[key])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="toolbar">
                <span>{t('perfReports.rows', { n: result.total })}</span>
                <Button
                  size="sm"
                  disabled={busy || result.page <= 1}
                  onClick={() => {
                    setPage((p) => p - 1);
                  }}
                >
                  {t('perfReports.prev')}
                </Button>
                <span>{t('perfReports.page', { page: result.page, pages })}</span>
                <Button
                  size="sm"
                  disabled={busy || result.page >= pages}
                  onClick={() => {
                    setPage((p) => p + 1);
                  }}
                >
                  {t('perfReports.next')}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
