/**
 * Reconciliation screen (phase 2 row 2.17b; PLAN 3.9 `reconciliation_match`).
 *
 * Pick a statement, then pair each bank line with the ledger entry that recorded it:
 *   - "Auto-match" pairs only lines that have exactly one safe candidate (same amount, close
 *     date, saved rules first); anything ambiguous is left for a person.
 *   - "Match" on an unmatched line lists the ledger lines on that bank account with exactly the
 *     same amount and currency, within a date window you can widen; one click pairs them.
 *   - "Unmatch" asks for a reason and frees both sides. The ledger is never changed here: a
 *     difference between bank and books is fixed by posting a journal, then matching it.
 * A statement turns "reconciled" when every line is matched. Amounts are shown exactly as the
 * server sends them (decimal strings), never rounded in the browser.
 *
 * Depends on: api client, auth, i18n, ui, bank-ui, ledger-utils. Used by: App.tsx routes.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { GitCompareArrows, Link2, Unlink, Wand2 } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, ErrorAlert, PageHeader, Pill, Select } from '../ui/components';
import { DataTable } from '../ui/DataTable';
import { Modal } from '../ui/Modal';
import { ifMatch, ReasonDialog, useApiList } from './bank-ui';
import type { StatementRow } from './StatementsPage';

export interface ReconLine {
  id: string;
  lineNo: number;
  valueDate: string;
  amount: string;
  currency: string;
  reference: string | null;
  description: string | null;
  matchStatus: 'unmatched' | 'matched';
  match: {
    id: string;
    version: number;
    method: 'rule' | 'manual';
    journalNumber: string;
    entryDate: string;
  } | null;
}
interface Candidate {
  journalLineId: string;
  entryDate: string;
  journalNumber: string;
  description: string | null;
  memo: string | null;
  amount: string;
  currency: string;
}
interface AutoResult {
  matched: number;
  ambiguous: number;
  unmatched: number;
}

const PAGE_SIZE = 100;
const WINDOWS = [3, 7, 30] as const;

export function ReconciliationPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const [params, setParams] = useSearchParams();
  const statementId = params.get('statement') ?? '';
  const statements = useApiList<StatementRow>('/bank-statements', { pageSize: 200 });
  const [lines, setLines] = useState<ReconLine[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [only, setOnly] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<AutoResult | null>(null);
  const [picking, setPicking] = useState<ReconLine | null>(null);
  const [windowDays, setWindowDays] = useState<number>(30);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [unmatching, setUnmatching] = useState<ReconLine | null>(null);

  const statement = statements.rows.find((s) => s.id === statementId) ?? null;

  const load = useCallback(() => {
    if (statementId === '') return;
    setLoading(true);
    api<{ items: ReconLine[]; total: number }>(`/bank-statements/${statementId}/reconciliation`, {
      query: { page, pageSize: PAGE_SIZE, matchStatus: only === '' ? undefined : only },
    })
      .then((r) => {
        setLines(r.items);
        setTotal(r.total);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [statementId, page, only]);
  useEffect(load, [load]);

  // The candidates for the line being matched, for the chosen window.
  useEffect(() => {
    if (picking === null) return;
    api<{ items: Candidate[] }>(`/bank-statement-lines/${picking.id}/candidates`, {
      query: { windowDays },
    })
      .then((r) => {
        setCandidates(r.items);
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, [picking, windowDays]);

  const refresh = () => {
    load();
    statements.reload();
  };

  const autoMatch = () => {
    api<AutoResult>(`/bank-statements/${statementId}/auto-match`, { method: 'POST', body: {} })
      .then((r) => {
        setResult(r);
        setError(null);
        refresh();
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };

  const matchWith = (candidate: Candidate) => {
    if (picking === null) return;
    api('/reconciliation-matches', {
      method: 'POST',
      body: { statementLineId: picking.id, journalLineId: candidate.journalLineId },
    })
      .then(() => {
        setPicking(null);
        setError(null);
        refresh();
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };

  return (
    <>
      <PageHeader
        title={t('bank.reconTitle')}
        icon={GitCompareArrows}
        description={t('bank.reconIntro')}
        actions={
          statementId !== '' && auth.can('gl.reconciliation.auto') ? (
            <Button variant="primary" icon={Wand2} onClick={autoMatch}>
              {t('bank.autoMatch')}
            </Button>
          ) : null
        }
      />
      <Select
        label={t('bank.statement')}
        placeholder={t('bank.choose')}
        options={statements.rows.map((s) => ({
          value: s.id,
          label: `${s.fileName} (${s.periodFrom} – ${s.periodTo})`,
        }))}
        value={statementId}
        onChange={(e) => {
          setPage(1);
          setResult(null);
          setParams(e.target.value === '' ? {} : { statement: e.target.value });
        }}
      />
      {statement === null ? null : (
        <p>
          <Pill tone={statement.status === 'reconciled' ? 'success' : 'warning'}>
            {t(`bank.status.${statement.status}`)}
          </Pill>{' '}
          {t('bank.totalIn')}: {statement.totalIn} · {t('bank.totalOut')}: {statement.totalOut}{' '}
          {statement.currency}
        </p>
      )}
      {result === null ? null : <p role="status">{t('bank.autoResult', { ...result })}</p>}
      {error !== null ? <ErrorAlert error={error} /> : null}
      {statementId === '' ? null : (
        <DataTable
          toolbar={
            <Select
              label={t('gl.state')}
              placeholder={t('rep.any')}
              options={[
                { value: 'unmatched', label: t('bank.line.unmatched') },
                { value: 'matched', label: t('bank.line.matched') },
              ]}
              value={only}
              onChange={(e) => {
                setPage(1);
                setOnly(e.target.value);
              }}
            />
          }
          columns={[
            { key: 'no', header: '#', value: (l: ReconLine) => l.lineNo },
            { key: 'date', header: t('gl.date'), value: (l) => l.valueDate },
            { key: 'amount', header: t('bank.amount'), value: (l) => `${l.amount} ${l.currency}` },
            { key: 'ref', header: t('bank.reference'), value: (l) => l.reference ?? '' },
            { key: 'desc', header: t('gl.description'), value: (l) => l.description ?? '' },
            {
              key: 'status',
              header: t('gl.state'),
              value: (l) => t(`bank.line.${l.matchStatus}`),
              render: (l) => (
                <Pill tone={l.matchStatus === 'matched' ? 'success' : 'warning'}>
                  {t(`bank.line.${l.matchStatus}`)}
                </Pill>
              ),
            },
            {
              key: 'journal',
              header: t('bank.matchedWith'),
              value: (l) =>
                l.match === null
                  ? ''
                  : `${l.match.journalNumber} · ${l.match.entryDate} · ${t(`bank.method.${l.match.method}`)}`,
            },
          ]}
          rows={lines}
          rowKey={(l) => l.id}
          total={total}
          page={page}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
          loading={loading}
          error={null}
          exportName="reconciliation"
          actions={(l) =>
            l.match === null ? (
              auth.can('gl.reconciliation.create') ? (
                <Button
                  variant="link"
                  icon={Link2}
                  onClick={() => {
                    setCandidates([]);
                    setWindowDays(30);
                    setPicking(l);
                  }}
                >
                  {t('bank.match')}
                </Button>
              ) : null
            ) : auth.can('gl.reconciliation.delete') ? (
              <Button
                variant="link"
                dangerText
                icon={Unlink}
                onClick={() => {
                  setUnmatching(l);
                }}
              >
                {t('bank.unmatch')}
              </Button>
            ) : null
          }
        />
      )}

      <Modal
        open={picking !== null}
        onClose={() => {
          setPicking(null);
        }}
        aria-label={t('bank.match')}
      >
        {picking === null ? null : (
          <section className="card">
            <h2>{t('bank.match')}</h2>
            <p>
              {picking.valueDate} · <strong>{picking.amount}</strong> {picking.currency} ·{' '}
              {picking.reference ?? ''} {picking.description ?? ''}
            </p>
            <Select
              label={t('bank.window')}
              options={WINDOWS.map((d) => ({
                value: String(d),
                label: t('bank.days', { days: d }),
              }))}
              value={String(windowDays)}
              onChange={(e) => {
                setWindowDays(Number(e.target.value));
              }}
            />
            {candidates.length === 0 ? (
              <p className="muted">{t('bank.noCandidates')}</p>
            ) : (
              <DataTable
                columns={[
                  { key: 'no', header: t('gl.number'), value: (c: Candidate) => c.journalNumber },
                  { key: 'date', header: t('gl.date'), value: (c) => c.entryDate },
                  {
                    key: 'what',
                    header: t('gl.description'),
                    value: (c) => c.memo ?? c.description ?? '',
                  },
                  {
                    key: 'amount',
                    header: t('bank.amount'),
                    value: (c) => `${c.amount} ${c.currency}`,
                  },
                ]}
                rows={candidates}
                rowKey={(c) => c.journalLineId}
                total={candidates.length}
                page={1}
                pageSize={Math.max(candidates.length, 1)}
                onPageChange={() => undefined}
                error={null}
                exportName="candidates"
                actions={(c) => (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      matchWith(c);
                    }}
                  >
                    {t('bank.matchThis')}
                  </Button>
                )}
              />
            )}
            <div className="form-actions">
              <Button
                onClick={() => {
                  setPicking(null);
                }}
              >
                {t('common.close')}
              </Button>
            </div>
          </section>
        )}
      </Modal>

      <ReasonDialog
        open={unmatching !== null}
        title={t('bank.unmatch')}
        hint={t('bank.unmatchHint')}
        onCancel={() => {
          setUnmatching(null);
        }}
        onConfirm={(reason) => {
          const match = unmatching?.match;
          setUnmatching(null);
          if (match === null || match === undefined) return;
          api(`/reconciliation-matches/${match.id}`, {
            method: 'DELETE',
            body: { reason },
            headers: ifMatch(match.version),
          })
            .then(() => {
              setError(null);
              refresh();
            })
            .catch((e: unknown) => {
              setError(e);
            });
        }}
      />
    </>
  );
}
