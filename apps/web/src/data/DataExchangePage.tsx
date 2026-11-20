/**
 * Import and export wizard (phase 2 row 2.8b): one screen for loading a sheet into, or
 * exporting, any record type, including custom ones. Nothing here is written per type: the
 * record types come from `/entity-definitions`, the fields a mapping can fill from
 * `/import-targets/:key`, and the rows and problems from the import API (row 2.8a).
 *
 * Import steps: 1 choose the file (CSV or Excel, uploaded through the signed upload and kept
 * as a raw input), 2 map columns to fields (guessed from the headings, optionally a saved
 * mapping, with a small clean-up per field), 3 preview with every row's problems and commit
 * (the API creates the rows in the background, all or nothing), 4 result, with rollback.
 * Export: choose CSV or Excel and optional exact-value filters; the file is downloaded through
 * the audited files endpoint.
 *
 * Depends on: api client, ui components, @fibrex/shared (ImportTransform). Used by: App.tsx.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeftRight, Download, Upload } from 'lucide-react';
import type { ImportTransform } from '@fibrex/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import {
  Button,
  Checkbox,
  EmptyState,
  ErrorAlert,
  Field,
  PageHeader,
  Pill,
  Select,
  Skeleton,
} from '../ui/components';
import { useToast } from '../ui/toast';
import { uploadFile } from './upload';

interface TypeItem {
  key: string;
  name: Record<string, string>;
}
interface TargetField {
  key: string;
  label: string;
  required: boolean;
}
interface Target {
  key: string;
  label: string;
  fields: TargetField[];
}
interface JobItem {
  id: string;
  status: string;
  stats: {
    columns?: string[];
    rowCount?: number;
    valid?: number;
    invalid?: number;
    created?: number;
    error?: string | null;
    warnings?: string[];
  };
}
interface RowItem {
  rowNo: number;
  errors: { path: string; message: string }[];
}
interface SavedMapping {
  id: string;
  name: string;
  columnMap: Record<string, string>;
  transforms: Record<string, unknown[]>;
}
interface ExportItem {
  id: string;
  entityKey: string;
  format: string;
  rowCount: number;
  fileObjectId: string | null;
  createdAt: string;
}

/** The clean-ups offered per field; a value is `op` or `date:<format>`. */
const CLEAN_UPS = [
  'trim',
  'upper',
  'lower',
  'number',
  'boolean',
  'date:YMD',
  'date:DMY',
  'date:MDY',
] as const;

export function cleanUpToTransform(value: string): ImportTransform | undefined {
  if (value === '') return undefined;
  if (value.startsWith('date:')) {
    return { op: 'date', format: value.slice(5) as 'DMY' | 'MDY' | 'YMD' };
  }
  return value as ImportTransform;
}

/** Guesses which column feeds which field: heading equals the field's label or key. */
export function autoMap(fields: TargetField[], columns: string[]): Record<string, string> {
  const norm = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, ' ');
  const map: Record<string, string> = {};
  for (const field of fields) {
    const hit = columns.find(
      (column) => norm(column) === norm(field.label) || norm(column) === norm(field.key),
    );
    if (hit !== undefined) map[field.key] = hit;
  }
  return map;
}

async function downloadFile(fileId: string): Promise<void> {
  const { url } = await api<{ url: string }>(`/files/${fileId}/download-url`);
  window.location.assign(url);
}

/** Downloads the blank Excel template for a target (built by the API from its fields). */
async function downloadTemplate(entityKey: string): Promise<void> {
  const file = await api<{ fileName: string; contentBase64: string }>(
    `/import-targets/${entityKey}/template`,
  );
  const bytes = Uint8Array.from(atob(file.contentBase64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = file.fileName;
  link.click();
  URL.revokeObjectURL(href);
}

export function DataExchangePage() {
  const { t, language } = useI18n();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [types, setTypes] = useState<TypeItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const canImport = can('integration.import_job.create');
  const typeKey = params.get('type') ?? '';
  // Module targets (employees) can be imported but have no bulk export.
  const [moduleKeys, setModuleKeys] = useState<string[]>([]);
  const isModuleTarget = moduleKeys.includes(typeKey);
  const canExport = can('integration.export_job.create') && !isModuleTarget;
  const tab =
    params.get('tab') === 'export' && canExport ? 'export' : canImport ? 'import' : 'export';

  useEffect(() => {
    Promise.all([
      api<{ items: (TypeItem & { status: string })[] }>('/entity-definitions', {
        query: { kind: 'custom', page: 1, pageSize: 200 },
      }),
      api<{ items: { key: string; label: string }[] }>('/import-targets'),
    ])
      .then(([custom, modules]) => {
        setModuleKeys(modules.items.map((m) => m.key));
        setTypes([
          ...modules.items.map((m) => ({ key: m.key, name: { en: m.label } })),
          ...custom.items.filter((x) => x.status === 'published'),
        ]);
      })
      .catch((e: unknown) => {
        setError(e);
        setTypes([]);
      });
  }, []);

  const set = (next: Record<string, string>) => {
    setParams({ type: typeKey, tab, ...next }, { replace: true });
  };

  return (
    <>
      <PageHeader title={t('data.title')} icon={ArrowLeftRight} description={t('data.intro')} />
      {error !== null ? <ErrorAlert error={error} /> : null}
      {types === null ? (
        <Skeleton />
      ) : types.length === 0 ? (
        <EmptyState title={t('data.noTypes')} />
      ) : (
        <>
          <Select
            label={t('data.type')}
            value={typeKey}
            placeholder={t('data.chooseType')}
            options={types.map((x) => ({
              value: x.key,
              label: x.name[language] ?? x.name.en ?? x.key,
            }))}
            onChange={(e) => {
              set({ type: e.target.value });
            }}
          />
          <div className="tabs" role="tablist">
            {canImport ? (
              <Button
                variant={tab === 'import' ? 'primary' : 'default'}
                role="tab"
                aria-selected={tab === 'import'}
                icon={Upload}
                onClick={() => {
                  set({ tab: 'import' });
                }}
              >
                {t('data.import')}
              </Button>
            ) : null}
            {canExport ? (
              <Button
                variant={tab === 'export' ? 'primary' : 'default'}
                role="tab"
                aria-selected={tab === 'export'}
                icon={Download}
                onClick={() => {
                  set({ tab: 'export' });
                }}
              >
                {t('data.export')}
              </Button>
            ) : null}
          </div>
          {typeKey === '' ? null : tab === 'import' ? (
            <ImportWizard key={typeKey} entityKey={typeKey} />
          ) : (
            <ExportPanel key={typeKey} entityKey={typeKey} />
          )}
        </>
      )}
    </>
  );
}

// ---- Import -------------------------------------------------------------------------------

type Step = 'file' | 'map' | 'preview' | 'done';

function ImportWizard({ entityKey }: { entityKey: string }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const toast = useToast();
  const [step, setStep] = useState<Step>('file');
  const [target, setTarget] = useState<Target | null>(null);
  const [saved, setSaved] = useState<SavedMapping[]>([]);
  const [job, setJob] = useState<JobItem | null>(null);
  const [columnMap, setColumnMap] = useState<Record<string, string>>({});
  const [cleanUps, setCleanUps] = useState<Record<string, string>>({});
  const [mappingName, setMappingName] = useState('');
  const [rows, setRows] = useState<RowItem[]>([]);
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setError(null);
    api<Target>(`/import-targets/${entityKey}`)
      .then(setTarget)
      .catch((e: unknown) => {
        setError(e);
      });
    api<{ items: SavedMapping[] }>('/import-mappings', {
      query: { entityKey, page: 1, pageSize: 100 },
    })
      .then((r) => {
        setSaved(r.items);
      })
      .catch(() => {
        // Saved mappings are a convenience; a missing permission just hides them.
        setSaved([]);
      });
    return () => {
      clearTimeout(timer.current);
    };
  }, [entityKey]);

  /** Runs one step's request: busy flag, error display, nothing thrown to React. */
  const attempt = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }, []);

  const mapping = useMemo(() => {
    const transforms: Record<string, ImportTransform[]> = {};
    for (const [field, value] of Object.entries(cleanUps)) {
      const transform = cleanUpToTransform(value);
      if (transform !== undefined && columnMap[field] !== undefined)
        transforms[field] = [transform];
    }
    return { columnMap, transforms };
  }, [columnMap, cleanUps]);

  const onFile = (file: File) =>
    attempt(async () => {
      const fileObjectId = await uploadFile(file);
      const created = await api<JobItem>('/imports', {
        method: 'POST',
        body: { entityKey, fileObjectId },
      });
      setJob(created);
      setColumnMap(autoMap(target?.fields ?? [], created.stats.columns ?? []));
      setStep('map');
    });

  const applySaved = (id: string) => {
    const found = saved.find((m) => m.id === id);
    if (found === undefined || job === null) return;
    const columns = new Set(job.stats.columns ?? []);
    setColumnMap(
      Object.fromEntries(Object.entries(found.columnMap).filter(([, c]) => columns.has(c))),
    );
    const next: Record<string, string> = {};
    for (const [field, list] of Object.entries(found.transforms)) {
      const first = list[0];
      if (typeof first === 'string') next[field] = first;
      else if (typeof first === 'object' && first !== null && 'format' in first) {
        next[field] = `date:${(first as { format: string }).format}`;
      }
    }
    setCleanUps(next);
  };

  const saveMapping = () =>
    attempt(async () => {
      await api('/import-mappings', {
        method: 'POST',
        body: { entityKey, name: mappingName.trim(), ...mapping },
      });
      toast.show(t('data.mappingSaved'), 'success');
      setMappingName('');
    });

  const preview = () =>
    attempt(async () => {
      if (job === null) return;
      const updated = await api<JobItem>(`/imports/${job.id}/preview`, {
        method: 'POST',
        body: { mapping },
      });
      const problems = await api<{ items: RowItem[] }>(`/imports/${job.id}/rows`, {
        query: { onlyErrors: true, page: 1, pageSize: 50 },
      });
      setJob(updated);
      setRows(problems.items);
      setStep('preview');
    });

  /** After commit the worker runs in the background: ask for the job until it is finished. */
  const poll = useCallback((id: string) => {
    api<JobItem>(`/imports/${id}`)
      .then((current) => {
        setJob(current);
        if (current.status === 'queued') {
          timer.current = setTimeout(() => {
            poll(id);
          }, 1500);
        } else {
          setStep('done');
          setBusy(false);
        }
      })
      .catch((e: unknown) => {
        setError(e);
        setBusy(false);
      });
  }, []);

  const commit = async () => {
    if (job === null) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/imports/${job.id}/commit`, { method: 'POST', body: { skipInvalid } });
      poll(job.id);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  const rollback = () =>
    attempt(async () => {
      if (job === null) return;
      setJob(
        await api<JobItem>(`/imports/${job.id}/rollback`, { method: 'POST', body: { reason } }),
      );
      toast.show(t('data.rolledBack'), 'success');
    });

  if (target === null) return error === null ? <Skeleton /> : <ErrorAlert error={error} />;
  const missing = target.fields.filter((f) => f.required && columnMap[f.key] === undefined);
  const columns = job?.stats.columns ?? [];

  return (
    <section aria-label={t('data.import')}>
      {error !== null ? <ErrorAlert error={error} /> : null}

      {step === 'file' ? (
        <div className="card">
          <h2>{t('data.step1')}</h2>
          <p>{t('data.fileHint')}</p>
          <p>
            <Button
              icon={Download}
              onClick={() => {
                void downloadTemplate(entityKey).catch((e: unknown) => {
                  setError(e);
                });
              }}
            >
              {t('data.template')}
            </Button>
          </p>
          <label className="button" htmlFor="import-file">
            {t('data.chooseFile')}
          </label>
          <input
            id="import-file"
            type="file"
            accept=".csv,.xlsx,text/csv"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file !== undefined) void onFile(file);
            }}
          />
        </div>
      ) : null}

      {step === 'map' && job !== null ? (
        <div className="card">
          <h2>{t('data.step2')}</h2>
          <p>
            {t('data.rowsInFile')}: {job.stats.rowCount ?? 0}
          </p>
          {(job.stats.warnings ?? []).map((w) => (
            <p key={w}>
              <Pill tone="warning">{w}</Pill>
            </p>
          ))}
          {saved.length > 0 ? (
            <Select
              label={t('data.savedMapping')}
              value=""
              placeholder={t('data.chooseSaved')}
              options={saved.map((m) => ({ value: m.id, label: m.name }))}
              onChange={(e) => {
                applySaved(e.target.value);
              }}
            />
          ) : null}
          <div className="table-card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('data.field')}</th>
                  <th>{t('data.column')}</th>
                  <th>{t('data.cleanUp')}</th>
                </tr>
              </thead>
              <tbody>
                {target.fields.map((field) => (
                  <tr key={field.key}>
                    <td>
                      {field.label}
                      {field.required ? ' *' : ''}
                    </td>
                    <td>
                      <Select
                        label={`${t('data.column')}: ${field.label}`}
                        value={columnMap[field.key] ?? ''}
                        placeholder={t('data.notMapped')}
                        options={columns.map((c) => ({ value: c, label: c }))}
                        onChange={(e) => {
                          const value = e.target.value;
                          setColumnMap((current) => {
                            const others = Object.entries(current).filter(
                              ([key]) => key !== field.key,
                            );
                            return Object.fromEntries(
                              value === '' ? others : [...others, [field.key, value]],
                            );
                          });
                        }}
                      />
                    </td>
                    <td>
                      <Select
                        label={`${t('data.cleanUp')}: ${field.label}`}
                        value={cleanUps[field.key] ?? ''}
                        placeholder={t('data.noCleanUp')}
                        options={CLEAN_UPS.map((c) => ({
                          value: c,
                          label: t(`data.cleanUp.${c}`),
                        }))}
                        onChange={(e) => {
                          setCleanUps((current) => ({ ...current, [field.key]: e.target.value }));
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {missing.length > 0 ? (
            <p role="alert">
              {t('data.mapRequired')}: {missing.map((f) => f.label).join(', ')}
            </p>
          ) : null}
          {can('integration.import_mapping.create') ? (
            <div className="row">
              <Field
                label={t('data.mappingName')}
                value={mappingName}
                onChange={(e) => {
                  setMappingName(e.target.value);
                }}
              />
              <Button
                disabled={busy || mappingName.trim() === '' || Object.keys(columnMap).length === 0}
                onClick={() => void saveMapping()}
              >
                {t('data.saveMapping')}
              </Button>
            </div>
          ) : null}
          <Button
            variant="primary"
            disabled={busy || missing.length > 0}
            onClick={() => void preview()}
          >
            {t('data.previewBtn')}
          </Button>
        </div>
      ) : null}

      {step === 'preview' && job !== null ? (
        <div className="card">
          <h2>{t('data.step3')}</h2>
          <p>
            <Pill tone="success">
              {t('data.goodRows')}: {job.stats.valid ?? 0}
            </Pill>{' '}
            <Pill tone={(job.stats.invalid ?? 0) > 0 ? 'danger' : 'neutral'}>
              {t('data.badRows')}: {job.stats.invalid ?? 0}
            </Pill>
          </p>
          {rows.length > 0 ? (
            <div className="table-card table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('data.row')}</th>
                    <th>{t('data.problems')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.rowNo}>
                      <td>{row.rowNo}</td>
                      <td>{row.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {(job.stats.invalid ?? 0) > 0 ? (
            <Checkbox
              label={t('data.skipInvalid')}
              checked={skipInvalid}
              onChange={(e) => {
                setSkipInvalid(e.target.checked);
              }}
            />
          ) : null}
          <div className="row">
            <Button
              onClick={() => {
                setStep('map');
              }}
            >
              {t('common.back')}
            </Button>
            <Button
              variant="primary"
              disabled={
                busy ||
                (job.stats.valid ?? 0) === 0 ||
                ((job.stats.invalid ?? 0) > 0 && !skipInvalid)
              }
              onClick={() => void commit()}
            >
              {t('data.commit')}
            </Button>
          </div>
        </div>
      ) : null}

      {step === 'done' && job !== null ? (
        <div className="card">
          <h2>{t('data.step4')}</h2>
          {job.status === 'committed' ? (
            <p>
              <Pill tone="success">{t('data.committed')}</Pill> {t('data.created')}:{' '}
              {job.stats.created ?? 0}
            </p>
          ) : job.status === 'rolled_back' ? (
            <p>
              <Pill tone="neutral">{t('data.rolledBack')}</Pill>
            </p>
          ) : (
            <p role="alert">
              <Pill tone="danger">{t('data.failed')}</Pill> {job.stats.error ?? ''}
            </p>
          )}
          {job.status === 'committed' && can('integration.import_job.rollback') ? (
            <div className="row">
              <Field
                label={t('data.rollbackReason')}
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                }}
              />
              <Button
                variant="danger"
                disabled={busy || reason.trim().length < 3}
                onClick={() => void rollback()}
              >
                {t('data.rollback')}
              </Button>
            </div>
          ) : null}
          {job.status === 'failed' ? (
            <Button
              onClick={() => {
                setStep('map');
              }}
            >
              {t('common.back')}
            </Button>
          ) : null}
          <Button
            onClick={() => {
              setJob(null);
              setRows([]);
              setStep('file');
            }}
          >
            {t('data.another')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

// ---- Export -------------------------------------------------------------------------------

function ExportPanel({ entityKey }: { entityKey: string }) {
  const { t } = useI18n();
  const [fields, setFields] = useState<TargetField[]>([]);
  const [format, setFormat] = useState<'csv' | 'xlsx'>('xlsx');
  const [filters, setFilters] = useState<{ field: string; value: string }[]>([]);
  const [recent, setRecent] = useState<ExportItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const loadRecent = useCallback(() => {
    api<{ items: ExportItem[] }>('/exports', { query: { entityKey, page: 1, pageSize: 10 } })
      .then((r) => {
        setRecent(r.items);
      })
      .catch(() => {
        setRecent([]);
      });
  }, [entityKey]);

  useEffect(() => {
    // The fields for the filter list come from the import target; without the permission
    // the export still works, just with no filters to offer.
    api<Target>(`/import-targets/${entityKey}`)
      .then((r) => {
        setFields(r.fields);
      })
      .catch(() => {
        setFields([]);
      });
    loadRecent();
  }, [entityKey, loadRecent]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        entityKey,
        format,
        filters: Object.fromEntries(
          filters.filter((f) => f.field !== '' && f.value !== '').map((f) => [f.field, f.value]),
        ),
      };
      const job = await api<ExportItem>('/exports', { method: 'POST', body });
      loadRecent();
      if (job.fileObjectId !== null) await downloadFile(job.fileObjectId);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={t('data.export')} className="card">
      {error !== null ? <ErrorAlert error={error} /> : null}
      <Select
        label={t('data.format')}
        value={format}
        options={[
          { value: 'xlsx', label: t('data.format.xlsx') },
          { value: 'csv', label: t('data.format.csv') },
        ]}
        onChange={(e) => {
          setFormat(e.target.value as 'csv' | 'xlsx');
        }}
      />
      {fields.length > 0 ? (
        <>
          <h3>{t('data.filters')}</h3>
          {filters.map((filter, index) => (
            <div className="row" key={index}>
              <Select
                label={t('data.field')}
                value={filter.field}
                placeholder={t('data.chooseField')}
                options={fields.map((f) => ({ value: f.key, label: f.label }))}
                onChange={(e) => {
                  setFilters((list) =>
                    list.map((x, i) => (i === index ? { ...x, field: e.target.value } : x)),
                  );
                }}
              />
              <Field
                label={t('data.equals')}
                value={filter.value}
                onChange={(e) => {
                  setFilters((list) =>
                    list.map((x, i) => (i === index ? { ...x, value: e.target.value } : x)),
                  );
                }}
              />
              <Button
                onClick={() => {
                  setFilters((list) => list.filter((_, i) => i !== index));
                }}
              >
                {t('data.removeFilter')}
              </Button>
            </div>
          ))}
          <Button
            onClick={() => {
              setFilters((list) => [...list, { field: '', value: '' }]);
            }}
          >
            {t('data.addFilter')}
          </Button>
        </>
      ) : null}
      <Button variant="primary" icon={Download} disabled={busy} onClick={() => void run()}>
        {t('data.exportBtn')}
      </Button>
      {recent.length > 0 ? (
        <>
          <h3>{t('data.recentExports')}</h3>
          <div className="table-card table-wrap">
            <table>
              <tbody>
                {recent.map((item) => (
                  <tr key={item.id}>
                    <td>{new Date(item.createdAt).toLocaleString()}</td>
                    <td>{item.format.toUpperCase()}</td>
                    <td>
                      {item.rowCount} {t('data.rows')}
                    </td>
                    <td>
                      {item.fileObjectId === null ? null : (
                        <Button
                          variant="link"
                          onClick={() => {
                            if (item.fileObjectId !== null) void downloadFile(item.fileObjectId);
                          }}
                        >
                          {t('data.download')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}
