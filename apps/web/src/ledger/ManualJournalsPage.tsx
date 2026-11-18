/**
 * Manual journals screen (phase 2 row 2.16a; PLAN 5.11 `/manual-journals`,
 * `POST /manual-journals/{id}/post`).
 *
 * Flow: list manual journals (draft or posted) -> write or change a draft: date, description
 * and lines (account code, a debit or a credit, optional foreign currency and rate, memo) ->
 * post it. A draft may be unbalanced while it is being written; the screen shows totals per
 * currency as a guide, and posting is where the server applies the real checks (balance in
 * base currency after rates, open period, postable accounts, rounding rule of DECISIONS
 * 2.15b). Once posted the draft is frozen and links to its journal; corrections are made by
 * reversing that journal on the Journals screen (SPEC 2.9).
 *
 * Depends on: api client, auth, i18n, ui components, ledger-utils, @fibrex/shared
 * (`manualJournalLinesSchema`). Used by: App.tsx routes.
 */
import { useCallback, useEffect, useState } from 'react';
import { FilePenLine, Pencil, Plus, Save, Send, Trash2, X } from 'lucide-react';
import { manualJournalLinesSchema, type ManualJournalLine } from '@fibrex/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, ErrorAlert, Field, PageHeader, Pill, Select } from '../ui/components';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DataTable } from '../ui/DataTable';
import {
  accountName,
  flattenTree,
  totalsByCurrency,
  type AccountNode,
  type FlatAccount,
} from './ledger-utils';

interface ManualJournalRow {
  id: string;
  number: string;
  entryDate: string;
  description: string;
  lines: ManualJournalLine[];
  status: 'draft' | 'submitted' | 'posted';
  journalId: string | null;
  version: number;
}
/** One line as typed: every box is text, empty means "not given". */
export interface LineForm {
  accountCode: string;
  debit: string;
  credit: string;
  currency: string;
  fxRate: string;
  memo: string;
}
interface DraftForm {
  entryDate: string;
  description: string;
  lines: LineForm[];
}

const today = () => new Date().toISOString().slice(0, 10);
const emptyLine = (): LineForm => ({
  accountCode: '',
  debit: '',
  credit: '',
  currency: '',
  fxRate: '',
  memo: '',
});
const ifMatch = (version: number) => ({ 'If-Match': `"${String(version)}"` });

/** Typed lines -> the API's line shape, leaving out every empty box. */
export function toApiLines(lines: readonly LineForm[]): Record<string, string>[] {
  return lines.map((l) => {
    const out: Record<string, string> = { accountCode: l.accountCode.trim() };
    for (const key of ['debit', 'credit', 'currency', 'fxRate', 'memo'] as const) {
      const value = l[key].trim();
      if (value !== '') out[key] = value;
    }
    return out;
  });
}

/** A stored line -> boxes for the editor. */
export function toLineForm(line: ManualJournalLine): LineForm {
  return {
    accountCode: line.accountCode,
    debit: line.debit ?? '',
    credit: line.credit ?? '',
    currency: line.currency ?? '',
    fxRate: line.fxRate ?? '',
    memo: line.memo ?? '',
  };
}

export function ManualJournalsPage() {
  const { t, language } = useI18n();
  const auth = useAuth();
  const [rows, setRows] = useState<ManualJournalRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [accounts, setAccounts] = useState<FlatAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState<DraftForm | null>(null);
  const [editing, setEditing] = useState<ManualJournalRow | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [posting, setPosting] = useState<ManualJournalRow | null>(null);
  const [removing, setRemoving] = useState<ManualJournalRow | null>(null);
  const [reason, setReason] = useState('');
  const [posted, setPosted] = useState<string | null>(null);

  const readsAccounts = auth.can('gl.account.read');
  useEffect(() => {
    if (!readsAccounts) return;
    api<{ items: AccountNode[] }>('/accounts/tree')
      .then((r) => {
        setAccounts(flattenTree(r.items));
      })
      .catch(() => undefined);
  }, [readsAccounts]);

  const load = useCallback(() => {
    setLoading(true);
    api<{ items: ManualJournalRow[]; total: number }>('/manual-journals', {
      query: { page, pageSize: 50, status: status === '' ? undefined : status },
    })
      .then((r) => {
        setRows(r.items);
        setTotal(r.total);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [page, status]);
  useEffect(load, [load]);

  const setLine = (index: number, change: Partial<LineForm>) => {
    if (form === null) return;
    setForm({
      ...form,
      lines: form.lines.map((l, i) => (i === index ? { ...l, ...change } : l)),
    });
  };

  const save = () => {
    if (form === null) return;
    const lines = toApiLines(form.lines);
    const checked = manualJournalLinesSchema.safeParse(lines);
    if (form.description.trim() === '') {
      setProblem(t('gl.descriptionRequired'));
      return;
    }
    if (!checked.success) {
      const issue = checked.error.issues[0];
      const lineNo = typeof issue?.path[0] === 'number' ? issue.path[0] + 1 : 0;
      setProblem(t('gl.lineProblem', { line: lineNo, message: issue?.message ?? '' }));
      return;
    }
    setProblem(null);
    const body = { entryDate: form.entryDate, description: form.description.trim(), lines };
    const job =
      editing === null
        ? api('/manual-journals', { method: 'POST', body })
        : api(`/manual-journals/${editing.id}`, {
            method: 'PATCH',
            headers: ifMatch(editing.version),
            body,
          });
    job
      .then(() => {
        setForm(null);
        setEditing(null);
        setError(null);
        load();
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };

  const post = () => {
    if (posting === null) return;
    const target = posting;
    setPosting(null);
    api<{ journal: { number: string } }>(`/manual-journals/${target.id}/post`, {
      method: 'POST',
      headers: ifMatch(target.version),
    })
      .then((r) => {
        setPosted(r.journal.number);
        setError(null);
        load();
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };

  const accountOptions = accounts
    .filter((a) => a.isPostable)
    .map((a) => ({ value: a.code, label: `${a.code} ${accountName(a, language)}` }));
  const totals = form === null ? [] : totalsByCurrency(form.lines, t('gl.base'));

  return (
    <>
      <PageHeader
        title={t('gl.manualTitle')}
        icon={FilePenLine}
        description={t('gl.manualIntro')}
        actions={
          auth.can('gl.manual_journal.create') ? (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setEditing(null);
                setProblem(null);
                setForm({ entryDate: today(), description: '', lines: [emptyLine(), emptyLine()] });
              }}
            >
              {t('gl.newManual')}
            </Button>
          ) : null
        }
      />
      {error !== null && !loading ? <ErrorAlert error={error} /> : null}
      {posted === null ? null : (
        <p role="status" className="muted">
          {t('gl.postedAs', { number: posted })}
        </p>
      )}
      {form === null ? null : (
        <section
          className="card"
          aria-label={
            editing === null ? t('gl.newManual') : t('gl.editManual', { number: editing.number })
          }
        >
          <h2>
            {editing === null ? t('gl.newManual') : t('gl.editManual', { number: editing.number })}
          </h2>
          <Field
            label={t('gl.date')}
            type="date"
            value={form.entryDate}
            onChange={(e) => {
              setForm({ ...form, entryDate: e.target.value });
            }}
          />
          <Field
            label={t('gl.description')}
            value={form.description}
            onChange={(e) => {
              setForm({ ...form, description: e.target.value });
            }}
          />
          {form.lines.map((line, i) => (
            <fieldset key={i} className="card" aria-label={t('gl.lineNo', { line: i + 1 })}>
              <legend>{t('gl.lineNo', { line: i + 1 })}</legend>
              {accountOptions.length === 0 ? (
                <Field
                  label={t('gl.accountCode')}
                  value={line.accountCode}
                  onChange={(e) => {
                    setLine(i, { accountCode: e.target.value.toUpperCase() });
                  }}
                />
              ) : (
                <Select
                  label={t('gl.account')}
                  placeholder={t('gl.chooseAccount')}
                  options={accountOptions}
                  value={line.accountCode}
                  onChange={(e) => {
                    setLine(i, { accountCode: e.target.value });
                  }}
                />
              )}
              <Field
                label={t('gl.debit')}
                inputMode="decimal"
                value={line.debit}
                onChange={(e) => {
                  setLine(i, { debit: e.target.value });
                }}
              />
              <Field
                label={t('gl.credit')}
                inputMode="decimal"
                value={line.credit}
                onChange={(e) => {
                  setLine(i, { credit: e.target.value });
                }}
              />
              <Field
                label={t('gl.currency')}
                hint={t('gl.currencyLineHint')}
                value={line.currency}
                onChange={(e) => {
                  setLine(i, { currency: e.target.value.toUpperCase() });
                }}
              />
              {line.currency === '' ? null : (
                <Field
                  label={t('gl.fxRate')}
                  hint={t('gl.fxRateHint')}
                  inputMode="decimal"
                  value={line.fxRate}
                  onChange={(e) => {
                    setLine(i, { fxRate: e.target.value });
                  }}
                />
              )}
              <Field
                label={t('gl.memo')}
                value={line.memo}
                onChange={(e) => {
                  setLine(i, { memo: e.target.value });
                }}
              />
              <Button
                variant="link"
                dangerText
                icon={X}
                onClick={() => {
                  setForm({ ...form, lines: form.lines.filter((_, j) => j !== i) });
                }}
              >
                {t('gl.removeLine')}
              </Button>
            </fieldset>
          ))}
          <Button
            icon={Plus}
            onClick={() => {
              setForm({ ...form, lines: [...form.lines, emptyLine()] });
            }}
          >
            {t('gl.addLine')}
          </Button>
          {totals.map((s) => (
            <p key={s.currency}>
              {t('gl.totals', { currency: s.currency, debit: s.debit, credit: s.credit })}{' '}
              {s.balanced ? (
                <Pill tone="success">{t('gl.balanced')}</Pill>
              ) : (
                <Pill tone="warning">{t('gl.notBalanced')}</Pill>
              )}
            </p>
          ))}
          {problem === null ? null : (
            <p className="field-error" role="alert">
              {problem}
            </p>
          )}
          <Button variant="primary" icon={Save} onClick={save}>
            {t('gl.saveDraft')}
          </Button>
          <Button
            onClick={() => {
              setForm(null);
              setEditing(null);
            }}
          >
            {t('common.cancel')}
          </Button>
        </section>
      )}
      <DataTable
        toolbar={
          <Select
            label={t('gl.status')}
            placeholder={t('rep.any')}
            options={[
              { value: 'draft', label: t('gl.status.draft') },
              { value: 'posted', label: t('gl.status.posted') },
            ]}
            value={status}
            onChange={(e) => {
              setPage(1);
              setStatus(e.target.value);
            }}
          />
        }
        columns={[
          { key: 'number', header: t('gl.number'), value: (m) => m.number },
          { key: 'date', header: t('gl.date'), value: (m) => m.entryDate },
          { key: 'description', header: t('gl.description'), value: (m) => m.description },
          { key: 'lines', header: t('gl.lines'), value: (m) => m.lines.length },
          {
            key: 'status',
            header: t('gl.status'),
            value: (m) => t(`gl.status.${m.status}`),
            render: (m) => (
              <Pill tone={m.status === 'posted' ? 'success' : 'neutral'}>
                {t(`gl.status.${m.status}`)}
              </Pill>
            ),
          },
        ]}
        rows={rows}
        rowKey={(m) => m.id}
        total={total}
        page={page}
        pageSize={50}
        onPageChange={setPage}
        loading={loading}
        error={null}
        exportName="manual-journals"
        actions={(m) =>
          m.status === 'posted' ? null : (
            <>
              {auth.can('gl.manual_journal.update') ? (
                <Button
                  variant="link"
                  icon={Pencil}
                  onClick={() => {
                    setEditing(m);
                    setProblem(null);
                    setForm({
                      entryDate: m.entryDate,
                      description: m.description,
                      lines: m.lines.map(toLineForm),
                    });
                  }}
                >
                  {t('common.edit')}
                </Button>
              ) : null}
              {auth.can('gl.manual_journal.post') ? (
                <Button
                  variant="link"
                  icon={Send}
                  onClick={() => {
                    setPosted(null);
                    setPosting(m);
                  }}
                >
                  {t('gl.post')}
                </Button>
              ) : null}
              {auth.can('gl.manual_journal.delete') ? (
                <Button
                  variant="link"
                  dangerText
                  icon={Trash2}
                  onClick={() => {
                    setRemoving(m);
                  }}
                >
                  {t('common.delete')}
                </Button>
              ) : null}
            </>
          )
        }
      />
      <ConfirmDialog
        open={posting !== null}
        title={t('gl.post')}
        confirmLabel={t('gl.post')}
        onCancel={() => {
          setPosting(null);
        }}
        onConfirm={post}
      >
        <p>{t('gl.postHint', { number: posting?.number ?? '' })}</p>
      </ConfirmDialog>
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
          api(`/manual-journals/${target.id}`, {
            method: 'DELETE',
            body: { reason: reason.trim() },
            headers: ifMatch(target.version),
          })
            .then(load)
            .catch((e: unknown) => {
              setError(e);
            });
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
