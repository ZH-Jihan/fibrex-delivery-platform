/**
 * Status differences (phase 4 row 4.8b; SPEC 3.3 "Cross-check"): the people whose status on the
 * platform sheet or whose figures do not match our employee status, with one-tap "Set status"
 * and "Open profile".
 *
 * Rules, and why:
 *   - The list is `GET /tracking/cross-check?date=` (needs tracking.entry.view). The server
 *     decides what differs; the screen only shows the findings, each with a text label.
 *   - A day the platform has no figures for is a reset, not a difference: the server returns no
 *     "no orders" findings then, and the screen says the figures are missing.
 *   - "Set status" is the same dialog as on the call sheet (status machine, reason rule, the
 *     server's refusal shown as it is); it shows only to people who may apply a status.
 *
 * Depends on: api client, auth, i18n, ui components, ./status-dialog.tsx, toast.
 * Used by: App.tsx (route /performance/status-differences), performance/manifest.ts (menu).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { GitCompareArrows, Repeat, UserRound } from 'lucide-react';
import type { CrossCheckKind } from '@fibrex/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import {
  Button,
  EmptyState,
  ErrorAlert,
  Field,
  PageHeader,
  Pill,
  Skeleton,
} from '../ui/components';
import { useToast } from '../ui/toast';
import { StatusDialog, useLookup, useStatuses, type StatusTarget } from './status-dialog';

interface Item {
  partyId: string;
  employeeId: string;
  employeeCode: string;
  name: string;
  platformIds: string[];
  entry: { id: string; version: number } | null;
  ourStatus: string | null;
  sheetStatus: { text: string; code: string | null } | null;
  orders: number | null;
  kinds: CrossCheckKind[];
}
interface CrossCheck {
  date: string;
  figuresDate: string;
  reported: boolean;
  items: Item[];
}

const todayText = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function StatusDifferencesPage() {
  const { t, language } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const canStatus =
    auth.can('tracking.status.apply') &&
    (auth.can('tracking.entry.create') || auth.can('tracking.entry.update'));
  const canProfile = auth.can('people.employee.read');

  const [date, setDate] = useState(todayText);
  const [data, setData] = useState<CrossCheck | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [target, setTarget] = useState<Item | null>(null);
  const reasons = useLookup('status_reason', language);
  const statuses = useStatuses(language, ['active', 'inactive', 'blocked', 'terminated']);
  const statusLabel = (code: string | null) =>
    code === null ? '—' : (statuses.find((s) => s.code === code)?.label ?? code);

  const load = useCallback(() => {
    api<CrossCheck>('/tracking/cross-check', { query: { date } })
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, [date]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  const asTarget = (item: Item): StatusTarget => ({
    partyId: item.partyId,
    name: item.name,
    statusCode: item.ourStatus,
    entry: item.entry,
  });

  return (
    <div>
      <PageHeader
        title={t('statusDiff.title')}
        icon={GitCompareArrows}
        description={t('statusDiff.intro')}
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
      </div>
      {data !== null && !data.reported ? (
        <p className="muted">{t('callSheet.notReported', { date: data.figuresDate })}</p>
      ) : null}
      {data === null && error === null ? (
        <Skeleton lines={5} />
      ) : data !== null && data.items.length === 0 ? (
        <EmptyState title={t('statusDiff.none')} />
      ) : data !== null ? (
        <div className="table-card">
          <div className="table-wrap">
            <table className="stack">
              <thead>
                <tr>
                  <th>{t('callSheet.person')}</th>
                  <th>{t('statusDiff.ours')}</th>
                  <th>{t('statusDiff.sheet')}</th>
                  <th>{t('callSheet.orders')}</th>
                  <th>{t('statusDiff.finding')}</th>
                  <th>{t('callSheet.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.partyId}>
                    <td data-label={t('callSheet.person')}>
                      <strong>{item.name}</strong>
                      <div className="muted">{item.employeeCode}</div>
                      <div className="muted nowrap">{item.platformIds.join(', ') || '—'}</div>
                    </td>
                    <td data-label={t('statusDiff.ours')}>{statusLabel(item.ourStatus)}</td>
                    <td data-label={t('statusDiff.sheet')}>{item.sheetStatus?.text ?? '—'}</td>
                    <td data-label={t('callSheet.orders')}>{item.orders ?? '—'}</td>
                    <td data-label={t('statusDiff.finding')}>
                      {item.kinds.map((k) => (
                        <Pill key={k} tone="warning">
                          {t(`statusDiff.kind.${k}` as const)}
                        </Pill>
                      ))}
                    </td>
                    <td data-label={t('callSheet.actions')}>
                      <div className="row-actions">
                        {canStatus ? (
                          <Button
                            size="sm"
                            icon={Repeat}
                            onClick={() => {
                              setTarget(item);
                            }}
                          >
                            {t('callSheet.setStatus')}
                          </Button>
                        ) : null}
                        {canProfile ? (
                          <Link className="btn btn-sm" to={`/employees/${item.employeeId}`}>
                            <UserRound aria-hidden size={14} /> {t('callSheet.openProfile')}
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
      ) : null}

      {target !== null ? (
        <StatusDialog
          row={asTarget(target)}
          date={date}
          statuses={statuses}
          reasons={reasons}
          onClose={() => {
            setTarget(null);
          }}
          onDone={() => {
            setTarget(null);
            toast.show(t('callSheet.statusSaved'), 'success');
            load();
          }}
        />
      ) : null}
    </div>
  );
}
