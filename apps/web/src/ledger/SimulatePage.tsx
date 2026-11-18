/**
 * Posting-rule simulation screen (phase 2 row 2.16b; PLAN 5.11
 * `POST /posting-rules/{eventKey}/simulate`).
 *
 * Flow: name a business event (for example `loan.disbursed`), choose the entry date and give
 * the event's inputs as JSON -> the server runs the whole posting (rule in force on that date,
 * formulas, accounts, dimensions, exchange rates, base amounts, balance, period) and returns
 * the journal it WOULD write. Nothing is saved, so this is safe on live data. The result says
 * whether the journal balances and whether the period is open (posting would succeed).
 *
 * Depends on: api client, i18n, ui components, ledger-utils. Used by: App.tsx routes.
 */
import { useState, type FormEvent } from 'react';
import { FlaskConical } from 'lucide-react';
import { api } from '../api/client';
import { useI18n } from '../i18n';
import { Button, ErrorAlert, Field, PageHeader, Pill, Textarea } from '../ui/components';
import { DataTable } from '../ui/DataTable';
import { showAmount } from './ledger-utils';

interface SimulatedLine {
  lineNo: number;
  accountCode: string;
  debit: string;
  credit: string;
  currency: string;
  fxRate: string;
  baseDebit: string;
  baseCredit: string;
  memo: string | null;
}
interface Simulation {
  rule: { id: string; versionNo: number; status: string };
  entryDate: string;
  baseCurrency: string;
  lines: SimulatedLine[];
  totals: { debit: string; credit: string; balanced: boolean };
  period: { id: string; status: string } | null;
  postable: boolean;
}

/** Inputs typed as JSON text; empty means no inputs. Returns null when the text is not an object. */
export function parseInputs(text: string): Record<string, unknown> | null {
  if (text.trim() === '') return {};
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const today = () => new Date().toISOString().slice(0, 10);

export function SimulatePage() {
  const { t } = useI18n();
  const [form, setForm] = useState({ eventKey: '', entryDate: today(), inputs: '{}' });
  const [result, setResult] = useState<Simulation | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const inputs = parseInputs(form.inputs);
    if (inputs === null) {
      setFieldError(t('gl.badJson'));
      return;
    }
    setFieldError(undefined);
    setBusy(true);
    api<Simulation>(`/posting-rules/${encodeURIComponent(form.eventKey.trim())}/simulate`, {
      method: 'POST',
      body: { entryDate: form.entryDate, inputs },
    })
      .then((r) => {
        setResult(r);
        setError(null);
      })
      .catch((e: unknown) => {
        setResult(null);
        setError(e);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <>
      <PageHeader
        title={t('gl.simulateTitle')}
        icon={FlaskConical}
        description={t('gl.simulateIntro')}
      />
      <form className="card" onSubmit={submit}>
        <Field
          label={t('gl.eventKey')}
          value={form.eventKey}
          required
          onChange={(e) => {
            setForm({ ...form, eventKey: e.target.value });
          }}
        />
        <Field
          label={t('gl.date')}
          type="date"
          value={form.entryDate}
          required
          onChange={(e) => {
            setForm({ ...form, entryDate: e.target.value });
          }}
        />
        <Textarea
          label={t('gl.inputsJson')}
          rows={6}
          value={form.inputs}
          error={fieldError}
          onChange={(e) => {
            setForm({ ...form, inputs: e.target.value });
          }}
        />
        <Button type="submit" disabled={busy || form.eventKey.trim() === ''}>
          {t('gl.simulate')}
        </Button>
      </form>
      {error === null ? null : <ErrorAlert error={error} />}
      {result === null ? null : (
        <section className="card" aria-label={t('gl.simulationResult')}>
          <h2>{t('gl.simulationResult')}</h2>
          <p>
            {t('gl.ruleUsed', { version: result.rule.versionNo, status: result.rule.status })} ·{' '}
            {result.entryDate} · {result.baseCurrency}
          </p>
          <p>
            {result.totals.balanced ? (
              <Pill tone="success">{t('gl.balanced')}</Pill>
            ) : (
              <Pill tone="warning">{t('gl.notBalanced')}</Pill>
            )}{' '}
            {result.postable ? (
              <Pill tone="success">{t('gl.simPostable')}</Pill>
            ) : (
              <Pill tone="warning">{t('gl.simNotPostable')}</Pill>
            )}
          </p>
          <DataTable
            columns={[
              { key: 'no', header: '#', value: (l: SimulatedLine) => l.lineNo },
              { key: 'account', header: t('gl.account'), value: (l) => l.accountCode },
              { key: 'debit', header: t('gl.debit'), value: (l) => showAmount(l.debit) },
              { key: 'credit', header: t('gl.credit'), value: (l) => showAmount(l.credit) },
              { key: 'currency', header: t('gl.currency'), value: (l) => l.currency },
              { key: 'baseDebit', header: t('gl.baseDebit'), value: (l) => showAmount(l.baseDebit) },
              {
                key: 'baseCredit',
                header: t('gl.baseCredit'),
                value: (l) => showAmount(l.baseCredit),
              },
              { key: 'memo', header: t('gl.memo'), value: (l) => l.memo ?? '' },
            ]}
            rows={result.lines}
            rowKey={(l) => String(l.lineNo)}
            total={result.lines.length}
            page={1}
            pageSize={Math.max(result.lines.length, 1)}
            onPageChange={() => undefined}
            error={null}
            exportName="simulation"
          />
        </section>
      )}
    </>
  );
}
