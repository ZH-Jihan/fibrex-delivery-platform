/**
 * Column mapping editor (phase 4 row 4.5a): which header of a platform's sheet means which
 * system field, for one sync source.
 *
 * Rules, and why:
 *   - A mapping is versioned data (SPEC 2.6). Saving never edits a version: it adds a new one
 *     with a "valid from" (now by default), and the sync engine uses the newest version whose
 *     valid-from has passed. Older versions stay listed and can be loaded as a starting point.
 *   - Each field or metric has header aliases (comma separated). A renamed column in the
 *     platform's sheet is fixed by adding its new name as an alias here, no code change.
 *   - The form is checked by the shared `sheetColumnMappingSchema` before saving; the API
 *     checks again (and refuses one header text mapped to two fields).
 *   - "Test headers" reads only the header rows of the sheet (nothing is stored) and compares
 *     them with what is on screen, saved or not, using the same `normaliseHeader` as the
 *     parser, so what the test says "found" is what the sync will find. A required column that
 *     is not found is shown in red; a column with a letter fallback is shown as such.
 *
 * Depends on: api client, auth, i18n, ui components, toast, @fibrex/shared, react-router.
 * Used by: App.tsx (route /performance/sync-sources/:id/mapping).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Plus, Save, Sheet, Trash2 } from 'lucide-react';
import {
  normaliseHeader,
  REPORT_FIELD_KEYS,
  REPORT_FIELD_TYPES,
  sheetColumnMappingSchema,
  type ReportFieldKey,
  type ReportFieldType,
  type SheetColumnMapping,
} from '@fibrex/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import {
  Button,
  Checkbox,
  ErrorAlert,
  Field,
  PageHeader,
  Pill,
  Select,
  Skeleton,
} from '../ui/components';
import { useToast } from '../ui/toast';
import type { HeaderTest } from './GoogleConnectionPage';

interface MappingVersion {
  id: string;
  mappingVersion: number;
  validFrom: string;
  createdAt: string;
  mapping: SheetColumnMapping;
}
interface MappingList {
  versions: MappingVersion[];
  effective: SheetColumnMapping;
  effectiveVersion: number;
}
interface SourceInfo {
  id: string;
  name: string;
  platformName: string;
  adapterKind: string;
}
interface TestResult extends HeaderTest {
  labels?: string[];
}

/** One editable row: a field or a metric, with its aliases as one comma separated text. */
interface Row {
  key: string;
  aliases: string;
  column: string;
  type: ReportFieldType;
  required: boolean;
}
interface Layout {
  tab: string;
  blockTitleRow: string;
  blockLabelRow: string;
  headerRow: string;
  firstDataRow: string;
}

const splitAliases = (text: string): string[] =>
  text
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a !== '');

/** Rows and layout of the form, from a stored mapping. Unmapped fields get an empty row. */
function toForm(mapping: SheetColumnMapping): { layout: Layout; fields: Row[]; metrics: Row[] } {
  return {
    layout: {
      tab: mapping.tab,
      blockTitleRow: String(mapping.blockTitleRow),
      blockLabelRow: String(mapping.blockLabelRow),
      headerRow: String(mapping.headerRow),
      firstDataRow: String(mapping.firstDataRow),
    },
    fields: REPORT_FIELD_KEYS.map((key) => {
      const f = mapping.fields[key];
      return {
        key,
        aliases: f?.aliases.join(', ') ?? '',
        column: f?.column ?? '',
        type: f?.type ?? 'text',
        required: f?.required ?? false,
      };
    }),
    metrics: Object.entries(mapping.metrics).map(([key, m]) => ({
      key,
      aliases: m.aliases.join(', '),
      column: '',
      type: 'number' as const,
      required: m.required,
    })),
  };
}

/** The mapping as the API wants it; rows with no alias are left out (unmapped). */
function fromForm(layout: Layout, fields: Row[], metrics: Row[]): unknown {
  const fieldMap: Record<string, unknown> = {};
  for (const r of fields) {
    const aliases = splitAliases(r.aliases);
    if (aliases.length === 0) continue;
    fieldMap[r.key] = {
      aliases,
      ...(r.column.trim() === '' ? {} : { column: r.column.trim().toUpperCase() }),
      type: r.type,
      required: r.required,
    };
  }
  const metricMap: Record<string, unknown> = {};
  for (const r of metrics) {
    const aliases = splitAliases(r.aliases);
    if (r.key.trim() === '' || aliases.length === 0) continue;
    metricMap[r.key.trim()] = { aliases, required: r.required };
  }
  return {
    tab: layout.tab,
    blockTitleRow: Number(layout.blockTitleRow),
    blockLabelRow: Number(layout.blockLabelRow),
    headerRow: Number(layout.headerRow),
    firstDataRow: Number(layout.firstDataRow),
    fields: fieldMap,
    metrics: metricMap,
  };
}

/** The header texts of `row` (aliases) that appear in the sheet cells, as written there. */
function foundAliases(row: Row, cells: string[]): string[] {
  const normalised = new Set(cells.map(normaliseHeader));
  return splitAliases(row.aliases).filter((a) => normalised.has(normaliseHeader(a)));
}

export function MappingEditorPage() {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const canEdit = auth.can('performance.sync_source.update');
  const [source, setSource] = useState<SourceInfo | null>(null);
  const [list, setList] = useState<MappingList | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [fields, setFields] = useState<Row[]>([]);
  const [metrics, setMetrics] = useState<Row[]>([]);
  const [validFrom, setValidFrom] = useState('');
  const [newMetric, setNewMetric] = useState('');
  const [issues, setIssues] = useState<string[]>([]);
  const [test, setTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);

  const fill = useCallback((mapping: SheetColumnMapping) => {
    const form = toForm(mapping);
    setLayout(form.layout);
    setFields(form.fields);
    setMetrics(form.metrics);
  }, []);

  const load = useCallback(() => {
    api<MappingList>(`/sync-sources/${id}/column-mappings`)
      .then((r) => {
        setList(r);
        fill(r.effective);
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, [id, fill]);

  useEffect(() => {
    api<SourceInfo>(`/sync-sources/${id}`)
      .then(setSource)
      .catch((e: unknown) => {
        setError(e);
      });
    load();
  }, [id, load]);

  const setRow = (which: 'fields' | 'metrics', key: string, patch: Partial<Row>) => {
    const apply = (rows: Row[]) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r));
    if (which === 'fields') setFields(apply);
    else setMetrics(apply);
  };

  const runTest = () => {
    if (layout === null) return;
    setError(null);
    setBusy(true);
    api<TestResult>(`/sync-sources/${id}/test-headers`, {
      method: 'POST',
      body: {
        tab: layout.tab,
        headerRow: Number(layout.headerRow),
        blockLabelRow: Number(layout.blockLabelRow),
      },
    })
      .then(setTest)
      .catch((e: unknown) => {
        setError(e);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const save = () => {
    if (layout === null) return;
    const parsed = sheetColumnMappingSchema.safeParse(fromForm(layout, fields, metrics));
    if (!parsed.success) {
      setIssues(parsed.error.issues.map((i) => i.message));
      return;
    }
    setIssues([]);
    setBusy(true);
    api(`/sync-sources/${id}/column-mappings`, {
      method: 'POST',
      body: {
        mapping: parsed.data,
        ...(validFrom === '' ? {} : { validFrom: new Date(validFrom).toISOString() }),
      },
    })
      .then(() => {
        toast.show(t('mapping.saved'), 'success');
        setValidFrom('');
        load();
      })
      .catch((e: unknown) => {
        setError(e);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  /** Sheet headers that no field or metric alias accounts for (helps spot a renamed column). */
  const unmapped = useMemo(() => {
    if (!test?.ok) return [];
    const known = new Set(
      [...fields, ...metrics].flatMap((r) => splitAliases(r.aliases).map(normaliseHeader)),
    );
    const cells = [...test.headers, ...(test.labels ?? [])].filter((h) => h !== '');
    return [...new Set(cells)].filter((h) => !known.has(normaliseHeader(h)));
  }, [test, fields, metrics]);

  const isSheet = source?.adapterKind === 'sheet';
  const status = (row: Row, cells: string[] | undefined) => {
    if (test === null || !test.ok || cells === undefined) return null;
    const found = foundAliases(row, cells);
    if (found.length > 0) {
      return <Pill tone="success">{t('mapping.found', { header: found.join(', ') })}</Pill>;
    }
    if (splitAliases(row.aliases).length === 0) return null;
    if (row.column.trim() !== '') {
      return (
        <Pill tone="warning">{t('mapping.byColumn', { column: row.column.toUpperCase() })}</Pill>
      );
    }
    return <Pill tone={row.required ? 'danger' : 'warning'}>{t('mapping.notFound')}</Pill>;
  };

  return (
    <div>
      <p>
        <Link to="/performance/sync-sources" className="back-link">
          <ArrowLeft size={16} aria-hidden="true" /> {t('mapping.back')}
        </Link>
      </p>
      <PageHeader
        title={t('mapping.title', { name: source?.name ?? '' })}
        icon={Sheet}
        description={t('mapping.intro')}
      />
      <ErrorAlert error={error} />
      {layout === null || list === null ? (
        <Skeleton />
      ) : (
        <>
          <section className="card">
            <h2>{t('mapping.versions')}</h2>
            {list.versions.length === 0 ? (
              <p className="muted">{t('mapping.builtIn')}</p>
            ) : (
              <ul className="plain-list">
                {list.versions.map((v) => (
                  <li key={v.id} className="version-row">
                    <strong>{t('mapping.version', { n: String(v.mappingVersion) })}</strong>
                    <span className="muted">
                      {t('mapping.validFrom')}: {new Date(v.validFrom).toLocaleString()}
                    </span>
                    {v.mappingVersion === list.effectiveVersion ? (
                      <Pill tone="success">{t('mapping.inForce')}</Pill>
                    ) : Date.parse(v.validFrom) > Date.now() ? (
                      <Pill tone="info">{t('mapping.scheduled')}</Pill>
                    ) : null}
                    {canEdit ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          fill(v.mapping);
                        }}
                      >
                        {t('mapping.load')}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <h2>{t('mapping.layout')}</h2>
            <div className="form-grid">
              {(
                [
                  ['tab', 'syncSource.tab'],
                  ['blockTitleRow', 'mapping.row.blockTitle'],
                  ['blockLabelRow', 'mapping.row.blockLabel'],
                  ['headerRow', 'mapping.row.header'],
                  ['firstDataRow', 'mapping.row.firstData'],
                ] as const
              ).map(([key, label]) => (
                <Field
                  key={key}
                  label={t(label)}
                  value={layout[key]}
                  disabled={!canEdit}
                  inputMode={key === 'tab' ? undefined : 'numeric'}
                  onChange={(e) => {
                    setLayout({ ...layout, [key]: e.target.value });
                  }}
                />
              ))}
            </div>
            {isSheet ? (
              <div className="toolbar">
                <Button icon={Sheet} onClick={runTest} disabled={busy}>
                  {t('syncSource.testHeaders')}
                </Button>
                <span className="muted">{t('mapping.testHint')}</span>
              </div>
            ) : null}
            {test !== null && !test.ok ? (
              <div className="alert" role="alert">
                {test.message ?? t('google.testFailed')}
              </div>
            ) : null}
            {test?.ok === true ? (
              <p role="status" className="muted">
                {t('mapping.testRead', {
                  count: String(test.headers.filter((h) => h !== '').length),
                })}
              </p>
            ) : null}
          </section>

          <section className="card">
            <h2>{t('mapping.fields')}</h2>
            <p className="muted">{t('mapping.aliasHint')}</p>
            <div className="mapping-grid" role="table" aria-label={t('mapping.fields')}>
              {fields.map((r) => (
                <div key={r.key} className="mapping-row" role="row">
                  <div className="mapping-key" role="cell">
                    <strong>{t(`mapping.field.${r.key as ReportFieldKey}` as const)}</strong>
                    <span className="muted mono">{r.key}</span>
                    {status(r, test?.headers)}
                  </div>
                  <Field
                    label={t('mapping.aliases')}
                    value={r.aliases}
                    disabled={!canEdit}
                    onChange={(e) => {
                      setRow('fields', r.key, { aliases: e.target.value });
                    }}
                  />
                  <Field
                    label={t('mapping.column')}
                    value={r.column}
                    disabled={!canEdit}
                    maxLength={3}
                    onChange={(e) => {
                      setRow('fields', r.key, { column: e.target.value });
                    }}
                  />
                  <Select
                    label={t('mapping.type')}
                    value={r.type}
                    disabled={!canEdit}
                    options={REPORT_FIELD_TYPES.map((v) => ({
                      value: v,
                      label: t(`mapping.type.${v}` as const),
                    }))}
                    onChange={(e) => {
                      setRow('fields', r.key, { type: e.target.value as ReportFieldType });
                    }}
                  />
                  <Checkbox
                    label={t('mapping.required')}
                    checked={r.required}
                    disabled={!canEdit || r.key === 'public_id'}
                    onChange={(e) => {
                      setRow('fields', r.key, { required: e.target.checked });
                    }}
                  />
                </div>
              ))}
            </div>
          </section>

          <section className="card">
            <h2>{t('mapping.metrics')}</h2>
            <p className="muted">{t('mapping.metricsHint')}</p>
            <div className="mapping-grid" role="table" aria-label={t('mapping.metrics')}>
              {metrics.map((r) => (
                <div key={r.key} className="mapping-row mapping-row-metric" role="row">
                  <div className="mapping-key" role="cell">
                    <strong className="mono">{r.key}</strong>
                    {status(r, test?.labels)}
                  </div>
                  <Field
                    label={t('mapping.aliases')}
                    value={r.aliases}
                    disabled={!canEdit}
                    onChange={(e) => {
                      setRow('metrics', r.key, { aliases: e.target.value });
                    }}
                  />
                  <Checkbox
                    label={t('mapping.required')}
                    checked={r.required}
                    disabled={!canEdit}
                    onChange={(e) => {
                      setRow('metrics', r.key, { required: e.target.checked });
                    }}
                  />
                  {canEdit ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={Trash2}
                      aria-label={t('mapping.removeMetric', { key: r.key })}
                      onClick={() => {
                        setMetrics((all) => all.filter((m) => m.key !== r.key));
                      }}
                    >
                      {t('common.remove')}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
            {canEdit ? (
              <div className="toolbar">
                <Field
                  label={t('mapping.newMetric')}
                  value={newMetric}
                  hint={t('mapping.newMetricHint')}
                  onChange={(e) => {
                    setNewMetric(e.target.value);
                  }}
                />
                <Button
                  icon={Plus}
                  disabled={!/^[a-z][a-z0-9_]{0,62}$/.test(newMetric)}
                  onClick={() => {
                    setMetrics((all) => [
                      ...all.filter((m) => m.key !== newMetric),
                      { key: newMetric, aliases: '', column: '', type: 'number', required: false },
                    ]);
                    setNewMetric('');
                  }}
                >
                  {t('mapping.addMetric')}
                </Button>
              </div>
            ) : null}
          </section>

          {unmapped.length > 0 ? (
            <section className="card">
              <h2>{t('mapping.unmapped')}</h2>
              <p className="muted">{t('mapping.unmappedHint')}</p>
              <p>{unmapped.join(' · ')}</p>
            </section>
          ) : null}

          {canEdit ? (
            <section className="card">
              <h2>{t('mapping.saveTitle')}</h2>
              {issues.length > 0 ? (
                <div className="alert" role="alert">
                  <ul className="plain-list">
                    {issues.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <Field
                label={t('mapping.validFromNew')}
                type="datetime-local"
                value={validFrom}
                hint={t('mapping.validFromHint')}
                onChange={(e) => {
                  setValidFrom(e.target.value);
                }}
              />
              <Button variant="primary" icon={Save} onClick={save} disabled={busy}>
                {t('mapping.save')}
              </Button>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
