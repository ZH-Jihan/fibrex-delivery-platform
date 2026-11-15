/**
 * Rate tables screen (phase 2 row 2.9b; PLAN 3.7 `rate_table`, `rate_table_row`).
 *
 * Flow: pick or create a table (key, name, dimensions most important first) -> its rates
 * (`/rate-table-rows?rateTableId=`), each with values for some dimensions (empty = any),
 * an amount, currency and dates. A rate that has not started can be changed or deleted; a
 * rate that has started only gets an end date (the server enforces this so past months
 * recompute exactly). Adding a rate for the same dimension values closes the open one the
 * day before. "Find the rate" asks the server which rate applies on a day, using the same
 * rule as formulas (most specific row wins).
 *
 * Depends on: api client, auth, i18n, ui components, @fibrex/shared (rate schemas).
 * Used by: App.tsx routes.
 */
import { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, Save, Search, Table2, Trash2 } from 'lucide-react';
import { rateDimensionsSchema, rateRowFormSchema, rateTableKeySchema } from '@fibrex/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, ErrorAlert, Field, PageHeader } from '../ui/components';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DataTable } from '../ui/DataTable';
import { dimsText } from './FormulasPage';

interface TableRow {
  id: string;
  key: string;
  name: string;
  dimensions: string[];
  version: number;
}
interface RateRow {
  id: string;
  rateTableId: string;
  dims: Record<string, string>;
  value: string;
  currency: string;
  validFrom: string;
  validTo: string | null;
  version: number;
}
interface Resolution {
  value: string;
  currency: string;
  row: RateRow;
}
interface RowForm {
  dims: Record<string, string>;
  value: string;
  currency: string;
  validFrom: string;
  validTo: string;
}

const ifMatch = (version: number) => ({ 'If-Match': `"${String(version)}"` });
const today = () => new Date().toISOString().slice(0, 10);
const emptyRow = (): RowForm => ({
  dims: {},
  value: '',
  currency: 'QAR',
  validFrom: today(),
  validTo: '',
});

/** "platform, profession" -> ["platform", "profession"]. */
export function splitDimensions(text: string): string[] {
  return text
    .split(',')
    .map((d) => d.trim())
    .filter((d) => d !== '');
}

/** Only the dimensions that were filled in: an empty box means "any value". */
export function filledDims(dims: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dims)
      .map(([k, v]) => [k, v.trim()] as const)
      .filter(([, v]) => v !== ''),
  );
}

/** A rate has started when its first day is today or earlier (UTC, as on the server). */
export const hasStarted = (row: Pick<RateRow, 'validFrom'>) => row.validFrom <= today();

export function RateTablesPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const [tables, setTables] = useState<TableRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ key: '', name: '', dimensions: '' });
  const [problem, setProblem] = useState<string | null>(null);
  const [selected, setSelected] = useState<TableRow | null>(null);
  const [rows, setRows] = useState<RateRow[]>([]);
  const [rowForm, setRowForm] = useState<RowForm | null>(null);
  const [editing, setEditing] = useState<RateRow | null>(null);
  const [ask, setAsk] = useState<{ dims: Record<string, string>; date: string }>({
    dims: {},
    date: today(),
  });
  const [found, setFound] = useState<Resolution | null>(null);
  const [removing, setRemoving] = useState<RateRow | null>(null);
  const [reason, setReason] = useState('');

  const loadTables = useCallback(() => {
    setLoading(true);
    api<{ items: TableRow[] }>('/rate-tables', { query: { page: 1, pageSize: 200 } })
      .then((r) => {
        setTables(r.items);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);
  useEffect(loadTables, [loadTables]);

  const loadRows = useCallback((table: TableRow | null) => {
    if (table === null) {
      setRows([]);
      return;
    }
    api<{ items: RateRow[] }>('/rate-table-rows', {
      query: { rateTableId: table.id, page: 1, pageSize: 200 },
    })
      .then((r) => {
        setRows(r.items);
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, []);
  useEffect(() => {
    loadRows(selected);
  }, [selected, loadRows]);

  const run = (job: Promise<unknown>, after?: () => void) => {
    job
      .then(() => {
        setError(null);
        after?.();
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };

  const createTable = () => {
    const dimensions = rateDimensionsSchema.safeParse(splitDimensions(draft.dimensions));
    if (!rateTableKeySchema.safeParse(draft.key).success || draft.name.trim() === '') {
      setProblem(t('rates.keyHint'));
      return;
    }
    if (!dimensions.success) {
      setProblem(t('rates.dimensionsHint'));
      return;
    }
    run(
      api('/rate-tables', {
        method: 'POST',
        body: { key: draft.key, name: draft.name.trim(), dimensions: dimensions.data },
      }),
      () => {
        setCreating(false);
        setProblem(null);
        setDraft({ key: '', name: '', dimensions: '' });
        loadTables();
      },
    );
  };

  const saveRow = () => {
    if (selected === null || rowForm === null) return;
    const body = {
      dims: filledDims(rowForm.dims),
      value: rowForm.value.trim(),
      currency: rowForm.currency.trim(),
      validFrom: rowForm.validFrom,
      ...(rowForm.validTo === '' ? {} : { validTo: rowForm.validTo }),
    };
    const checked = rateRowFormSchema.safeParse(body);
    if (!checked.success) {
      setProblem(checked.error.issues[0]?.message ?? t('rates.value'));
      return;
    }
    setProblem(null);
    const validTo = rowForm.validTo === '' ? null : rowForm.validTo;
    const job =
      editing === null
        ? api('/rate-table-rows', {
            method: 'POST',
            body: { ...body, rateTableId: selected.id, validTo },
          })
        : api(`/rate-table-rows/${editing.id}`, {
            method: 'PATCH',
            headers: ifMatch(editing.version),
            // A rate that has started can only get a new end date.
            body: hasStarted(editing) ? { validTo } : { ...body, validTo },
          });
    run(job, () => {
      setRowForm(null);
      setEditing(null);
      loadRows(selected);
    });
  };

  const findRate = () => {
    if (selected === null) return;
    api<Resolution>(`/rate-tables/${selected.key}/resolve`, {
      query: { dims: JSON.stringify(filledDims(ask.dims)), date: ask.date },
    })
      .then((r) => {
        setFound(r);
        setError(null);
      })
      .catch((e: unknown) => {
        setFound(null);
        setError(e);
      });
  };

  const startedEdit = editing !== null && hasStarted(editing);

  return (
    <>
      <PageHeader
        title={t('rates.title')}
        icon={Table2}
        description={t('rates.intro')}
        actions={
          auth.can('platform.rate_table.create') ? (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setCreating(true);
              }}
            >
              {t('rates.new')}
            </Button>
          ) : null
        }
      />
      {error !== null && !loading ? <ErrorAlert error={error} /> : null}
      {creating ? (
        <section className="card" aria-label={t('rates.new')}>
          <Field
            label={t('rates.key')}
            hint={t('rates.keyHint')}
            value={draft.key}
            onChange={(e) => {
              setDraft({ ...draft, key: e.target.value });
            }}
          />
          <Field
            label={t('rates.name')}
            value={draft.name}
            onChange={(e) => {
              setDraft({ ...draft, name: e.target.value });
            }}
          />
          <Field
            label={t('rates.dimensions')}
            hint={t('rates.dimensionsHint')}
            value={draft.dimensions}
            onChange={(e) => {
              setDraft({ ...draft, dimensions: e.target.value });
            }}
          />
          {problem === null ? null : (
            <p className="field-error" role="alert">
              {problem}
            </p>
          )}
          <Button variant="primary" icon={Save} onClick={createTable}>
            {t('common.save')}
          </Button>
          <Button
            onClick={() => {
              setCreating(false);
            }}
          >
            {t('common.cancel')}
          </Button>
        </section>
      ) : null}
      <DataTable
        columns={[
          { key: 'key', header: t('rates.key'), value: (r) => r.key },
          { key: 'name', header: t('rates.name'), value: (r) => r.name },
          { key: 'dims', header: t('rates.dimensions'), value: (r) => r.dimensions.join(', ') },
        ]}
        rows={tables}
        rowKey={(r) => r.id}
        total={tables.length}
        page={1}
        pageSize={200}
        onPageChange={() => undefined}
        loading={loading}
        error={null}
        exportName="rate-tables"
        actions={(r) => (
          <Button
            variant="link"
            icon={Pencil}
            onClick={() => {
              setSelected(r);
              setRowForm(null);
              setEditing(null);
              setFound(null);
              setAsk({ dims: {}, date: today() });
            }}
          >
            {t('rates.rows')}
          </Button>
        )}
      />
      {selected !== null ? (
        <section className="card" aria-label={t('rates.rowsOf', { name: selected.key })}>
          <h2>{t('rates.rowsOf', { name: selected.key })}</h2>
          {auth.can('platform.rate_table_row.create') ? (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setEditing(null);
                setRowForm(emptyRow());
                setProblem(null);
              }}
            >
              {t('rates.addRow')}
            </Button>
          ) : null}
          <DataTable
            columns={[
              ...selected.dimensions.map((d) => ({
                key: `dim.${d}`,
                header: d,
                value: (r: RateRow) => r.dims[d] ?? t('rates.any'),
              })),
              { key: 'value', header: t('rates.value'), value: (r: RateRow) => r.value },
              { key: 'currency', header: t('rates.currency'), value: (r: RateRow) => r.currency },
              { key: 'from', header: t('rates.validFrom'), value: (r: RateRow) => r.validFrom },
              { key: 'to', header: t('rates.validTo'), value: (r: RateRow) => r.validTo ?? '' },
            ]}
            rows={rows}
            rowKey={(r) => r.id}
            total={rows.length}
            page={1}
            pageSize={200}
            onPageChange={() => undefined}
            loading={false}
            error={null}
            exportName="rates"
            actions={(r) => (
              <>
                {auth.can('platform.rate_table_row.update') ? (
                  <Button
                    variant="link"
                    icon={Pencil}
                    onClick={() => {
                      setEditing(r);
                      setRowForm({
                        dims: { ...r.dims },
                        value: r.value,
                        currency: r.currency,
                        validFrom: r.validFrom,
                        validTo: r.validTo ?? '',
                      });
                      setProblem(null);
                    }}
                  >
                    {t('common.edit')}
                  </Button>
                ) : null}
                {!hasStarted(r) && auth.can('platform.rate_table_row.delete') ? (
                  <Button
                    variant="link"
                    dangerText
                    icon={Trash2}
                    onClick={() => {
                      setRemoving(r);
                    }}
                  >
                    {t('common.delete')}
                  </Button>
                ) : null}
              </>
            )}
          />
          {rowForm === null ? null : (
            <div
              role="region"
              aria-label={editing === null ? t('rates.addRow') : t('rates.editRow')}
            >
              <h3>{editing === null ? t('rates.addRow') : t('rates.editRow')}</h3>
              {startedEdit ? <p className="muted">{t('rates.started')}</p> : null}
              {selected.dimensions.map((d) => (
                <Field
                  key={d}
                  label={d}
                  hint={t('rates.anyHint')}
                  value={rowForm.dims[d] ?? ''}
                  readOnly={startedEdit}
                  onChange={(e) => {
                    setRowForm({ ...rowForm, dims: { ...rowForm.dims, [d]: e.target.value } });
                  }}
                />
              ))}
              <Field
                label={t('rates.value')}
                inputMode="decimal"
                value={rowForm.value}
                readOnly={startedEdit}
                onChange={(e) => {
                  setRowForm({ ...rowForm, value: e.target.value });
                }}
              />
              <Field
                label={t('rates.currency')}
                value={rowForm.currency}
                readOnly={startedEdit}
                onChange={(e) => {
                  setRowForm({ ...rowForm, currency: e.target.value.toUpperCase() });
                }}
              />
              <Field
                label={t('rates.validFrom')}
                type="date"
                value={rowForm.validFrom}
                readOnly={startedEdit}
                onChange={(e) => {
                  setRowForm({ ...rowForm, validFrom: e.target.value });
                }}
              />
              <Field
                label={t('rates.validTo')}
                hint={t('rates.validToHint')}
                type="date"
                value={rowForm.validTo}
                onChange={(e) => {
                  setRowForm({ ...rowForm, validTo: e.target.value });
                }}
              />
              {problem === null ? null : (
                <p className="field-error" role="alert">
                  {problem}
                </p>
              )}
              <Button variant="primary" icon={Save} onClick={saveRow}>
                {t('common.save')}
              </Button>
              <Button
                onClick={() => {
                  setRowForm(null);
                  setEditing(null);
                }}
              >
                {t('common.cancel')}
              </Button>
            </div>
          )}
          <div role="region" aria-label={t('rates.resolve')}>
            <h3>{t('rates.resolve')}</h3>
            {selected.dimensions.map((d) => (
              <Field
                key={d}
                label={d}
                value={ask.dims[d] ?? ''}
                onChange={(e) => {
                  setAsk({ ...ask, dims: { ...ask.dims, [d]: e.target.value } });
                }}
              />
            ))}
            <Field
              label={t('rates.resolveDate')}
              type="date"
              value={ask.date}
              onChange={(e) => {
                setAsk({ ...ask, date: e.target.value });
              }}
            />
            <Button icon={Search} onClick={findRate}>
              {t('rates.resolve')}
            </Button>
            {found === null ? null : (
              <p>
                <strong>
                  {t('rates.found', { value: found.value, currency: found.currency })}
                </strong>{' '}
                ({dimsText(found.row.dims) || t('rates.any')}, {found.row.validFrom})
              </p>
            )}
          </div>
        </section>
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        danger
        title={t('common.delete')}
        onCancel={() => {
          setRemoving(null);
        }}
        onConfirm={() => {
          if (removing === null || reason.trim() === '') return;
          const target = removing;
          setRemoving(null);
          setReason('');
          run(
            api(`/rate-table-rows/${target.id}`, {
              method: 'DELETE',
              body: { reason: reason.trim() },
              headers: ifMatch(target.version),
            }),
            () => {
              loadRows(selected);
            },
          );
        }}
      >
        <Field
          label={t('users.deleteReason')}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
          }}
        />
      </ConfirmDialog>
    </>
  );
}
