/**
 * Generic report page (phase 2 row 2.13): one screen for every report a module declares.
 * Nothing here is written per report: the list comes from `GET /reports`, the filter form
 * and the columns from `GET /reports/:key/meta`, the rows from `POST /reports/:key/run`.
 *
 * What a person can do: pick a report, fill its filters, run it, sort by a sortable column,
 * page through the rows, export CSV, Excel or PDF (needs `platform.report.export`; the file
 * is downloaded through the audited files endpoint), and save the current filters under a
 * name (needs `platform.saved_report.create`) and reopen a saved view later. Filters are
 * checked by the shared `checkReportFilters`, the same function the API uses.
 *
 * Depends on: api client, ui components, @fibrex/shared. Used by: App.tsx.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BarChart3, Download, Play, Save } from 'lucide-react';
import {
  checkReportFilters,
  type ReportCell,
  type ReportColumnSpec,
  type ReportFilterSpec,
  type ReportFormat,
} from '@fibrex/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import {
  Button,
  EmptyState,
  ErrorAlert,
  Field,
  PageHeader,
  Select,
  Skeleton,
} from '../ui/components';
import { useToast } from '../ui/toast';

interface ReportListItem {
  key: string;
  label: string;
  description: string;
}
interface ReportMeta extends ReportListItem {
  columns: ReportColumnSpec[];
  filters: ReportFilterSpec[];
}
interface RunResult {
  rows: Record<string, ReportCell>[];
  total: number;
  page: number;
  pageSize: number;
}
interface SavedItem {
  id: string;
  name: string;
  filters: Record<string, string>;
  ownerUserId: string;
}
interface Sort {
  key: string;
  direction: 'asc' | 'desc';
}

const PAGE_SIZE = 25;
const FORMATS: readonly ReportFormat[] = ['csv', 'xlsx', 'pdf'];

async function downloadFile(fileId: string): Promise<void> {
  const { url } = await api<{ url: string }>(`/files/${fileId}/download-url`);
  window.location.assign(url);
}

function formatCell(cell: ReportCell | undefined, type: ReportColumnSpec['type']): string {
  if (cell === null || cell === undefined) return '';
  if (type === 'datetime' && typeof cell === 'string') {
    const date = new Date(cell);
    return Number.isNaN(date.getTime()) ? cell : date.toLocaleString();
  }
  return String(cell);
}

export function ReportsPage() {
  const { t, language } = useI18n();
  const { can } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const key = params.get('report') ?? '';

  const [reports, setReports] = useState<ReportListItem[] | null>(null);
  const [meta, setMeta] = useState<ReportMeta | null>(null);
  const [saved, setSaved] = useState<SavedItem[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<Sort | undefined>(undefined);
  const [result, setResult] = useState<RunResult | null>(null);
  const [saveName, setSaveName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const canExport = can('platform.report.export');
  const canSave = can('platform.saved_report.create');

  useEffect(() => {
    api<{ items: ReportListItem[] }>('/reports')
      .then((r) => {
        setReports(r.items);
      })
      .catch((e: unknown) => {
        setError(e);
        setReports([]);
      });
  }, []);

  // A different report: forget the old filters and rows, then load its description.
  useEffect(() => {
    setMeta(null);
    setResult(null);
    setValues({});
    setProblems({});
    setSort(undefined);
    setSaved([]);
    if (key === '') return;
    let cancelled = false;
    api<ReportMeta>(`/reports/${key}/meta`)
      .then((m) => {
        if (!cancelled) setMeta(m);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e);
      });
    if (can('platform.saved_report.read')) {
      api<{ items: SavedItem[] }>('/saved-reports', { query: { reportKey: key, pageSize: 200 } })
        .then((r) => {
          if (!cancelled) setSaved(r.items);
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
    // `can` changes identity with every render of the auth context; the report key is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Choices of lookup filters (a dropdown of names whose value is the record id).
  const [lookups, setLookups] = useState<Record<string, { value: string; label: string }[]>>({});
  useEffect(() => {
    setLookups({});
    if (meta === null) return;
    let cancelled = false;
    for (const f of meta.filters) {
      if (f.lookup === undefined) continue;
      const path = f.lookup;
      api<{ items: { id: string; code?: string; name: string | Record<string, string> }[] }>(path, {
        query: { pageSize: 200 },
      })
        .then((r) => {
          if (cancelled) return;
          const options = r.items.map((i) => ({
            value: i.id,
            label:
              typeof i.name === 'string'
                ? i.name
                : (i.name[language] ?? i.name.en ?? i.code ?? i.id),
          }));
          setLookups((l) => ({ ...l, [f.key]: options }));
        })
        .catch(() => {
          if (!cancelled) setLookups((l) => ({ ...l, [f.key]: [] }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [meta, language]);

  /** Checks the filters with the shared rule; returns the cleaned values or null on a problem. */
  const checked = useCallback((): Record<string, string> | null => {
    if (meta === null) return null;
    const outcome = checkReportFilters(meta.filters, values);
    setProblems(Object.fromEntries(outcome.problems.map((p) => [p.key, p.message])));
    return outcome.problems.length > 0 ? null : outcome.values;
  }, [meta, values]);

  const run = useCallback(
    async (page: number, nextSort: Sort | undefined = sort) => {
      const filters = checked();
      if (filters === null) return;
      setBusy(true);
      setError(null);
      try {
        setResult(
          await api<RunResult>(`/reports/${key}/run`, {
            method: 'POST',
            body: { filters, page, pageSize: PAGE_SIZE, ...(nextSort ? { sort: nextSort } : {}) },
          }),
        );
      } catch (e) {
        setError(e);
      } finally {
        setBusy(false);
      }
    },
    [checked, key, sort],
  );

  async function exportAs(format: ReportFormat) {
    const filters = checked();
    if (filters === null) return;
    setBusy(true);
    setError(null);
    try {
      const done = await api<{ fileId: string; fileName: string }>(`/reports/${key}/export`, {
        method: 'POST',
        body: { format, filters, ...(sort ? { sort } : {}) },
      });
      toast.show(t('rep.exported', { name: done.fileName }), 'success');
      await downloadFile(done.fileId);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function saveView() {
    const filters = checked();
    if (filters === null || saveName.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const created = await api<SavedItem>('/saved-reports', {
        method: 'POST',
        body: { reportKey: key, name: saveName.trim(), filters },
      });
      setSaved((list) => [...list, created]);
      setSaveName('');
      toast.show(t('rep.savedOk'), 'success');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  function applySaved(id: string) {
    const item = saved.find((s) => s.id === id);
    if (item === undefined) return;
    setValues(item.filters);
    setProblems({});
  }

  function toggleSort(column: ReportColumnSpec) {
    const next: Sort = {
      key: column.key,
      direction: sort?.key === column.key && sort.direction === 'asc' ? 'desc' : 'asc',
    };
    setSort(next);
    if (result !== null) void run(1, next);
  }

  const pages = result === null ? 1 : Math.max(1, Math.ceil(result.total / result.pageSize));

  return (
    <div>
      <PageHeader title={t('rep.title')} icon={BarChart3} description={t('rep.intro')} />
      <ErrorAlert error={error} />
      {reports === null ? (
        <Skeleton />
      ) : reports.length === 0 ? (
        <EmptyState title={t('rep.none')} />
      ) : (
        <div className="stack">
          <Select
            label={t('rep.choose')}
            placeholder={t('rep.choosePlaceholder')}
            value={key}
            options={reports.map((r) => ({ value: r.key, label: r.label }))}
            onChange={(e) => {
              setError(null);
              setParams(e.target.value === '' ? {} : { report: e.target.value });
            }}
          />

          {meta === null ? null : (
            <>
              {meta.description === '' ? null : <p className="muted">{meta.description}</p>}
              {saved.length === 0 ? null : (
                <Select
                  label={t('rep.saved')}
                  placeholder={t('rep.savedPlaceholder')}
                  value=""
                  options={saved.map((s) => ({ value: s.id, label: s.name }))}
                  onChange={(e) => {
                    applySaved(e.target.value);
                  }}
                />
              )}

              <div className="form-grid">
                {meta.filters.map((filter) => {
                  const common = {
                    label: filter.label,
                    error: problems[filter.key],
                    value: values[filter.key] ?? '',
                  };
                  const set = (value: string) => {
                    setValues((v) => ({ ...v, [filter.key]: value }));
                  };
                  if (filter.type === 'select' || filter.type === 'boolean') {
                    const options =
                      filter.type === 'boolean'
                        ? [
                            { value: 'true', label: t('rep.yes') },
                            { value: 'false', label: t('rep.no') },
                          ]
                        : filter.lookup !== undefined
                          ? (lookups[filter.key] ?? [])
                          : [...(filter.options ?? [])];
                    return (
                      <Select
                        key={filter.key}
                        {...common}
                        placeholder={t('rep.any')}
                        options={options}
                        onChange={(e) => {
                          set(e.target.value);
                        }}
                      />
                    );
                  }
                  return (
                    <Field
                      key={filter.key}
                      {...common}
                      type={
                        filter.type === 'date'
                          ? 'date'
                          : filter.type === 'number'
                            ? 'number'
                            : 'text'
                      }
                      onChange={(e) => {
                        set(e.target.value);
                      }}
                    />
                  );
                })}
              </div>

              <div className="toolbar">
                <Button
                  variant="primary"
                  icon={Play}
                  disabled={busy}
                  onClick={() => {
                    void run(1);
                  }}
                >
                  {t('rep.run')}
                </Button>
                {canExport
                  ? FORMATS.map((format) => (
                      <Button
                        key={format}
                        icon={Download}
                        disabled={busy}
                        onClick={() => {
                          void exportAs(format);
                        }}
                      >
                        {t('rep.exportFormat', { format: format.toUpperCase() })}
                      </Button>
                    ))
                  : null}
              </div>

              {canSave ? (
                <div className="toolbar">
                  <Field
                    label={t('rep.saveName')}
                    value={saveName}
                    onChange={(e) => {
                      setSaveName(e.target.value);
                    }}
                  />
                  <Button
                    icon={Save}
                    disabled={busy || saveName.trim() === ''}
                    onClick={() => {
                      void saveView();
                    }}
                  >
                    {t('rep.save')}
                  </Button>
                </div>
              ) : null}

              {result === null ? null : result.rows.length === 0 ? (
                <EmptyState title={t('rep.noRows')} />
              ) : (
                <div className="table-card">
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          {meta.columns.map((column) => (
                            <th key={column.key}>
                              {column.sortable === true ? (
                                <button
                                  type="button"
                                  className="link-button"
                                  aria-label={t('rep.sortBy', { column: column.label })}
                                  onClick={() => {
                                    toggleSort(column);
                                  }}
                                >
                                  {column.label}
                                  {sort?.key === column.key
                                    ? sort.direction === 'asc'
                                      ? ' ▲'
                                      : ' ▼'
                                    : ''}
                                </button>
                              ) : (
                                column.label
                              )}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {result.rows.map((row, i) => (
                          <tr key={i}>
                            {meta.columns.map((column) => (
                              <td
                                key={column.key}
                                className={
                                  column.type === 'number' || column.type === 'money'
                                    ? 'num'
                                    : undefined
                                }
                              >
                                {formatCell(row[column.key], column.type)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {result === null ? null : (
                <div className="toolbar">
                  <span>{t('rep.rows', { n: result.total })}</span>
                  <Button
                    size="sm"
                    disabled={busy || result.page <= 1}
                    onClick={() => {
                      void run(result.page - 1);
                    }}
                  >
                    {t('rep.prev')}
                  </Button>
                  <span>{t('rep.page', { page: result.page, pages })}</span>
                  <Button
                    size="sm"
                    disabled={busy || result.page >= pages}
                    onClick={() => {
                      void run(result.page + 1);
                    }}
                  >
                    {t('rep.next')}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
