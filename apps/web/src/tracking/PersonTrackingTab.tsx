/**
 * Tracking tab of the employee profile (phase 4 row 4.8b; SPEC 3.3): one person's dated status
 * changes, call log and operator periods, newest first, each with who did it.
 *
 * Rules, and why:
 *   - Data comes from `GET /tracking/{partyId}/history` (needs tracking.entry.view); the profile
 *     shows the tab only to people who hold it.
 *   - Read-only unless the person may change tracking: "Add period" needs tracking.entry.create,
 *     "Edit" and "End" need tracking.entry.update (the server checks them again).
 *   - An operator period is the person's platform ID worked by someone else between two dates.
 *     Two periods for one ID may not share a day: the server refuses an overlap with its own
 *     message, shown unchanged in the dialog, and nothing is saved.
 *   - "End" sets the end date and keeps everything else; periods are never deleted.
 *
 * Depends on: api client, auth, i18n, ui components, ./status-dialog.tsx (lookup lists).
 * Used by: people/EmployeeProfilePage.tsx.
 */
import { useCallback, useEffect, useState } from 'react';
import { CalendarCheck, Pencil, Plus } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Modal } from '../ui/Modal';
import {
  Button,
  EmptyState,
  ErrorAlert,
  Field,
  Select,
  Skeleton,
  Textarea,
} from '../ui/components';
import { useToast } from '../ui/toast';
import { useLookup } from './status-dialog';

interface Period {
  id: string;
  partyIdentifierId: string;
  operatorName: string | null;
  operatorPhone: string | null;
  operatorPartyId: string | null;
  fromDate: string;
  toDate: string | null;
  note: string | null;
  createdBy: string | null;
  version: number;
}
interface History {
  statusHistory: {
    id: string;
    fromCode: string | null;
    toCode: string;
    effectiveDate: string;
    reasonId: string | null;
    note: string | null;
    actorId: string | null;
    at: string;
  }[];
  calls: {
    id: string;
    at: string;
    outcomeId: string;
    outcomeCode: string | null;
    callerUserId: string | null;
    note: string | null;
  }[];
  operatorPeriods: Period[];
  platformIds: { identifierId: string; type: string; value: string }[];
  users: Record<string, string>;
}

type Dialog =
  { kind: 'add' } | { kind: 'edit'; period: Period } | { kind: 'end'; period: Period } | null;

const todayText = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const when = (iso: string) => iso.slice(0, 16).replace('T', ' ');

export function PersonTrackingTab({ partyId }: { partyId: string }) {
  const { t, language } = useI18n();
  const { can } = useAuth();
  const toast = useToast();
  const canAdd = can('tracking.entry.create');
  const canChange = can('tracking.entry.update');
  const [data, setData] = useState<History | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const reasons = useLookup('status_reason', language);
  const outcomes = useLookup('call_outcome', language);

  const load = useCallback(() => {
    api<History>(`/tracking/${partyId}/history`)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, [partyId]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  const who = (userId: string | null) =>
    userId === null ? t('personTracking.system') : (data?.users[userId] ?? '—');
  const idValue = (identifierId: string) =>
    data?.platformIds.find((p) => p.identifierId === identifierId)?.value ?? '—';

  const status = [...(data?.statusHistory ?? [])].sort(
    (a, b) => b.effectiveDate.localeCompare(a.effectiveDate) || b.at.localeCompare(a.at),
  );
  const calls = [...(data?.calls ?? [])].sort((a, b) => b.at.localeCompare(a.at));
  const periods = [...(data?.operatorPeriods ?? [])].sort((a, b) =>
    b.fromDate.localeCompare(a.fromDate),
  );

  return (
    <div className="stack">
      <ErrorAlert error={error} />
      {data === null && error === null ? <Skeleton lines={4} /> : null}
      {data === null ? null : (
        <>
          <section aria-labelledby="pt-status">
            <h3 id="pt-status">{t('personTracking.statusHistory')}</h3>
            {status.length === 0 ? (
              <EmptyState title={t('personTracking.noStatus')} />
            ) : (
              <div className="table-card">
                <div className="table-wrap">
                  <table className="stack">
                    <thead>
                      <tr>
                        <th>{t('personTracking.effective')}</th>
                        <th>{t('personTracking.change')}</th>
                        <th>{t('personTracking.reason')}</th>
                        <th>{t('personTracking.note')}</th>
                        <th>{t('personTracking.by')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {status.map((h) => (
                        <tr key={h.id}>
                          <td data-label={t('personTracking.effective')}>{h.effectiveDate}</td>
                          <td data-label={t('personTracking.change')}>
                            {(h.fromCode ?? '—') + ' → ' + h.toCode}
                          </td>
                          <td data-label={t('personTracking.reason')}>
                            {reasons.find((r) => r.id === h.reasonId)?.label ?? '—'}
                          </td>
                          <td data-label={t('personTracking.note')}>{h.note ?? '—'}</td>
                          <td data-label={t('personTracking.by')}>
                            {who(h.actorId)}
                            <div className="muted nowrap">{when(h.at)}</div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>

          <section aria-labelledby="pt-calls">
            <h3 id="pt-calls">{t('personTracking.calls')}</h3>
            {calls.length === 0 ? (
              <EmptyState title={t('personTracking.noCalls')} />
            ) : (
              <div className="table-card">
                <div className="table-wrap">
                  <table className="stack">
                    <thead>
                      <tr>
                        <th>{t('personTracking.when')}</th>
                        <th>{t('personTracking.outcome')}</th>
                        <th>{t('personTracking.by')}</th>
                        <th>{t('personTracking.note')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {calls.map((c) => (
                        <tr key={c.id}>
                          <td data-label={t('personTracking.when')}>{when(c.at)}</td>
                          <td data-label={t('personTracking.outcome')}>
                            {outcomes.find((o) => o.id === c.outcomeId)?.label ??
                              c.outcomeCode ??
                              '—'}
                          </td>
                          <td data-label={t('personTracking.by')}>{who(c.callerUserId)}</td>
                          <td data-label={t('personTracking.note')}>{c.note ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>

          <section aria-labelledby="pt-periods">
            <div className="section-head">
              <h3 id="pt-periods">{t('personTracking.periods')}</h3>
              {canAdd && data.platformIds.length > 0 ? (
                <Button
                  size="sm"
                  icon={Plus}
                  onClick={() => {
                    setDialog({ kind: 'add' });
                  }}
                >
                  {t('personTracking.addPeriod')}
                </Button>
              ) : null}
            </div>
            {periods.length === 0 ? (
              <EmptyState title={t('personTracking.noPeriods')} />
            ) : (
              <div className="table-card">
                <div className="table-wrap">
                  <table className="stack">
                    <thead>
                      <tr>
                        <th>{t('personTracking.platformId')}</th>
                        <th>{t('personTracking.operator')}</th>
                        <th>{t('personTracking.from')}</th>
                        <th>{t('personTracking.to')}</th>
                        <th>{t('personTracking.note')}</th>
                        <th>{t('personTracking.by')}</th>
                        {canChange ? <th>{t('callSheet.actions')}</th> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {periods.map((p) => (
                        <tr key={p.id}>
                          <td data-label={t('personTracking.platformId')}>
                            {idValue(p.partyIdentifierId)}
                          </td>
                          <td data-label={t('personTracking.operator')}>
                            {p.operatorName ?? '—'}
                            {p.operatorPhone === null ? null : (
                              <div className="muted nowrap">{p.operatorPhone}</div>
                            )}
                          </td>
                          <td data-label={t('personTracking.from')}>{p.fromDate}</td>
                          <td data-label={t('personTracking.to')}>
                            {p.toDate ?? t('personTracking.ongoing')}
                          </td>
                          <td data-label={t('personTracking.note')}>{p.note ?? '—'}</td>
                          <td data-label={t('personTracking.by')}>{who(p.createdBy)}</td>
                          {canChange ? (
                            <td data-label={t('callSheet.actions')}>
                              <div className="row-actions">
                                <Button
                                  size="sm"
                                  icon={Pencil}
                                  onClick={() => {
                                    setDialog({ kind: 'edit', period: p });
                                  }}
                                >
                                  {t('personTracking.edit')}
                                </Button>
                                {p.toDate === null ? (
                                  <Button
                                    size="sm"
                                    icon={CalendarCheck}
                                    onClick={() => {
                                      setDialog({ kind: 'end', period: p });
                                    }}
                                  >
                                    {t('personTracking.end')}
                                  </Button>
                                ) : null}
                              </div>
                            </td>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        </>
      )}

      {dialog !== null && data !== null ? (
        <PeriodDialog
          dialog={dialog}
          platformIds={data.platformIds}
          onClose={() => {
            setDialog(null);
          }}
          onDone={() => {
            setDialog(null);
            toast.show(t('personTracking.saved'), 'success');
            load();
          }}
        />
      ) : null}
    </div>
  );
}

/** Add, edit or end one operator period; the server's refusal (overlap) is shown as it is. */
function PeriodDialog({
  dialog,
  platformIds,
  onClose,
  onDone,
}: {
  dialog: NonNullable<Dialog>;
  platformIds: History['platformIds'];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const period = dialog.kind === 'add' ? null : dialog.period;
  const ending = dialog.kind === 'end';
  const [identifierId, setIdentifierId] = useState(
    period?.partyIdentifierId ?? platformIds[0]?.identifierId ?? '',
  );
  const [name, setName] = useState(period?.operatorName ?? '');
  const [phone, setPhone] = useState(period?.operatorPhone ?? '');
  const [from, setFrom] = useState(period?.fromDate ?? todayText());
  const [to, setTo] = useState(ending ? todayText() : (period?.toDate ?? ''));
  const [note, setNote] = useState(period?.note ?? '');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const namedByPerson = period?.operatorPartyId != null;
  const toBeforeFrom = to !== '' && to < from;
  const valid =
    identifierId !== '' &&
    from !== '' &&
    (namedByPerson || name.trim() !== '') &&
    !toBeforeFrom &&
    (!ending || to !== '');

  const submit = () => {
    setBusy(true);
    setError(null);
    const text = (value: string) => (value.trim() === '' ? null : value.trim());
    const request =
      period === null
        ? api('/tracking/operator-periods', {
            method: 'POST',
            body: {
              partyIdentifierId: identifierId,
              fromDate: from,
              operatorName: text(name),
              operatorPhone: text(phone),
              toDate: to === '' ? null : to,
              note: text(note),
            },
          })
        : api(`/tracking/operator-periods/${period.id}`, {
            method: 'PATCH',
            body: ending
              ? { version: period.version, toDate: to }
              : {
                  version: period.version,
                  fromDate: from,
                  toDate: to === '' ? null : to,
                  operatorName: text(name),
                  operatorPhone: text(phone),
                  note: text(note),
                },
          });
    request.then(onDone).catch((e: unknown) => {
      setError(e);
      setBusy(false);
    });
  };

  const title =
    dialog.kind === 'add'
      ? t('personTracking.addPeriod')
      : ending
        ? t('personTracking.endTitle')
        : t('personTracking.editTitle');
  return (
    <Modal open onClose={onClose} aria-labelledby="period-title">
      <h2 id="period-title">{title}</h2>
      <ErrorAlert error={error} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Select
          label={t('personTracking.platformId')}
          value={identifierId}
          disabled={period !== null}
          options={platformIds.map((p) => ({ value: p.identifierId, label: p.value }))}
          onChange={(e) => {
            setIdentifierId(e.target.value);
          }}
        />
        {ending ? null : (
          <>
            <Field
              label={t('personTracking.operatorName')}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
            <Field
              label={t('personTracking.operatorPhone')}
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
              }}
            />
            <Field
              label={t('personTracking.from')}
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
              }}
            />
          </>
        )}
        <Field
          label={ending ? t('personTracking.endDate') : t('personTracking.toOptional')}
          type="date"
          value={to}
          error={toBeforeFrom ? t('personTracking.toBeforeFrom') : undefined}
          onChange={(e) => {
            setTo(e.target.value);
          }}
        />
        {ending ? null : (
          <Textarea
            label={t('personTracking.note')}
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
            }}
          />
        )}
        <div className="dialog-actions">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={busy || !valid}>
            {t('personTracking.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
