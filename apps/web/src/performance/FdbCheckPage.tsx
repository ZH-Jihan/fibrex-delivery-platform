/**
 * Snoonu FDB report check (phase 4 row 4.9): the differences between Snoonu's `FDB Report` tab
 * and our own employee records, for staff to review.
 *
 * Rules, and why:
 *   - Nothing here changes an employee, a document or a status. Each row shows both values and
 *     links to the employee profile, where staff fix whichever side is wrong. The buttons only
 *     mark a difference reviewed or ignored; a mark is kept on the next run while both values
 *     stay the same.
 *   - The check runs on request: from the sync source's read-only reader, or from an uploaded
 *     Excel copy of the workbook (the fallback when the Google link is down).
 *   - "Not matched" lists are shown as findings, never hidden: a Falcon ID with no person, a
 *     person without an employee record, an active person the tab does not list.
 *   - Dates are shown as text in the sheet's form (2027-01-15); the CSV download is the rows as
 *     filtered on screen.
 *
 * Depends on: api client, auth, i18n, ui components, data/upload, toast, react-router.
 * Used by: App.tsx (route /performance/fdb-check, permission performance.fdb_check.read).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardCheck, Download, FilePlus2, Play, UserRound } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { uploadFile } from '../data/upload';
import { useI18n } from '../i18n';
import {
  Button,
  EmptyState,
  ErrorAlert,
  Field,
  PageHeader,
  Pill,
  SearchInput,
  Select,
  Skeleton,
  type PillTone,
} from '../ui/components';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/toast';

const KINDS = [
  'unmatched_id',
  'no_employee',
  'not_in_fdb',
  'status_differs',
  'expiry_differs',
  'missing_ours',
  'missing_theirs',
] as const;
const DOCS = [
  'qid',
  'passport',
  'driving_licence',
  'insurance',
  'food_handling',
  'health_card',
] as const;
const REVIEWS = ['open', 'reviewed', 'ignored', 'applied'] as const;
/** The kinds of skip the apply routes report (row 4.9b). */
type SkipReason = 'odd_date' | 'not_in_system' | 'has_date' | 'no_type' | 'failed';

type Kind = (typeof KINDS)[number];
type Review = (typeof REVIEWS)[number];

interface Difference {
  id: string;
  kind: Kind;
  field: string | null;
  partyId: string | null;
  employeeId: string | null;
  externalId: string | null;
  displayName: string | null;
  oursValue: string | null;
  theirsValue: string | null;
  reviewStatus: Review;
  reviewNote: string | null;
  reviewedAt: string | null;
}
interface Check {
  id: string;
  businessDate: string;
  source: 'sheet' | 'upload';
  rowsRead: number;
  matched: number;
  unmatched: number;
  differences: number;
  createdAt: string;
}
interface Listing {
  check: Check | null;
  items: Difference[];
  openByKind: Record<string, number>;
  total: number;
  truncated: boolean;
}
interface Source {
  id: string;
  name: string;
  adapterKind: string;
  active: boolean;
}
interface ApplyLine {
  differenceId: string;
  displayName: string | null;
  externalId: string | null;
  field: string | null;
  date: string | null;
}
interface ApplyPreview {
  people: number;
  documents: number;
  byType: { field: string; count: number }[];
  examples: ApplyLine[];
  skipped: { reason: SkipReason; count: number }[];
}
interface ApplyResult {
  people: number;
  created: number;
  updated: number;
  applied: ApplyLine[];
  skipped: (ApplyLine & { reason: SkipReason })[];
}
interface RunResult {
  rowsRead: number;
  differences: number;
  carriedOver: number;
  positionalColumns: string[];
}

const kindTone = (kind: Kind): PillTone =>
  kind === 'expiry_differs' || kind === 'status_differs'
    ? 'danger'
    : kind === 'missing_theirs'
      ? 'info'
      : 'warning';
const reviewTone = (r: Review): PillTone =>
  r === 'open' ? 'warning' : r === 'reviewed' || r === 'applied' ? 'success' : 'neutral';

/** The rows as a CSV text (quotes doubled, a leading = + - @ made harmless). */
function toCsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const safe = /^[=+\-@]/.test(cell) ? `'${cell}` : cell;
          return `"${safe.replace(/"/g, '""')}"`;
        })
        .join(','),
    )
    .join('\r\n');
}

export function FdbCheckPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const canRun = auth.can('performance.fdb_check.run');
  const canReview = auth.can('performance.fdb_check.review');
  const canProfile = auth.can('people.employee.read');
  // Row 4.9b: writing documents needs the apply permission and the documents write permission.
  const canApply = auth.can('performance.fdb_check.apply') && auth.can('people.document.update');

  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [kind, setKind] = useState('');
  const [field, setField] = useState('');
  const [review, setReview] = useState<string>('open');
  const [q, setQ] = useState('');
  const [sources, setSources] = useState<Source[]>([]);
  const [runOpen, setRunOpen] = useState(false);
  const [sourceId, setSourceId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [runError, setRunError] = useState<unknown>(null);
  const [positional, setPositional] = useState<string[]>([]);
  const [applyOpen, setApplyOpen] = useState(false);
  const [preview, setPreview] = useState<ApplyPreview | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyError, setApplyError] = useState<unknown>(null);

  const load = useCallback(() => {
    api<Listing>('/performance/fdb-check', {
      query: {
        kind: kind === '' ? undefined : kind,
        field: field === '' ? undefined : field,
        review: review === '' ? undefined : review,
        q: q.trim() === '' ? undefined : q.trim(),
      },
    })
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, [kind, field, review, q]);
  useEffect(() => {
    const timer = setTimeout(load, q === '' ? 0 : 300);
    return () => {
      clearTimeout(timer);
    };
  }, [load, q]);

  useEffect(() => {
    if (!canRun) return;
    api<{ items: Source[] }>('/sync-sources')
      .then((r) => {
        const usable = r.items.filter((s) => s.active);
        setSources(usable);
        setSourceId((current) => (current === '' ? (usable[0]?.id ?? '') : current));
      })
      .catch(() => {
        // The run dialog then offers no source; the list itself still works.
      });
  }, [canRun]);

  const run = () => {
    setRunError(null);
    setBusy(true);
    const send = (fileObjectId: string | undefined) =>
      api<RunResult>('/performance/fdb-check/run', {
        method: 'POST',
        body: { syncSourceId: sourceId, ...(fileObjectId === undefined ? {} : { fileObjectId }) },
      });
    (file === null ? send(undefined) : uploadFile(file).then(send))
      .then((r) => {
        setRunOpen(false);
        setFile(null);
        setPositional(r.positionalColumns);
        toast.show(
          t('fdb.ran', {
            rows: String(r.rowsRead),
            differences: String(r.differences),
            kept: String(r.carriedOver),
          }),
          'success',
        );
        load();
      })
      .catch((e: unknown) => {
        setRunError(e);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const mark = (item: Difference, status: Review) => {
    api<{ reviewStatus: Review; reviewNote: string | null; reviewedAt: string | null }>(
      `/performance/fdb-check/differences/${item.id}/review`,
      { method: 'POST', body: { status } },
    )
      .then(() => {
        load();
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };

  const openApply = () => {
    setApplyError(null);
    setApplyResult(null);
    setPreview(null);
    setApplyOpen(true);
    api<ApplyPreview>('/performance/fdb-check/apply-all/preview')
      .then(setPreview)
      .catch((e: unknown) => {
        setApplyError(e);
      });
  };
  const confirmApply = () => {
    setApplyBusy(true);
    setApplyError(null);
    api<ApplyResult>('/performance/fdb-check/apply-all', { method: 'POST', body: {} })
      .then((r) => {
        setApplyResult(r);
        toast.show(
          t('fdb.applyDone', {
            documents: String(r.created + r.updated),
            people: String(r.people),
            skipped: String(r.skipped.length),
          }),
          r.skipped.length === 0 ? 'success' : 'info',
        );
        load();
      })
      .catch((e: unknown) => {
        setApplyError(e);
      })
      .finally(() => {
        setApplyBusy(false);
      });
  };
  const applyOne = (item: Difference) => {
    api<{ skipped: SkipReason | null }>(`/performance/fdb-check/differences/${item.id}/apply`, {
      method: 'POST',
      body: {},
    })
      .then((r) => {
        toast.show(
          r.skipped === null ? t('fdb.useDateDone') : t(`fdb.skip.${r.skipped}` as never),
          r.skipped === null ? 'success' : 'info',
        );
        load();
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };

  const docName = (code: string | null) => (code === null ? '' : t(`fdb.doc.${code}` as never));
  const finding = (d: Difference) =>
    d.field === null
      ? t(`fdb.kind.${d.kind}` as never)
      : `${t(`fdb.kind.${d.kind}` as never)}: ${docName(d.field)}`;

  const download = () => {
    if (data === null) return;
    const rows = [
      [
        t('fdb.person'),
        t('fdb.falconId'),
        t('fdb.finding'),
        t('fdb.ours'),
        t('fdb.theirs'),
        t('fdb.review'),
      ],
      ...data.items.map((d) => [
        d.displayName ?? '',
        d.externalId ?? '',
        finding(d),
        d.oursValue ?? '',
        d.theirsValue ?? '',
        t(`fdb.review.${d.reviewStatus}` as never),
      ]),
    ];
    const bom = String.fromCharCode(0xfeff);
    const url = URL.createObjectURL(new Blob([bom + toCsv(rows)], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `fdb-check-${data.check?.businessDate ?? 'latest'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const check = data?.check ?? null;
  return (
    <div>
      <PageHeader
        title={t('fdb.title')}
        icon={ClipboardCheck}
        description={t('fdb.intro')}
        actions={
          <>
            <Button
              icon={Download}
              onClick={download}
              disabled={data === null || data.items.length === 0}
            >
              {t('fdb.exportCsv')}
            </Button>
            {canApply && (data?.openByKind.missing_ours ?? 0) > 0 ? (
              <Button icon={FilePlus2} onClick={openApply}>
                {t('fdb.applyAll')}
              </Button>
            ) : null}
            {canRun ? (
              <Button
                icon={Play}
                variant="primary"
                onClick={() => {
                  setRunError(null);
                  setRunOpen(true);
                }}
              >
                {t('fdb.run')}
              </Button>
            ) : null}
          </>
        }
      />
      <ErrorAlert error={error} />
      {positional.length > 0 ? <p className="muted">{t('fdb.positional')}</p> : null}

      {data === null && error === null ? (
        <Skeleton lines={5} />
      ) : check === null ? (
        <EmptyState title={t('fdb.noRun')} />
      ) : data !== null ? (
        <>
          <p className="muted">
            {t('fdb.lastRun', {
              date: check.businessDate,
              rows: String(check.rowsRead),
              matched: String(check.matched),
              unmatched: String(check.unmatched),
              source: t(`fdb.source.${check.source}` as never),
            })}
          </p>
          <div className="toolbar" aria-label={t('fdb.openByKind')}>
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                className={`pill pill-${kindTone(k)}`}
                aria-pressed={kind === k}
                onClick={() => {
                  setKind(kind === k ? '' : k);
                  setReview('open');
                }}
              >
                {t(`fdb.kind.${k}` as never)}: {data.openByKind[k] ?? 0}
              </button>
            ))}
          </div>
          <div className="toolbar">
            <SearchInput
              label={t('fdb.search')}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
              }}
            />
            <Select
              label={t('fdb.kindLabel')}
              value={kind}
              placeholder={t('fdb.all')}
              options={KINDS.map((k) => ({ value: k, label: t(`fdb.kind.${k}` as never) }))}
              onChange={(e) => {
                setKind(e.target.value);
              }}
            />
            <Select
              label={t('fdb.docLabel')}
              value={field}
              placeholder={t('fdb.all')}
              options={DOCS.map((d) => ({ value: d, label: docName(d) }))}
              onChange={(e) => {
                setField(e.target.value);
              }}
            />
            <Select
              label={t('fdb.review')}
              value={review}
              placeholder={t('fdb.all')}
              options={REVIEWS.map((r) => ({ value: r, label: t(`fdb.review.${r}` as never) }))}
              onChange={(e) => {
                setReview(e.target.value);
              }}
            />
          </div>
          {data.truncated ? <p className="muted">{t('fdb.truncated')}</p> : null}
          {data.items.length === 0 ? (
            <EmptyState title={t('fdb.none')} />
          ) : (
            <div className="table-card">
              <div className="table-wrap">
                <table className="stack">
                  <thead>
                    <tr>
                      <th>{t('fdb.person')}</th>
                      <th>{t('fdb.finding')}</th>
                      <th>{t('fdb.ours')}</th>
                      <th>{t('fdb.theirs')}</th>
                      <th>{t('fdb.review')}</th>
                      <th>{t('fdb.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((d) => (
                      <tr key={d.id}>
                        <td data-label={t('fdb.person')}>
                          <strong>{d.displayName ?? '—'}</strong>
                          <div className="muted nowrap">{d.externalId ?? '—'}</div>
                        </td>
                        <td data-label={t('fdb.finding')}>
                          <Pill tone={kindTone(d.kind)}>{t(`fdb.kind.${d.kind}` as never)}</Pill>
                          {d.field === null ? null : (
                            <div className="muted">{docName(d.field)}</div>
                          )}
                        </td>
                        <td data-label={t('fdb.ours')} className="nowrap">
                          {d.oursValue ?? '—'}
                        </td>
                        <td data-label={t('fdb.theirs')} className="nowrap">
                          {d.theirsValue ?? '—'}
                        </td>
                        <td data-label={t('fdb.review')}>
                          <Pill tone={reviewTone(d.reviewStatus)}>
                            {t(`fdb.review.${d.reviewStatus}` as never)}
                          </Pill>
                          {d.reviewNote === null ? null : (
                            <div className="muted">{d.reviewNote}</div>
                          )}
                        </td>
                        <td data-label={t('fdb.actions')}>
                          <div className="row-actions">
                            {canApply &&
                            d.kind === 'missing_ours' &&
                            d.reviewStatus === 'open' &&
                            d.partyId !== null ? (
                              <Button
                                size="sm"
                                variant="primary"
                                onClick={() => {
                                  applyOne(d);
                                }}
                              >
                                {t('fdb.useDate')}
                              </Button>
                            ) : null}
                            {canReview && d.reviewStatus === 'open' ? (
                              <>
                                <Button
                                  size="sm"
                                  onClick={() => {
                                    mark(d, 'reviewed');
                                  }}
                                >
                                  {t('fdb.markReviewed')}
                                </Button>
                                <Button
                                  size="sm"
                                  onClick={() => {
                                    mark(d, 'ignored');
                                  }}
                                >
                                  {t('fdb.markIgnored')}
                                </Button>
                              </>
                            ) : null}
                            {canReview &&
                            d.reviewStatus !== 'open' &&
                            d.reviewStatus !== 'applied' ? (
                              <Button
                                size="sm"
                                onClick={() => {
                                  mark(d, 'open');
                                }}
                              >
                                {t('fdb.reopen')}
                              </Button>
                            ) : null}
                            {canProfile && d.employeeId !== null ? (
                              <Link className="btn btn-sm" to={`/employees/${d.employeeId}`}>
                                <UserRound aria-hidden size={14} /> {t('fdb.openProfile')}
                              </Link>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      ) : null}

      <Modal
        open={applyOpen}
        onClose={() => {
          setApplyOpen(false);
        }}
        aria-labelledby="fdb-apply-title"
      >
        <h2 id="fdb-apply-title">{t('fdb.applyTitle')}</h2>
        <ErrorAlert error={applyError} />
        {applyResult !== null ? (
          <>
            <p>
              {t('fdb.applyDone', {
                documents: String(applyResult.created + applyResult.updated),
                people: String(applyResult.people),
                skipped: String(applyResult.skipped.length),
              })}
            </p>
            <div className="table-wrap">
              <table className="stack" aria-label={t('fdb.applyResult')}>
                <thead>
                  <tr>
                    <th>{t('fdb.person')}</th>
                    <th>{t('fdb.docLabel')}</th>
                    <th>{t('fdb.applyDate')}</th>
                    <th>{t('fdb.applyResult')}</th>
                  </tr>
                </thead>
                <tbody>
                  {applyResult.skipped.map((l) => (
                    <tr key={l.differenceId}>
                      <td data-label={t('fdb.person')}>{l.displayName ?? '—'}</td>
                      <td data-label={t('fdb.docLabel')}>{docName(l.field)}</td>
                      <td data-label={t('fdb.applyDate')} className="nowrap">
                        {l.date ?? '—'}
                      </td>
                      <td data-label={t('fdb.applyResult')}>
                        <Pill tone="warning">{t(`fdb.skip.${l.reason}` as never)}</Pill>
                      </td>
                    </tr>
                  ))}
                  {applyResult.applied.map((l) => (
                    <tr key={l.differenceId}>
                      <td data-label={t('fdb.person')}>{l.displayName ?? '—'}</td>
                      <td data-label={t('fdb.docLabel')}>{docName(l.field)}</td>
                      <td data-label={t('fdb.applyDate')} className="nowrap">
                        {l.date ?? '—'}
                      </td>
                      <td data-label={t('fdb.applyResult')}>
                        <Pill tone="success">{t('fdb.applyApplied')}</Pill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="dialog-actions">
              <Button
                onClick={() => {
                  setApplyOpen(false);
                }}
              >
                {t('common.close')}
              </Button>
            </div>
          </>
        ) : preview === null ? (
          applyError === null ? (
            <Skeleton lines={3} />
          ) : null
        ) : (
          <>
            <p className="muted">{t('fdb.applyIntro')}</p>
            {preview.documents === 0 ? (
              <p>{t('fdb.applyNothing')}</p>
            ) : (
              <>
                <p>
                  <strong>
                    {t('fdb.applySummary', {
                      documents: String(preview.documents),
                      people: String(preview.people),
                    })}
                  </strong>
                </p>
                <h3>{t('fdb.applyByType')}</h3>
                <ul>
                  {preview.byType.map((b) => (
                    <li key={b.field}>
                      {docName(b.field)}: {b.count}
                    </li>
                  ))}
                </ul>
                <h3>{t('fdb.applyExamples')}</h3>
                <ul>
                  {preview.examples.map((e) => (
                    <li key={e.differenceId}>
                      {e.displayName ?? '—'} · {docName(e.field)} · {e.date ?? '—'}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {preview.skipped.length > 0 ? (
              <>
                <h3>{t('fdb.applyLeftOut')}</h3>
                <ul>
                  {preview.skipped.map((k) => (
                    <li key={k.reason}>
                      {t(`fdb.skip.${k.reason}` as never)}: {k.count}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            <div className="dialog-actions">
              <Button
                onClick={() => {
                  setApplyOpen(false);
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={applyBusy || preview.documents === 0}
                onClick={confirmApply}
              >
                {t('common.confirm')}
              </Button>
            </div>
          </>
        )}
      </Modal>

      <Modal
        open={runOpen}
        onClose={() => {
          setRunOpen(false);
        }}
        aria-labelledby="fdb-run-title"
      >
        <h2 id="fdb-run-title">{t('fdb.run')}</h2>
        <ErrorAlert error={runError} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run();
          }}
        >
          <p className="muted">{t('fdb.runHelp')}</p>
          <Select
            label={t('fdb.sourceLabel')}
            value={sourceId}
            options={sources.map((s) => ({ value: s.id, label: s.name }))}
            onChange={(e) => {
              setSourceId(e.target.value);
            }}
          />
          <Field
            label={t('fdb.excelFile')}
            type="file"
            accept=".xlsx"
            hint={t('fdb.excelHint')}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
            }}
          />
          <div className="dialog-actions">
            <Button
              onClick={() => {
                setRunOpen(false);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={busy || sourceId === ''}>
              {t('fdb.start')}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
