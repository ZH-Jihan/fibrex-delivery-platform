/**
 * Formula screen (phase 2 row 2.9b; SPEC 2.10 "testable against sample data in the admin
 * screen, and every calculated figure can show how was this calculated").
 *
 * Flow: pick or create a formula (key, purpose, result type, inputs) -> its versions
 * (served flat as `/formula-versions?formulaId=`) -> open a version. A draft can be edited,
 * its test cases run, and it can be put in force from its start date (the server refuses
 * unless every test case passes). Versions that have been in force are frozen and shown
 * read-only. "Try it" asks the server to calculate with sample inputs on a chosen day and
 * shows the result, the rates it read and every step of the calculation.
 *
 * Nothing is calculated in the browser: the server's engine is the only one, so the
 * preview is exactly what payroll and billing will get.
 *
 * Depends on: api client, auth, i18n, ui components, @fibrex/shared (formula schemas).
 * Used by: App.tsx routes.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Calculator,
  FlaskConical,
  Pencil,
  Plus,
  Rocket,
  Save,
  Sigma,
  Trash2,
  Eye,
} from 'lucide-react';
import {
  FORMULA_PURPOSES,
  FORMULA_RETURN_TYPES,
  formulaInputSchemaSchema,
  formulaKeySchema,
  formulaTestCasesSchema,
} from '@fibrex/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, ErrorAlert, Field, PageHeader, Select, Textarea } from '../ui/components';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DataTable } from '../ui/DataTable';

interface FormulaRow {
  id: string;
  key: string;
  name: string;
  purpose: (typeof FORMULA_PURPOSES)[number];
  returnType: (typeof FORMULA_RETURN_TYPES)[number];
  inputSchema: Record<string, { type: string }>;
  version: number;
}
interface VersionRow {
  id: string;
  formulaId: string;
  versionNo: number;
  expression: string;
  validFrom: string;
  validTo: string | null;
  status: 'draft' | 'active' | 'retired';
  testCases: unknown[];
  version: number;
}
interface TestRun {
  passed: boolean;
  results: {
    name: string;
    passed: boolean;
    expected: unknown;
    actual?: unknown;
    error?: { message: string };
  }[];
}
interface RateUse {
  table: string;
  dims: Record<string, string>;
  value: string;
  currency?: string;
}
interface Evaluation {
  value: unknown;
  inputs: Record<string, unknown>;
  trace?: { expression: string; value: unknown }[];
  rates?: RateUse[];
}

const ifMatch = (version: number) => ({ 'If-Match': `"${String(version)}"` });
const today = () => new Date().toISOString().slice(0, 10);
const show = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));
export const dimsText = (dims: Record<string, string>) =>
  Object.entries(dims)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');

/** Parses a JSON box; `undefined` when it is not valid JSON. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim() === '' ? 'null' : text) as unknown;
  } catch {
    return undefined;
  }
}

/** Sample inputs for "Try it", one per declared input, so the box is never empty. */
export function sampleInputs(schema: Record<string, { type: string }>): string {
  const sample: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(schema)) {
    sample[name] =
      field.type === 'int'
        ? 1
        : field.type === 'decimal'
          ? '1.00'
          : field.type === 'bool'
            ? true
            : field.type === 'date'
              ? today()
              : field.type.startsWith('list<')
                ? []
                : '';
  }
  return JSON.stringify(sample, null, 2);
}

export function FormulasPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const [formulas, setFormulas] = useState<FormulaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({
    key: '',
    name: '',
    purpose: 'pay_component',
    returnType: 'decimal',
    inputs: '{\n  "orders": { "type": "int" }\n}',
  });
  const [problem, setProblem] = useState<string | null>(null);
  const [selected, setSelected] = useState<FormulaRow | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [open, setOpen] = useState<VersionRow | null>(null);
  const [edit, setEdit] = useState({ expression: '', validFrom: today(), testCases: '[]' });
  const [tests, setTests] = useState<TestRun | null>(null);
  const [tryInputs, setTryInputs] = useState('{}');
  const [tryDate, setTryDate] = useState(today());
  const [result, setResult] = useState<Evaluation | null>(null);
  const [removing, setRemoving] = useState<VersionRow | null>(null);
  const [reason, setReason] = useState('');

  const loadFormulas = useCallback(() => {
    setLoading(true);
    api<{ items: FormulaRow[] }>('/formulas', { query: { page: 1, pageSize: 200 } })
      .then((r) => {
        setFormulas(r.items);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);
  useEffect(loadFormulas, [loadFormulas]);

  const loadVersions = useCallback((formula: FormulaRow | null) => {
    if (formula === null) {
      setVersions([]);
      return;
    }
    api<{ items: VersionRow[] }>('/formula-versions', {
      query: { formulaId: formula.id, page: 1, pageSize: 200 },
    })
      .then((r) => {
        setVersions(r.items);
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, []);
  useEffect(() => {
    loadVersions(selected);
  }, [selected, loadVersions]);

  const openVersion = (v: VersionRow) => {
    setOpen(v);
    setEdit({
      expression: v.expression,
      validFrom: v.validFrom,
      testCases: JSON.stringify(v.testCases, null, 2),
    });
    setTests(null);
    setResult(null);
    setProblem(null);
  };

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

  const createFormula = () => {
    const inputs = formulaInputSchemaSchema.safeParse(parseJson(draft.inputs));
    if (!formulaKeySchema.safeParse(draft.key).success || draft.name.trim() === '') {
      setProblem(t('formulas.keyHint'));
      return;
    }
    if (!inputs.success) {
      setProblem(t('formulas.inputsProblem'));
      return;
    }
    run(
      api('/formulas', {
        method: 'POST',
        body: {
          key: draft.key,
          name: draft.name.trim(),
          purpose: draft.purpose,
          returnType: draft.returnType,
          inputSchema: inputs.data,
        },
      }),
      () => {
        setCreating(false);
        setProblem(null);
        loadFormulas();
      },
    );
  };

  const createVersion = () => {
    if (selected === null) return;
    const first = Object.keys(selected.inputSchema)[0];
    const starter =
      selected.returnType === 'bool'
        ? 'true'
        : selected.returnType === 'string'
          ? '""'
          : (first ?? '0');
    api<VersionRow>('/formula-versions', {
      method: 'POST',
      body: { formulaId: selected.id, expression: starter, validFrom: today() },
    })
      .then((v) => {
        setError(null);
        loadVersions(selected);
        openVersion(v);
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };

  /** Saves the draft; returns the saved version, or null when the form has a problem. */
  const save = async (): Promise<VersionRow | null> => {
    if (open === null) return null;
    if (open.status !== 'draft') return open;
    const cases = formulaTestCasesSchema.safeParse(parseJson(edit.testCases));
    if (!cases.success) {
      setProblem(t('formulas.testCasesProblem'));
      return null;
    }
    setProblem(null);
    try {
      const saved = await api<VersionRow>(`/formula-versions/${open.id}`, {
        method: 'PATCH',
        headers: ifMatch(open.version),
        body: { expression: edit.expression, validFrom: edit.validFrom, testCases: cases.data },
      });
      setOpen(saved);
      loadVersions(selected);
      setError(null);
      return saved;
    } catch (e: unknown) {
      setError(e);
      return null;
    }
  };

  const runTests = async () => {
    const current = await save();
    if (current === null) return;
    try {
      setTests(
        await api<TestRun>(`/formula-versions/${current.id}/test`, { method: 'POST', body: {} }),
      );
      setError(null);
    } catch (e: unknown) {
      setError(e);
    }
  };

  const activate = async () => {
    const current = await save();
    if (current === null) return;
    run(
      api(`/formula-versions/${current.id}/activate`, {
        method: 'POST',
        headers: ifMatch(current.version),
      }),
      () => {
        setOpen(null);
        loadVersions(selected);
      },
    );
  };

  const evaluate = async () => {
    const inputs = parseJson(tryInputs);
    if (
      inputs === undefined ||
      inputs === null ||
      typeof inputs !== 'object' ||
      Array.isArray(inputs)
    ) {
      setProblem(t('templates.sampleProblem'));
      return;
    }
    setProblem(null);
    const current = await save();
    if (current === null) return;
    try {
      setResult(
        await api<Evaluation>('/formulas/evaluate', {
          method: 'POST',
          body: { versionId: current.id, date: tryDate, inputs, explain: true },
        }),
      );
      setError(null);
    } catch (e: unknown) {
      setResult(null);
      setError(e);
    }
  };

  const frozen = open !== null && open.status !== 'draft';

  return (
    <>
      <PageHeader
        title={t('formulas.title')}
        icon={Sigma}
        description={t('formulas.intro')}
        actions={
          auth.can('platform.formula.create') ? (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setCreating(true);
              }}
            >
              {t('formulas.new')}
            </Button>
          ) : null
        }
      />
      {error !== null && !loading ? <ErrorAlert error={error} /> : null}
      {creating ? (
        <section className="card" aria-label={t('formulas.new')}>
          <Field
            label={t('formulas.key')}
            hint={t('formulas.keyHint')}
            value={draft.key}
            onChange={(e) => {
              setDraft({ ...draft, key: e.target.value });
            }}
          />
          <Field
            label={t('formulas.name')}
            value={draft.name}
            onChange={(e) => {
              setDraft({ ...draft, name: e.target.value });
            }}
          />
          <Select
            label={t('formulas.purpose')}
            value={draft.purpose}
            options={FORMULA_PURPOSES.map((p) => ({ value: p, label: t(`formulas.purpose.${p}`) }))}
            onChange={(e) => {
              setDraft({ ...draft, purpose: e.target.value });
            }}
          />
          <Select
            label={t('formulas.returnType')}
            value={draft.returnType}
            options={FORMULA_RETURN_TYPES.map((r) => ({
              value: r,
              label: t(`formulas.type.${r}`),
            }))}
            onChange={(e) => {
              setDraft({ ...draft, returnType: e.target.value });
            }}
          />
          <Textarea
            label={t('formulas.inputs')}
            hint={t('formulas.inputsHint')}
            rows={5}
            value={draft.inputs}
            onChange={(e) => {
              setDraft({ ...draft, inputs: e.target.value });
            }}
          />
          {problem === null ? null : (
            <p className="field-error" role="alert">
              {problem}
            </p>
          )}
          <Button variant="primary" icon={Save} onClick={createFormula}>
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
          { key: 'key', header: t('formulas.key'), value: (r) => r.key },
          { key: 'name', header: t('formulas.name'), value: (r) => r.name },
          {
            key: 'purpose',
            header: t('formulas.purpose'),
            value: (r) => t(`formulas.purpose.${r.purpose}`),
          },
          {
            key: 'type',
            header: t('formulas.returnType'),
            value: (r) => t(`formulas.type.${r.returnType}`),
          },
        ]}
        rows={formulas}
        rowKey={(r) => r.id}
        total={formulas.length}
        page={1}
        pageSize={200}
        onPageChange={() => undefined}
        loading={loading}
        error={null}
        exportName="formulas"
        actions={(r) => (
          <Button
            variant="link"
            icon={Pencil}
            onClick={() => {
              setSelected(r);
              setOpen(null);
              setTryInputs(sampleInputs(r.inputSchema));
            }}
          >
            {t('formulas.versions')}
          </Button>
        )}
      />
      {selected !== null ? (
        <section className="card" aria-label={t('formulas.versionsOf', { name: selected.key })}>
          <h2>{t('formulas.versionsOf', { name: selected.key })}</h2>
          {auth.can('platform.formula_version.create') ? (
            <Button variant="primary" icon={Plus} onClick={createVersion}>
              {t('formulas.newVersion')}
            </Button>
          ) : null}
          <DataTable
            columns={[
              { key: 'no', header: t('formulas.number'), value: (r) => String(r.versionNo) },
              {
                key: 'status',
                header: t('formulas.statusCol'),
                value: (r) => t(`formulas.status.${r.status}`),
              },
              { key: 'from', header: t('formulas.validFrom'), value: (r) => r.validFrom },
              { key: 'to', header: t('formulas.validTo'), value: (r) => r.validTo ?? '' },
            ]}
            rows={versions}
            rowKey={(r) => r.id}
            total={versions.length}
            page={1}
            pageSize={200}
            onPageChange={() => undefined}
            loading={false}
            error={null}
            exportName="formula-versions"
            actions={(r) => (
              <>
                <Button
                  variant="link"
                  icon={r.status === 'draft' ? Pencil : Eye}
                  onClick={() => {
                    openVersion(r);
                  }}
                >
                  {r.status === 'draft' ? t('common.edit') : t('formulas.view')}
                </Button>
                {r.status === 'draft' && auth.can('platform.formula_version.delete') ? (
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
        </section>
      ) : null}
      {open !== null && selected !== null ? (
        <section
          className="card"
          aria-label={t('formulas.editorOf', { no: String(open.versionNo) })}
        >
          <h2>{t('formulas.editorOf', { no: String(open.versionNo) })}</h2>
          {frozen ? <p className="muted">{t('formulas.frozen')}</p> : null}
          <Textarea
            label={t('formulas.expression')}
            hint={t('formulas.expressionHint')}
            rows={6}
            value={edit.expression}
            readOnly={frozen}
            onChange={(e) => {
              setEdit({ ...edit, expression: e.target.value });
            }}
          />
          <Field
            label={t('formulas.validFrom')}
            type="date"
            value={edit.validFrom}
            readOnly={frozen}
            onChange={(e) => {
              setEdit({ ...edit, validFrom: e.target.value });
            }}
          />
          <Textarea
            label={t('formulas.testCases')}
            hint={t('formulas.testCasesHint')}
            rows={6}
            value={edit.testCases}
            readOnly={frozen}
            onChange={(e) => {
              setEdit({ ...edit, testCases: e.target.value });
            }}
          />
          {problem === null ? null : (
            <p className="field-error" role="alert">
              {problem}
            </p>
          )}
          {!frozen && auth.can('platform.formula_version.update') ? (
            <Button
              icon={Save}
              onClick={() => {
                void save();
              }}
            >
              {t('formulas.save')}
            </Button>
          ) : null}
          {auth.can('platform.formula_version.test') ? (
            <Button
              icon={FlaskConical}
              onClick={() => {
                void runTests();
              }}
            >
              {t('formulas.runTests')}
            </Button>
          ) : null}
          {!frozen && auth.can('platform.formula_version.activate') ? (
            <Button
              variant="primary"
              icon={Rocket}
              onClick={() => {
                void activate();
              }}
            >
              {t('formulas.activate')}
            </Button>
          ) : null}
          {tests === null ? null : (
            <ul aria-label={t('formulas.runTests')}>
              {tests.results.map((r) => (
                <li key={r.name}>
                  <strong>{r.passed ? t('formulas.passed') : t('formulas.failed')}</strong> {r.name}
                  {' — '}
                  {t('formulas.expected')}: {show(r.expected)}; {t('formulas.actual')}:{' '}
                  {r.error === undefined ? show(r.actual) : r.error.message}
                </li>
              ))}
            </ul>
          )}
          {auth.can('platform.formula.evaluate') ? (
            <div role="region" aria-label={t('formulas.try')}>
              <h3>{t('formulas.try')}</h3>
              <Textarea
                label={t('formulas.tryInputs')}
                rows={5}
                value={tryInputs}
                onChange={(e) => {
                  setTryInputs(e.target.value);
                }}
              />
              <Field
                label={t('formulas.tryDate')}
                type="date"
                value={tryDate}
                onChange={(e) => {
                  setTryDate(e.target.value);
                }}
              />
              <Button
                variant="primary"
                icon={Calculator}
                onClick={() => {
                  void evaluate();
                }}
              >
                {t('formulas.evaluate')}
              </Button>
              {result === null ? null : (
                <div>
                  <p>
                    {t('formulas.result')}: <strong>{show(result.value)}</strong>
                  </p>
                  {result.rates === undefined ? null : (
                    <>
                      <h4>{t('formulas.ratesUsed')}</h4>
                      <ul>
                        {result.rates.map((r) => (
                          <li key={`${r.table}:${dimsText(r.dims)}`}>
                            {r.table} ({dimsText(r.dims) || t('rates.any')}): {r.value}{' '}
                            {r.currency ?? ''}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {result.trace === undefined ? null : (
                    <>
                      <h4>{t('formulas.howCalculated')}</h4>
                      <ol>
                        {result.trace.map((s) => (
                          <li key={s.expression}>
                            <code>{s.expression}</code> = {show(s.value)}
                          </li>
                        ))}
                      </ol>
                    </>
                  )}
                </div>
              )}
            </div>
          ) : null}
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
            api(`/formula-versions/${target.id}`, {
              method: 'DELETE',
              body: { reason: reason.trim() },
              headers: ifMatch(target.version),
            }),
            () => {
              if (open?.id === target.id) setOpen(null);
              loadVersions(selected);
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
