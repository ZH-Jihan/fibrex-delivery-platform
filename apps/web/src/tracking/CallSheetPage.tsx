/**
 * Morning call sheet (phase 4 rows 4.8a and 4.8b; SPEC 3.3): one row per rider or driver with
 * yesterday's orders and active hours from the platform sheet, the day's call and status, and
 * quick actions.
 *
 * Rules, and why:
 *   - Everything comes from `GET /tracking` with the date and the filters (status, search, not
 *     yet called, zero orders). The server applies the filters and works the summary strip out
 *     for exactly the rows that match, so the strip, the list and the exported file always
 *     agree; the screen only shows what it is given. "Showing X of Y" says how many are hidden.
 *   - Zero orders is marked when the sheet reported the day (`reported`): a day nobody has
 *     figures for is a reset, never a zero (4.6a rule), so nothing is marked then.
 *   - "Low hours" is below the company's limit (`lowHoursLimit` from the server, default 4;
 *     people who may update tracking change it in the small settings field). Marks use a pill
 *     with text as well as the row tint, so colour alone never carries the meaning.
 *   - A call is insert-only (`POST /tracking/calls`). A status change goes through the employee
 *     status machine on the server; its refusal is shown unchanged in the dialog.
 *   - "Export to Excel" runs the `tracking.call_sheet` report with the same date and filters
 *     (needs platform.report.export), so the file holds the rows on screen with call outcomes.
 *   - Buttons show only to people who hold the permission: tracking.call.create (call),
 *     tracking.entry.create or .update plus tracking.status.apply (status), and
 *     people.employee.read for the profile link.
 *
 * Depends on: api client, auth, i18n, ui components, ./status-dialog.tsx, toast.
 * Used by: App.tsx (route /tracking), performance/manifest.ts (menu).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardList, FileSpreadsheet, Phone, PhoneCall, Repeat, UserRound } from 'lucide-react';
import { type CrossCheckKind } from '@fibrex/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Modal } from '../ui/Modal';
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
  Textarea,
} from '../ui/components';
import { useToast } from '../ui/toast';
import { StatusDialog, useLookup, useStatuses, type Choice } from './status-dialog';
import { isLowHours, isZeroOrders } from './sheet-rules';

export interface SheetRow {
  partyId: string;
  employeeId: string;
  employeeCode: string;
  name: string;
  platformIds: { identifierId: string; type: string; value: string }[];
  profession: string;
  zone: string | null;
  phone: string | null;
  statusCode: string | null;
  yesterday: { orders: number | null; hours: number | null; lateMinutes: number | null };
  entry: { id: string; version: number; callOutcomeId: string | null } | null;
  calledToday: boolean;
  lastCall: { outcomeId: string; outcomeCode: string | null; at: string } | null;
  crossCheck: CrossCheckKind[];
}
export interface Sheet {
  date: string;
  figuresDate: string;
  reported: boolean;
  summary: {
    totalPeople: number;
    called: number;
    notCalled: number;
    ordersYesterday: number;
    hoursYesterday: number;
    zeroOrders: number;
    statusChangesToday: number;
    byStatus: Record<string, number>;
  };
  rows: SheetRow[];
  filtered: boolean;
  unfiltered: { totalPeople: number; byStatus: Record<string, number> };
  lowHoursLimit: number;
}

const todayText = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** Digits and a leading plus only, so the `tel:` link works whatever the sheet wrote. */
const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`;

type Dialog = { kind: 'call'; row: SheetRow } | { kind: 'status'; row: SheetRow } | null;

export function CallSheetPage() {
  const { t, language } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const canCall = auth.can('tracking.call.create');
  const canStatus =
    auth.can('tracking.status.apply') &&
    (auth.can('tracking.entry.create') || auth.can('tracking.entry.update'));
  const canProfile = auth.can('people.employee.read');

  const [date, setDate] = useState(todayText);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [search, setSearch] = useState('');
  const [notCalledOnly, setNotCalledOnly] = useState(false);
  const [zeroOnly, setZeroOnly] = useState(false);
  const [status, setStatus] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [exporting, setExporting] = useState(false);
  const [limitText, setLimitText] = useState('');
  const canExport = auth.can('platform.report.export');
  const canSettings = auth.can('tracking.entry.update');

  const outcomes = useLookup('call_outcome', language);
  const reasons = useLookup('status_reason', language);
  const statusCodes = useMemo(
    () => Object.keys(sheet?.unfiltered.byStatus ?? {}).sort(),
    [sheet?.unfiltered.byStatus],
  );
  const statuses = useStatuses(language, statusCodes);
  const statusLabel = (code: string | null) =>
    code === null ? '—' : (statuses.find((s) => s.code === code)?.label ?? code);

  // Typing in the search box asks the server once the typing pauses.
  const [query, setQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
    }, 300);
    return () => {
      clearTimeout(timer);
    };
  }, [search]);

  /** The filters as the API and the export take them (only the ones that are set). */
  const filters = useMemo(
    () => ({
      ...(status === '' ? {} : { status }),
      ...(query === '' ? {} : { q: query }),
      ...(notCalledOnly ? { notCalled: 'true' } : {}),
      ...(zeroOnly ? { zeroOrders: 'true' } : {}),
    }),
    [status, query, notCalledOnly, zeroOnly],
  );

  // Only the newest answer is shown: an older, slower one must not overwrite it.
  const latest = useRef(0);
  // A different date is a different sheet: show the loading state, not the old day.
  useEffect(() => {
    setSheet(null);
  }, [date]);
  const load = useCallback(() => {
    latest.current += 1;
    const ticket = latest.current;
    api<Sheet>('/tracking', { query: { date, ...filters } })
      .then((r) => {
        if (ticket !== latest.current) return;
        setSheet(r);
        setError(null);
      })
      .catch((e: unknown) => {
        if (ticket === latest.current) setError(e);
      });
  }, [date, filters]);
  useEffect(() => {
    load();
  }, [load]);

  const rows = sheet?.rows ?? [];

  const outcomeLabel = (outcomeId: string, code: string | null) =>
    outcomes.find((o) => o.id === outcomeId)?.label ?? code ?? '—';

  const done = (message: string) => {
    setDialog(null);
    toast.show(message, 'success');
    load();
  };

  const exportExcel = () => {
    setExporting(true);
    setError(null);
    api<{ fileId: string; fileName: string }>('/reports/tracking.call_sheet/export', {
      method: 'POST',
      body: { format: 'xlsx', filters: { date, ...filters } },
    })
      .then(async (done) => {
        toast.show(t('callSheet.exported', { name: done.fileName }), 'success');
        const { url } = await api<{ url: string }>(`/files/${done.fileId}/download-url`);
        window.location.assign(url);
      })
      .catch((e: unknown) => {
        setError(e);
      })
      .finally(() => {
        setExporting(false);
      });
  };

  const saveLimit = () => {
    setError(null);
    api('/tracking/settings', { method: 'PUT', body: { lowHours: Number(limitText) } })
      .then(() => {
        setLimitText('');
        toast.show(t('callSheet.limitSaved'), 'success');
        load();
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };

  const appliedFilters = [
    status === '' ? null : t('callSheet.filterStatusIs', { status: statusLabel(status) }),
    query === '' ? null : t('callSheet.filterSearchIs', { text: query }),
    notCalledOnly ? t('callSheet.filterNotCalled') : null,
    zeroOnly ? t('callSheet.filterZero') : null,
  ].filter((x): x is string => x !== null);

  const s = sheet?.summary;
  const strip: { key: string; label: string; value: string }[] =
    s === undefined
      ? []
      : [
          { key: 'total', label: t('callSheet.total'), value: String(s.totalPeople) },
          { key: 'called', label: t('callSheet.called'), value: String(s.called) },
          { key: 'notCalled', label: t('callSheet.notCalled'), value: String(s.notCalled) },
          {
            key: 'orders',
            label: t('callSheet.ordersYesterday'),
            value: String(s.ordersYesterday),
          },
          {
            key: 'hours',
            label: t('callSheet.hoursYesterday'),
            value: s.hoursYesterday.toFixed(1),
          },
          { key: 'zero', label: t('callSheet.zeroOrders'), value: String(s.zeroOrders) },
          {
            key: 'changes',
            label: t('callSheet.statusChanges'),
            value: String(s.statusChangesToday),
          },
        ];

  return (
    <div>
      <PageHeader
        title={t('callSheet.title')}
        icon={ClipboardList}
        description={t('callSheet.intro')}
      />
      <ErrorAlert error={error} />

      <div className="toolbar">
        <Field
          label={t('callSheet.date')}
          type="date"
          value={date}
          onChange={(e) => {
            if (e.target.value !== '') setDate(e.target.value);
          }}
        />
        <SearchInput
          label={t('callSheet.search')}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
        />
        <Select
          label={t('callSheet.status')}
          value={status}
          placeholder={t('callSheet.allStatuses')}
          options={statuses.map((x) => ({ value: x.code, label: x.label }))}
          onChange={(e) => {
            setStatus(e.target.value);
          }}
        />
        <Button
          aria-pressed={notCalledOnly}
          variant={notCalledOnly ? 'primary' : 'default'}
          onClick={() => {
            setNotCalledOnly(!notCalledOnly);
          }}
        >
          {t('callSheet.filterNotCalled')}
        </Button>
        <Button
          aria-pressed={zeroOnly}
          variant={zeroOnly ? 'primary' : 'default'}
          onClick={() => {
            setZeroOnly(!zeroOnly);
          }}
        >
          {t('callSheet.filterZero')}
        </Button>
        {canExport ? (
          <Button
            icon={FileSpreadsheet}
            disabled={exporting || sheet === null}
            onClick={exportExcel}
          >
            {t('callSheet.exportExcel')}
          </Button>
        ) : null}
      </div>
      {canSettings && sheet !== null ? (
        <form
          className="toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            saveLimit();
          }}
        >
          <Field
            label={t('callSheet.lowHoursLimit')}
            hint={t('callSheet.lowHoursHint', { hours: String(sheet.lowHoursLimit) })}
            type="number"
            min="0.5"
            max="24"
            step="0.5"
            value={limitText}
            placeholder={String(sheet.lowHoursLimit)}
            onChange={(e) => {
              setLimitText(e.target.value);
            }}
          />
          <Button type="submit" disabled={limitText === '' || Number.isNaN(Number(limitText))}>
            {t('callSheet.saveLimit')}
          </Button>
        </form>
      ) : null}

      {strip.length > 0 ? (
        <ul className="sheet-strip" aria-label={t('callSheet.summary')}>
          {strip.map((x) => (
            <li key={x.key}>
              <span className="sheet-strip-value">{x.value}</span>
              <span className="muted">{x.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {s !== undefined ? (
        <div className="sheet-progress">
          <div
            role="progressbar"
            aria-label={t('callSheet.progress')}
            aria-valuemin={0}
            aria-valuemax={s.totalPeople}
            aria-valuenow={s.called}
            className="sheet-progress-track"
          >
            <div
              className="sheet-progress-fill"
              style={{
                width: `${String(s.totalPeople === 0 ? 0 : Math.round((s.called / s.totalPeople) * 100))}%`,
              }}
            />
          </div>
          <span>
            {t('callSheet.progressText', {
              called: String(s.called),
              total: String(s.totalPeople),
            })}
          </span>
        </div>
      ) : null}
      {sheet !== null ? (
        <p className="muted" data-testid="sheet-showing">
          {t('callSheet.showing', {
            shown: String(sheet.rows.length),
            total: String(sheet.unfiltered.totalPeople),
          })}
          {appliedFilters.length > 0
            ? ` · ${t('callSheet.filtersApplied', { filters: appliedFilters.join(', ') })}`
            : ''}
        </p>
      ) : null}
      {sheet !== null && !sheet.reported ? (
        <p className="muted">{t('callSheet.notReported', { date: sheet.figuresDate })}</p>
      ) : sheet !== null ? (
        <p className="muted">{t('callSheet.figuresOf', { date: sheet.figuresDate })}</p>
      ) : null}

      {sheet === null && error === null ? (
        <Skeleton lines={6} />
      ) : sheet !== null && rows.length === 0 ? (
        <EmptyState title={t('callSheet.none')} />
      ) : sheet !== null ? (
        <div className="table-card">
          <div className="table-wrap">
            <table className="stack">
              <thead>
                <tr>
                  <th>{t('callSheet.person')}</th>
                  <th>{t('callSheet.phone')}</th>
                  <th>{t('callSheet.orders')}</th>
                  <th>{t('callSheet.hours')}</th>
                  <th>{t('callSheet.late')}</th>
                  <th>{t('callSheet.lastCall')}</th>
                  <th>{t('callSheet.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const zero = isZeroOrders(r.yesterday.orders, sheet.reported);
                  const low =
                    !zero && isLowHours(r.yesterday.hours, sheet.reported, sheet.lowHoursLimit);
                  return (
                    <tr
                      key={r.partyId}
                      className={zero ? 'sheet-row-zero' : low ? 'sheet-row-low' : undefined}
                    >
                      <td data-label={t('callSheet.person')}>
                        <strong>{r.name}</strong>
                        <div className="muted">
                          {[r.employeeCode, r.profession, r.zone]
                            .filter((x): x is string => x !== null && x !== '')
                            .join(' · ')}
                        </div>
                        <div className="muted nowrap">
                          {r.platformIds.map((p) => p.value).join(', ') || '—'}
                        </div>
                        <Pill tone={r.statusCode === 'active' ? 'success' : 'neutral'}>
                          {statusLabel(r.statusCode)}
                        </Pill>
                      </td>
                      <td data-label={t('callSheet.phone')}>
                        {r.phone === null ? (
                          '—'
                        ) : (
                          <a
                            className="nowrap"
                            href={telHref(r.phone)}
                            aria-label={t('callSheet.callNumber', { phone: r.phone })}
                          >
                            <Phone aria-hidden size={14} /> {r.phone}
                          </a>
                        )}
                      </td>
                      <td data-label={t('callSheet.orders')}>
                        {r.yesterday.orders ?? '—'}
                        {zero ? <Pill tone="danger">{t('callSheet.markZero')}</Pill> : null}
                      </td>
                      <td data-label={t('callSheet.hours')}>
                        {r.yesterday.hours === null ? '—' : r.yesterday.hours.toFixed(1)}
                        {low ? (
                          <Pill tone="warning">
                            {t('callSheet.markLow', { hours: String(sheet.lowHoursLimit) })}
                          </Pill>
                        ) : null}
                      </td>
                      <td data-label={t('callSheet.late')}>{r.yesterday.lateMinutes ?? '—'}</td>
                      <td data-label={t('callSheet.lastCall')}>
                        {r.lastCall === null ? (
                          <span className="muted">{t('callSheet.neverCalled')}</span>
                        ) : (
                          <>
                            {outcomeLabel(r.lastCall.outcomeId, r.lastCall.outcomeCode)}
                            <div className="muted nowrap">
                              {r.lastCall.at.slice(0, 16).replace('T', ' ')}
                            </div>
                          </>
                        )}
                        {r.calledToday ? (
                          <Pill tone="success">{t('callSheet.calledToday')}</Pill>
                        ) : null}
                      </td>
                      <td data-label={t('callSheet.actions')}>
                        <div className="row-actions">
                          {canCall ? (
                            <Button
                              size="sm"
                              icon={PhoneCall}
                              onClick={() => {
                                setDialog({ kind: 'call', row: r });
                              }}
                            >
                              {t('callSheet.logCall')}
                            </Button>
                          ) : null}
                          {canStatus ? (
                            <Button
                              size="sm"
                              icon={Repeat}
                              onClick={() => {
                                setDialog({ kind: 'status', row: r });
                              }}
                            >
                              {t('callSheet.setStatus')}
                            </Button>
                          ) : null}
                          {canProfile ? (
                            <Link className="btn btn-sm" to={`/employees/${r.employeeId}`}>
                              <UserRound aria-hidden size={14} /> {t('callSheet.openProfile')}
                            </Link>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {dialog?.kind === 'call' ? (
        <CallDialog
          row={dialog.row}
          date={date}
          outcomes={outcomes}
          onClose={() => {
            setDialog(null);
          }}
          onDone={() => {
            done(t('callSheet.callLogged'));
          }}
        />
      ) : null}
      {dialog?.kind === 'status' ? (
        <StatusDialog
          row={dialog.row}
          date={date}
          statuses={statuses}
          reasons={reasons}
          onClose={() => {
            setDialog(null);
          }}
          onDone={() => {
            done(t('callSheet.statusSaved'));
          }}
        />
      ) : null}
    </div>
  );
}

function CallDialog({
  row,
  date,
  outcomes,
  onClose,
  onDone,
}: {
  row: SheetRow;
  date: string;
  outcomes: Choice[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [outcomeId, setOutcomeId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Modal open onClose={onClose} aria-labelledby="call-title">
      <h2 id="call-title">{t('callSheet.callTitle', { name: row.name })}</h2>
      <ErrorAlert error={error} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          api('/tracking/calls', {
            method: 'POST',
            body: {
              partyId: row.partyId,
              businessDate: date,
              outcomeId,
              ...(note.trim() === '' ? {} : { note: note.trim() }),
            },
          })
            .then(onDone)
            .catch((err: unknown) => {
              setError(err);
              setBusy(false);
            });
        }}
      >
        <Select
          label={t('callSheet.outcome')}
          value={outcomeId}
          placeholder={t('common.choose')}
          options={outcomes.map((o) => ({ value: o.id, label: o.label }))}
          onChange={(e) => {
            setOutcomeId(e.target.value);
          }}
        />
        <Textarea
          label={t('callSheet.note')}
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
          }}
        />
        <div className="dialog-actions">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={busy || outcomeId === ''}>
            {t('callSheet.saveCall')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
