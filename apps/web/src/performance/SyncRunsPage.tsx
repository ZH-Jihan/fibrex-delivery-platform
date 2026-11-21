/**
 * Sync runs (phase 4 row 4.5a): the log of every report read, with the three ways to start
 * one by hand: Run now, Re-import range and Upload a day's Excel.
 *
 * Rules, and why:
 *   - The three buttons only queue the run (the API answers 202); the worker does it as the
 *     person who clicked, the same path as the 04:00 job. So the list is reloaded a moment
 *     later and again with the Refresh button; a run shows as "running" until it ends.
 *   - They need `performance.sync_run.run`; the list needs `performance.sync_run.read`.
 *   - Re-import and upload ask for dates in the form the API checks (a range of at most
 *     62 days; the day the Excel file was downloaded).
 *   - An Excel file goes through the normal signed upload (`uploadFile`), then its file id is
 *     sent to the source's upload route.
 *
 * Depends on: api client, auth, i18n, ui components, data/upload, toast, react-router.
 * Used by: App.tsx (route /performance/sync-runs); `syncRunTone` and `SyncRun` are reused by
 * ./SyncRunDetailPage.tsx.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { History, Play, RefreshCw, Repeat, Upload } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { uploadFile } from '../data/upload';
import { useI18n } from '../i18n';
import { Modal } from '../ui/Modal';
import {
  Button,
  EmptyState,
  ErrorAlert,
  Field,
  PageHeader,
  Pill,
  Select,
  Skeleton,
  type PillTone,
} from '../ui/components';
import { useToast } from '../ui/toast';

export interface SyncRun {
  id: string;
  syncSourceId: string;
  businessDate: string;
  trigger: 'scheduled' | 'manual' | 'reimport' | 'upload';
  status: 'running' | 'succeeded' | 'partial' | 'failed';
  rangeFrom: string | null;
  rangeTo: string | null;
  rowsRead: number;
  matched: number;
  unmatched: number;
  errorsCount: number;
  rawInputId: string | null;
  snapshotReused: boolean;
  layoutChanged: boolean;
  startedAt: string;
  finishedAt: string | null;
}
interface Source {
  id: string;
  name: string;
  platformName: string;
  adapterKind: string;
}
interface RunPage {
  items: SyncRun[];
  total: number;
  page: number;
  pageSize: number;
}

export const syncRunTone = (status: SyncRun['status']): PillTone =>
  status === 'succeeded'
    ? 'success'
    : status === 'partial'
      ? 'warning'
      : status === 'failed'
        ? 'danger'
        : 'info';

type Action = 'reimport' | 'upload' | null;
const today = () => new Date().toISOString().slice(0, 10);

export function SyncRunsPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const canRun = auth.can('performance.sync_run.run');
  const [runs, setRuns] = useState<RunPage | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [sourceId, setSourceId] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<Action>(null);
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [readOn, setReadOn] = useState(today());
  const [file, setFile] = useState<File | null>(null);
  const [formError, setFormError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const load = useCallback(() => {
    api<RunPage>('/sync-runs', {
      query: {
        page,
        pageSize: 25,
        ...(sourceId === '' ? {} : { syncSourceId: sourceId }),
        ...(status === '' ? {} : { status }),
      },
    })
      .then(setRuns)
      .catch((e: unknown) => {
        setError(e);
      });
  }, [page, sourceId, status]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    api<{ items: Source[] }>('/sync-sources')
      .then((r) => {
        setSources(r.items);
      })
      .catch(() => {
        setSources([]);
      });
    return () => {
      window.clearTimeout(timer.current);
    };
  }, []);

  /** The chosen source, or the only one; the buttons act on it. */
  const target =
    sources.find((s) => s.id === sourceId) ?? (sources.length === 1 ? sources[0] : undefined);
  const nameOf = (id: string) => sources.find((s) => s.id === id)?.name ?? '';

  const queued = () => {
    toast.show(t('runs.queued'), 'success');
    setAction(null);
    setFile(null);
    setBusy(false);
    // The worker needs a moment; show its run as soon as it exists.
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(load, 2500);
  };
  const failed = (e: unknown) => {
    setFormError(e);
    setError(e);
    setBusy(false);
  };

  const runNow = () => {
    if (target === undefined) return;
    setError(null);
    api(`/sync-sources/${target.id}/run`, { method: 'POST', body: {} }).then(queued).catch(failed);
  };
  const reimport = () => {
    if (target === undefined) return;
    setFormError(null);
    setBusy(true);
    api(`/sync-sources/${target.id}/reimport`, { method: 'POST', body: { from, to } })
      .then(queued)
      .catch(failed);
  };
  const upload = () => {
    if (target === undefined || file === null) return;
    setFormError(null);
    setBusy(true);
    uploadFile(file)
      .then((fileObjectId) =>
        api(`/sync-sources/${target.id}/upload`, {
          method: 'POST',
          body: { fileObjectId, readOn },
        }),
      )
      .then(queued)
      .catch(failed);
  };

  const pages = runs === null ? 1 : Math.max(1, Math.ceil(runs.total / runs.pageSize));
  return (
    <div>
      <PageHeader
        title={t('runs.title')}
        icon={History}
        description={t('runs.intro')}
        actions={
          <Button icon={RefreshCw} onClick={load}>
            {t('runs.refresh')}
          </Button>
        }
      />
      <ErrorAlert error={error} />
      <div className="toolbar">
        <Select
          label={t('runs.source')}
          value={sourceId}
          placeholder={t('runs.allSources')}
          options={sources.map((s) => ({ value: s.id, label: s.name }))}
          onChange={(e) => {
            setSourceId(e.target.value);
            setPage(1);
          }}
        />
        <Select
          label={t('runs.status')}
          value={status}
          placeholder={t('runs.allStatuses')}
          options={(['running', 'succeeded', 'partial', 'failed'] as const).map((s) => ({
            value: s,
            label: t(`runs.status.${s}` as const),
          }))}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        />
      </div>
      {canRun ? (
        <div className="toolbar" aria-label={t('runs.actions')}>
          <Button icon={Play} disabled={target?.adapterKind !== 'sheet'} onClick={runNow}>
            {t('runs.runNow')}
          </Button>
          <Button
            icon={Repeat}
            disabled={target?.adapterKind !== 'sheet'}
            onClick={() => {
              setFormError(null);
              setAction('reimport');
            }}
          >
            {t('runs.reimport')}
          </Button>
          <Button
            icon={Upload}
            disabled={target === undefined}
            onClick={() => {
              setFormError(null);
              setAction('upload');
            }}
          >
            {t('runs.upload')}
          </Button>
          {target === undefined ? <span className="muted">{t('runs.pickSource')}</span> : null}
        </div>
      ) : null}

      {runs === null ? (
        <Skeleton />
      ) : runs.items.length === 0 ? (
        <EmptyState title={t('runs.none')} />
      ) : (
        <div className="table-card">
          <div className="table-wrap">
            <table className="stack">
              <thead>
                <tr>
                  <th>{t('runs.started')}</th>
                  <th>{t('runs.source')}</th>
                  <th>{t('runs.trigger')}</th>
                  <th>{t('runs.date')}</th>
                  <th>{t('runs.status')}</th>
                  <th>{t('runs.rowsRead')}</th>
                  <th>{t('runs.matched')}</th>
                  <th>{t('runs.unmatched')}</th>
                  <th>{t('runs.errors')}</th>
                </tr>
              </thead>
              <tbody>
                {runs.items.map((r) => (
                  <tr key={r.id}>
                    <td data-label={t('runs.started')}>
                      <Link to={`/performance/sync-runs/${r.id}`}>
                        {new Date(r.startedAt).toLocaleString()}
                      </Link>
                    </td>
                    <td data-label={t('runs.source')}>{nameOf(r.syncSourceId)}</td>
                    <td data-label={t('runs.trigger')}>
                      {t(`runs.trigger.${r.trigger}` as const)}
                    </td>
                    <td data-label={t('runs.date')}>
                      {r.rangeFrom !== null
                        ? `${r.rangeFrom} → ${r.rangeTo ?? ''}`
                        : r.businessDate}
                    </td>
                    <td data-label={t('runs.status')}>
                      <Pill tone={syncRunTone(r.status)}>
                        {t(`runs.status.${r.status}` as const)}
                      </Pill>
                    </td>
                    <td data-label={t('runs.rowsRead')}>{r.rowsRead}</td>
                    <td data-label={t('runs.matched')}>{r.matched}</td>
                    <td data-label={t('runs.unmatched')}>{r.unmatched}</td>
                    <td data-label={t('runs.errors')}>{r.errorsCount}</td>
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
            disabled={page <= 1}
            onClick={() => {
              setPage(page - 1);
            }}
          >
            {t('common.previous')}
          </Button>
          <span className="muted">
            {t('runs.page', { page: String(page), pages: String(pages) })}
          </span>
          <Button
            size="sm"
            disabled={page >= pages}
            onClick={() => {
              setPage(page + 1);
            }}
          >
            {t('common.next')}
          </Button>
        </div>
      ) : null}

      <Modal
        open={action !== null}
        onClose={() => {
          setAction(null);
        }}
        aria-labelledby="sync-action-title"
      >
        <h2 id="sync-action-title">
          {action === 'reimport' ? t('runs.reimport') : t('runs.upload')}
          {target === undefined ? '' : ` — ${target.name}`}
        </h2>
        <ErrorAlert error={formError} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (action === 'reimport') reimport();
            else upload();
          }}
        >
          {action === 'reimport' ? (
            <>
              <p className="muted">{t('runs.reimportHelp')}</p>
              <Field
                label={t('runs.from')}
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                }}
              />
              <Field
                label={t('runs.to')}
                type="date"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                }}
              />
            </>
          ) : (
            <>
              <p className="muted">{t('runs.uploadHelp')}</p>
              <Field
                label={t('runs.downloadedOn')}
                type="date"
                value={readOn}
                onChange={(e) => {
                  setReadOn(e.target.value);
                }}
              />
              <Field
                label={t('runs.excelFile')}
                type="file"
                accept=".xlsx"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                }}
              />
            </>
          )}
          <div className="dialog-actions">
            <Button
              onClick={() => {
                setAction(null);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={busy || (action === 'upload' && file === null)}
            >
              {t('runs.start')}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
