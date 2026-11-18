/**
 * Journals screen (phase 2 row 2.16a; PLAN 5.11 `GET /journals`, `GET /journals/{id}`,
 * `POST /journals/{id}/reverse`).
 *
 * Flow: list posted journals (newest first) with date and account filters -> open one to see
 * its lines in entry currency and in base currency, with base totals -> reverse it with a
 * reason (and optionally a date). Posted journals are never edited or deleted (SPEC 2.9):
 * a correction is a reversal, which the server posts as a new journal pointing back at the
 * original; a journal is reversed at most once and a reversal is never reversed itself
 * (DECISIONS 2.15a), so the button only shows when both hold.
 *
 * Depends on: api client, auth, i18n, ui components, ledger-utils. Used by: App.tsx routes.
 */
import { useCallback, useEffect, useState } from 'react';
import { Eye, NotebookText, Undo2 } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, ErrorAlert, Field, PageHeader, Pill, Select } from '../ui/components';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DataTable } from '../ui/DataTable';
import {
  accountLabel,
  flattenTree,
  showAmount,
  totalsByCurrency,
  type AccountNode,
  type FlatAccount,
} from './ledger-utils';

export interface JournalRow {
  id: string;
  number: string;
  entryDate: string;
  eventKey: string;
  sourceType: string | null;
  description: string;
  lineCount: number;
  reversalOfId: string | null;
  reversedById: string | null;
  reason: string | null;
  postedAt: string;
}
interface JournalLine {
  id: string;
  lineNo: number;
  accountId: string;
  debit: string;
  credit: string;
  currency: string;
  fxRate: string;
  baseDebit: string;
  baseCredit: string;
  partyId: string | null;
  memo: string | null;
}
interface JournalDetail extends JournalRow {
  lines: JournalLine[];
}

const PAGE_SIZE = 50;

/** A journal can be reversed once, and a reversal is never reversed itself. */
export const canReverse = (j: Pick<JournalRow, 'reversalOfId' | 'reversedById'>) =>
  j.reversalOfId === null && j.reversedById === null;

export function JournalsPage() {
  const { t, language } = useI18n();
  const auth = useAuth();
  const [rows, setRows] = useState<JournalRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState({ from: '', to: '', accountId: '' });
  const [accounts, setAccounts] = useState<FlatAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<JournalDetail | null>(null);
  const [reversing, setReversing] = useState(false);
  const [reverse, setReverse] = useState({ reason: '', entryDate: '' });

  // Account names for the lines and the filter; without the permission the ids are shown.
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
    api<{ items: JournalRow[]; total: number }>('/journals', {
      query: {
        page,
        pageSize: PAGE_SIZE,
        from: filter.from === '' ? undefined : filter.from,
        to: filter.to === '' ? undefined : filter.to,
        accountId: filter.accountId === '' ? undefined : filter.accountId,
      },
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
  }, [page, filter]);
  useEffect(load, [load]);

  const show = (id: string) => {
    api<JournalDetail>(`/journals/${id}`)
      .then((d) => {
        setOpen(d);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };

  const doReverse = () => {
    if (open === null || reverse.reason.trim().length < 3) return;
    const target = open;
    setReversing(false);
    api<JournalDetail>(`/journals/${target.id}/reverse`, {
      method: 'POST',
      body: {
        reason: reverse.reason.trim(),
        ...(reverse.entryDate === '' ? {} : { entryDate: reverse.entryDate }),
      },
    })
      .then((posted) => {
        setReverse({ reason: '', entryDate: '' });
        setOpen(posted);
        load();
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };

  // Base totals of the open journal: every posted journal balances in base currency.
  const baseTotals =
    open === null
      ? []
      : totalsByCurrency(
          open.lines.map((l) => ({ debit: l.baseDebit, credit: l.baseCredit })),
          t('gl.base'),
        );

  return (
    <>
      <PageHeader
        title={t('gl.journalsTitle')}
        icon={NotebookText}
        description={t('gl.journalsIntro')}
      />
      {error !== null && !loading ? <ErrorAlert error={error} /> : null}
      <DataTable
        toolbar={
          <>
            <Field
              label={t('gl.from')}
              type="date"
              value={filter.from}
              onChange={(e) => {
                setPage(1);
                setFilter({ ...filter, from: e.target.value });
              }}
            />
            <Field
              label={t('gl.to')}
              type="date"
              value={filter.to}
              onChange={(e) => {
                setPage(1);
                setFilter({ ...filter, to: e.target.value });
              }}
            />
            {accounts.length === 0 ? null : (
              <Select
                label={t('gl.account')}
                placeholder={t('rep.any')}
                options={accounts
                  .filter((a) => a.isPostable)
                  .map((a) => ({ value: a.id, label: accountLabel(accounts, a.id, language) }))}
                value={filter.accountId}
                onChange={(e) => {
                  setPage(1);
                  setFilter({ ...filter, accountId: e.target.value });
                }}
              />
            )}
          </>
        }
        columns={[
          { key: 'number', header: t('gl.number'), value: (j) => j.number },
          { key: 'date', header: t('gl.date'), value: (j) => j.entryDate },
          { key: 'description', header: t('gl.description'), value: (j) => j.description },
          { key: 'event', header: t('gl.event'), value: (j) => j.eventKey },
          {
            key: 'state',
            header: t('gl.state'),
            value: (j) =>
              j.reversedById !== null
                ? t('gl.reversed')
                : j.reversalOfId !== null
                  ? t('gl.reversal')
                  : '',
            render: (j) =>
              j.reversedById !== null ? (
                <Pill tone="warning">{t('gl.reversed')}</Pill>
              ) : j.reversalOfId !== null ? (
                <Pill tone="info">{t('gl.reversal')}</Pill>
              ) : null,
          },
        ]}
        rows={rows}
        rowKey={(j) => j.id}
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
        loading={loading}
        error={null}
        exportName="journals"
        actions={(j) => (
          <Button
            variant="link"
            icon={Eye}
            onClick={() => {
              show(j.id);
            }}
          >
            {t('gl.open')}
          </Button>
        )}
      />
      {open === null ? null : (
        <section className="card" aria-label={t('gl.journalOf', { number: open.number })}>
          <h2>{t('gl.journalOf', { number: open.number })}</h2>
          <p>
            {open.entryDate} · {open.description} · <code>{open.eventKey}</code>
          </p>
          {open.reason === null ? null : (
            <p className="muted">
              {t('gl.reason')}: {open.reason}
            </p>
          )}
          {open.reversalOfId === null ? null : (
            <Button
              variant="link"
              onClick={() => {
                show(open.reversalOfId ?? '');
              }}
            >
              {t('gl.showOriginal')}
            </Button>
          )}
          {open.reversedById === null ? null : (
            <Button
              variant="link"
              onClick={() => {
                show(open.reversedById ?? '');
              }}
            >
              {t('gl.showReversal')}
            </Button>
          )}
          <DataTable
            columns={[
              { key: 'no', header: '#', value: (l: JournalLine) => l.lineNo },
              {
                key: 'account',
                header: t('gl.account'),
                value: (l: JournalLine) => accountLabel(accounts, l.accountId, language),
              },
              {
                key: 'debit',
                header: t('gl.debit'),
                value: (l: JournalLine) => showAmount(l.debit),
              },
              {
                key: 'credit',
                header: t('gl.credit'),
                value: (l: JournalLine) => showAmount(l.credit),
              },
              { key: 'currency', header: t('gl.currency'), value: (l: JournalLine) => l.currency },
              {
                key: 'baseDebit',
                header: t('gl.baseDebit'),
                value: (l: JournalLine) => showAmount(l.baseDebit),
              },
              {
                key: 'baseCredit',
                header: t('gl.baseCredit'),
                value: (l: JournalLine) => showAmount(l.baseCredit),
              },
              { key: 'memo', header: t('gl.memo'), value: (l: JournalLine) => l.memo ?? '' },
            ]}
            rows={open.lines}
            rowKey={(l) => l.id}
            total={open.lines.length}
            page={1}
            pageSize={Math.max(open.lines.length, 1)}
            onPageChange={() => undefined}
            error={null}
            exportName={`journal-${open.number}`}
          />
          {baseTotals.map((s) => (
            <p key={s.currency}>
              {t('gl.totals', { currency: s.currency, debit: s.debit, credit: s.credit })}
            </p>
          ))}
          {canReverse(open) && auth.can('gl.journal.reverse') ? (
            <Button
              variant="danger"
              icon={Undo2}
              onClick={() => {
                setReversing(true);
              }}
            >
              {t('gl.reverse')}
            </Button>
          ) : null}
          <Button
            onClick={() => {
              setOpen(null);
            }}
          >
            {t('common.close')}
          </Button>
        </section>
      )}
      <ConfirmDialog
        open={reversing}
        danger
        title={t('gl.reverse')}
        confirmLabel={t('gl.reverse')}
        onCancel={() => {
          setReversing(false);
        }}
        onConfirm={doReverse}
      >
        <p>{t('gl.reverseHint')}</p>
        <Field
          label={t('gl.reason')}
          value={reverse.reason}
          onChange={(e) => {
            setReverse({ ...reverse, reason: e.target.value });
          }}
        />
        <Field
          label={t('gl.reverseDate')}
          hint={t('gl.reverseDateHint')}
          type="date"
          value={reverse.entryDate}
          onChange={(e) => {
            setReverse({ ...reverse, entryDate: e.target.value });
          }}
        />
      </ConfirmDialog>
    </>
  );
}
