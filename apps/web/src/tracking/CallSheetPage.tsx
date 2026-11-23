/**
 * Morning call sheet (phase 4 row 4.8a; SPEC 3.3): one row per rider or driver with yesterday's
 * orders and active hours from the platform sheet, the day's call and status, and quick actions.
 *
 * Rules, and why:
 *   - Everything comes from `GET /tracking?date=` (rows and summary strip). Search and the
 *     filters (not yet called, zero orders, status) work on the loaded rows, so they answer at
 *     once; changing the date asks the server again.
 *   - Zero orders is marked when the sheet reported the day (`reported`): a day nobody has
 *     figures for is a reset, never a zero (4.6a rule), so nothing is marked then.
 *   - "Low hours" is below LOW_HOURS (./sheet-rules.ts). Marks use a pill with text as well as the
 *     row tint, so colour alone never carries the meaning.
 *   - A call is insert-only (`POST /tracking/calls`). A status change goes through the employee
 *     status machine on the server; its refusal ("cannot be set to ...") is shown unchanged in
 *     the dialog, and nothing is saved.
 *   - Buttons show only to people who hold the permission: tracking.call.create (call),
 *     tracking.entry.create or .update plus tracking.status.apply (status), and
 *     people.employee.read for the profile link.
 *
 * Depends on: api client, auth, i18n, ui components, @fibrex/shared (reason rule), toast.
 * Used by: App.tsx (route /tracking), performance/manifest.ts (menu).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardList, Phone, PhoneCall, Repeat, UserRound } from 'lucide-react';
import { TRACKING_REASON_REQUIRED, type CrossCheckKind } from '@fibrex/shared';
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
import { LOW_HOURS, isLowHours, isZeroOrders } from './sheet-rules';

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
}
interface Choice {
  id: string;
  code: string;
  label: string;
}
interface LookupItem {
  id: string;
  code: string;
  labels: Record<string, string> | string;
}

const todayText = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** Digits and a leading plus only, so the `tel:` link works whatever the sheet wrote. */
const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`;

/** The values of a lookup list as dropdown choices in the user's language. */
function useLookup(key: string, language: string): Choice[] {
  const [items, setItems] = useState<LookupItem[]>([]);
  useEffect(() => {
    api<{ items: LookupItem[] }>(`/lookups/${key}`)
      .then((r) => {
        setItems(r.items);
      })
      .catch(() => {
        setItems([]);
      });
  }, [key]);
  return useMemo(
    () =>
      items.map((l) => ({
        id: l.id,
        code: l.code,
        label:
          typeof l.labels === 'string' ? l.labels : (l.labels[language] ?? l.labels.en ?? l.code),
      })),
    [items, language],
  );
}

/** The employee statuses (the state machine's states) as codes with labels. */
function useStatuses(language: string, fallbackCodes: string[]): { code: string; label: string }[] {
  const [states, setStates] = useState<
    { code: string; labels: Record<string, string>; sortOrder: number }[] | null
  >(null);
  useEffect(() => {
    api<{ items: { id: string }[] }>('/state-machines', {
      query: { entityKey: 'people.employee', page: 1, pageSize: 5 },
    })
      .then((m) => {
        const id = m.items[0]?.id;
        if (id === undefined) throw new Error('no machine');
        return api<{
          items: { code: string; labels: Record<string, string>; sortOrder: number }[];
        }>('/states', { query: { stateMachineId: id, page: 1, pageSize: 100 } });
      })
      .then((r) => {
        setStates(r.items);
      })
      .catch(() => {
        // Without permission to read states, the codes already on the sheet are offered.
        setStates(null);
      });
  }, []);
  return useMemo(() => {
    if (states !== null) {
      return [...states]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((s) => ({ code: s.code, label: s.labels[language] ?? s.labels.en ?? s.code }));
    }
    return fallbackCodes.map((code) => ({ code, label: code }));
  }, [states, language, fallbackCodes]);
}

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

  const outcomes = useLookup('call_outcome', language);
  const reasons = useLookup('status_reason', language);
  const statusCodes = useMemo(
    () => Object.keys(sheet?.summary.byStatus ?? {}).sort(),
    [sheet?.summary.byStatus],
  );
  const statuses = useStatuses(language, statusCodes);
  const statusLabel = (code: string | null) =>
    code === null ? '—' : (statuses.find((s) => s.code === code)?.label ?? code);

  const load = useCallback(() => {
    api<Sheet>('/tracking', { query: { date } })
      .then((r) => {
        setSheet(r);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, [date]);
  useEffect(() => {
    setSheet(null);
    load();
  }, [load]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (sheet?.rows ?? []).filter((r) => {
      if (notCalledOnly && r.calledToday) return false;
      if (zeroOnly && !isZeroOrders(r.yesterday.orders, sheet?.reported ?? false)) return false;
      if (status !== '' && r.statusCode !== status) return false;
      if (q === '') return true;
      return [r.name, r.employeeCode, r.phone ?? '', ...r.platformIds.map((p) => p.value)]
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [sheet, search, notCalledOnly, zeroOnly, status]);

  const outcomeLabel = (outcomeId: string, code: string | null) =>
    outcomes.find((o) => o.id === outcomeId)?.label ?? code ?? '—';

  const done = (message: string) => {
    setDialog(null);
    toast.show(message, 'success');
    load();
  };

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
      </div>

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
                  const low = !zero && isLowHours(r.yesterday.hours, sheet.reported);
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
                            {t('callSheet.markLow', { hours: String(LOW_HOURS) })}
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

function StatusDialog({
  row,
  date,
  statuses,
  reasons,
  onClose,
  onDone,
}: {
  row: SheetRow;
  date: string;
  statuses: { code: string; label: string }[];
  reasons: Choice[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [statusCode, setStatusCode] = useState('');
  const [reasonId, setReasonId] = useState('');
  const [effective, setEffective] = useState(date);
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const needsReason = TRACKING_REASON_REQUIRED.includes(statusCode);

  const submit = () => {
    setBusy(true);
    setError(null);
    const fields = {
      statusCode,
      ...(reasonId === '' ? {} : { reasonId }),
      effectiveDate: effective,
      ...(note.trim() === '' ? {} : { note: note.trim() }),
    };
    // One entry per person per date: change today's entry when it exists, else start it.
    const request =
      row.entry === null
        ? api('/tracking/entries', {
            method: 'POST',
            body: { partyId: row.partyId, businessDate: date, ...fields },
          })
        : api(`/tracking/entries/${row.entry.id}`, {
            method: 'PATCH',
            body: { version: row.entry.version, ...fields },
          });
    request.then(onDone).catch((err: unknown) => {
      // The server's refusal (for example "cannot be set to ...") is shown as it is.
      setError(err);
      setBusy(false);
    });
  };

  return (
    <Modal open onClose={onClose} aria-labelledby="status-title">
      <h2 id="status-title">{t('callSheet.statusTitle', { name: row.name })}</h2>
      <p className="muted">
        {t('callSheet.statusNow', {
          status: statuses.find((s) => s.code === row.statusCode)?.label ?? row.statusCode ?? '—',
        })}
      </p>
      <ErrorAlert error={error} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Select
          label={t('callSheet.newStatus')}
          value={statusCode}
          placeholder={t('common.choose')}
          options={statuses.map((x) => ({ value: x.code, label: x.label }))}
          onChange={(e) => {
            setStatusCode(e.target.value);
          }}
        />
        <Select
          label={needsReason ? t('callSheet.reasonRequired') : t('callSheet.reason')}
          value={reasonId}
          placeholder={t('common.choose')}
          options={reasons.map((x) => ({ value: x.id, label: x.label }))}
          onChange={(e) => {
            setReasonId(e.target.value);
          }}
        />
        <Field
          label={t('callSheet.effective')}
          type="date"
          value={effective}
          onChange={(e) => {
            setEffective(e.target.value);
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
          <Button
            type="submit"
            variant="primary"
            disabled={
              busy || statusCode === '' || effective === '' || (needsReason && reasonId === '')
            }
          >
            {t('callSheet.saveStatus')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
