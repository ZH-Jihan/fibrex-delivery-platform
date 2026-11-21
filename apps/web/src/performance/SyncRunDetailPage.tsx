/**
 * Sync run detail (phase 4 row 4.5a): one run with its counts, the business dates it stored,
 * every error by sheet row number, and a link to the raw snapshot it read.
 *
 * Rules, and why:
 *   - Errors are listed by row number (the row of the sheet, so the owner can look at it) and
 *     paged 100 at a time.
 *   - The raw snapshot is the exact bytes read (SPEC 2.5). It is downloaded through the signed
 *     download link of the files module, never through a path of ours. A run that reused an
 *     earlier snapshot says so.
 *
 * Depends on: api client, i18n, ui components, ./SyncRunsPage (types, status colour).
 * Used by: App.tsx (route /performance/sync-runs/:id).
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Download, History } from 'lucide-react';
import { api } from '../api/client';
import { useI18n } from '../i18n';
import { Button, EmptyState, ErrorAlert, PageHeader, Pill, Skeleton } from '../ui/components';
import { syncRunTone, type SyncRun } from './SyncRunsPage';

interface RunDetail extends SyncRun {
  storedDates: { date: string; rows: number }[];
}
interface RunError {
  id: string;
  rowNo: number | null;
  code: string;
  message: string;
}
interface ErrorPage {
  items: RunError[];
  total: number;
  page: number;
  pageSize: number;
}
interface Raw {
  id: string;
  kind: string;
  sha256: string;
  receivedAt: string;
  fileObjectId: string | null;
  reused: boolean;
}

export function SyncRunDetailPage() {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [sourceName, setSourceName] = useState('');
  const [errors, setErrors] = useState<ErrorPage | null>(null);
  const [errorPage, setErrorPage] = useState(1);
  const [raw, setRaw] = useState<Raw | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api<RunDetail>(`/sync-runs/${id}`)
      .then((r) => {
        setRun(r);
        api<{ name: string }>(`/sync-sources/${r.syncSourceId}`)
          .then((s) => {
            setSourceName(s.name);
          })
          .catch(() => {
            setSourceName('');
          });
        if (r.rawInputId !== null) {
          api<Raw>(`/sync-runs/${id}/raw`)
            .then(setRaw)
            .catch(() => {
              setRaw(null);
            });
        }
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, [id]);

  useEffect(() => {
    api<ErrorPage>(`/sync-runs/${id}/errors`, { query: { page: errorPage, pageSize: 100 } })
      .then(setErrors)
      .catch((e: unknown) => {
        setError(e);
      });
  }, [id, errorPage]);

  const download = () => {
    if (raw?.fileObjectId === null || raw === null) return;
    api<{ url: string }>(`/files/${raw.fileObjectId}/download-url`)
      .then(({ url }) => {
        window.open(url, '_blank', 'noopener');
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };

  const pages = errors === null ? 1 : Math.max(1, Math.ceil(errors.total / errors.pageSize));
  return (
    <div>
      <p>
        <Link to="/performance/sync-runs" className="back-link">
          <ArrowLeft size={16} aria-hidden="true" /> {t('runs.back')}
        </Link>
      </p>
      <PageHeader
        title={t('runs.detailTitle')}
        icon={History}
        description={sourceName === '' ? undefined : sourceName}
      />
      <ErrorAlert error={error} />
      {run === null ? (
        <Skeleton />
      ) : (
        <>
          <section className="card">
            <dl className="details">
              <div className="detail">
                <dt>{t('runs.status')}</dt>
                <dd>
                  <Pill tone={syncRunTone(run.status)}>
                    {t(`runs.status.${run.status}` as const)}
                  </Pill>
                </dd>
              </div>
              <div className="detail">
                <dt>{t('runs.trigger')}</dt>
                <dd>{t(`runs.trigger.${run.trigger}` as const)}</dd>
              </div>
              <div className="detail">
                <dt>{t('runs.started')}</dt>
                <dd>{new Date(run.startedAt).toLocaleString()}</dd>
              </div>
              <div className="detail">
                <dt>{t('runs.finished')}</dt>
                <dd>{run.finishedAt === null ? '—' : new Date(run.finishedAt).toLocaleString()}</dd>
              </div>
              <div className="detail">
                <dt>{t('runs.rowsRead')}</dt>
                <dd>{run.rowsRead}</dd>
              </div>
              <div className="detail">
                <dt>{t('runs.matched')}</dt>
                <dd>{run.matched}</dd>
              </div>
              <div className="detail">
                <dt>{t('runs.unmatched')}</dt>
                <dd>{run.unmatched}</dd>
              </div>
              <div className="detail">
                <dt>{t('runs.errors')}</dt>
                <dd>{run.errorsCount}</dd>
              </div>
            </dl>
            {run.layoutChanged ? <p className="alert">{t('runs.layoutChanged')}</p> : null}
          </section>

          <section className="card">
            <h2>{t('runs.storedDates')}</h2>
            {run.storedDates.length === 0 ? (
              <p className="muted">{t('runs.noStored')}</p>
            ) : (
              <ul className="chips">
                {run.storedDates.map((d) => (
                  <li key={d.date}>
                    <Pill tone="neutral">{`${d.date} · ${t('runs.people', { count: String(d.rows) })}`}</Pill>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <h2>{t('runs.raw')}</h2>
            {raw === null ? (
              <p className="muted">{t('runs.noRaw')}</p>
            ) : (
              <>
                <p className="muted">
                  {t('runs.rawInfo', {
                    when: new Date(raw.receivedAt).toLocaleString(),
                    hash: raw.sha256.slice(0, 12),
                  })}
                  {raw.reused ? ` ${t('runs.rawReused')}` : ''}
                </p>
                {raw.fileObjectId === null ? null : (
                  <Button icon={Download} onClick={download}>
                    {t('runs.downloadRaw')}
                  </Button>
                )}
              </>
            )}
          </section>

          <section className="card">
            <h2>{t('runs.errors')}</h2>
            {errors === null ? (
              <Skeleton />
            ) : errors.items.length === 0 ? (
              <EmptyState title={t('runs.noErrors')} />
            ) : (
              <div className="table-card">
                <div className="table-wrap">
                  <table className="stack">
                    <thead>
                      <tr>
                        <th>{t('runs.row')}</th>
                        <th>{t('runs.code')}</th>
                        <th>{t('runs.message')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {errors.items.map((e) => (
                        <tr key={e.id}>
                          <td data-label={t('runs.row')}>{e.rowNo ?? '—'}</td>
                          <td data-label={t('runs.code')} className="mono">
                            {e.code}
                          </td>
                          <td data-label={t('runs.message')}>{e.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {pages > 1 ? (
              <div className="toolbar">
                <Button
                  size="sm"
                  disabled={errorPage <= 1}
                  onClick={() => {
                    setErrorPage(errorPage - 1);
                  }}
                >
                  {t('common.previous')}
                </Button>
                <span className="muted">
                  {t('runs.page', { page: String(errorPage), pages: String(pages) })}
                </span>
                <Button
                  size="sm"
                  disabled={errorPage >= pages}
                  onClick={() => {
                    setErrorPage(errorPage + 1);
                  }}
                >
                  {t('common.next')}
                </Button>
              </div>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}
