/**
 * Shared pieces of the tracking screens (phase 4 row 4.8b): the lookup and status choices and the
 * "Set status" dialog, used by the morning call sheet and the Status differences screen.
 *
 * Rules, and why:
 *   - A status change goes through the employee status machine on the server; its refusal
 *     (for example "cannot be set to ...") is shown unchanged and nothing is saved.
 *   - One entry per person per date: today's entry is changed when it exists, else started.
 *   - A reason is required for the statuses in TRACKING_REASON_REQUIRED (the server repeats it).
 *
 * Depends on: api client, i18n, ui components, @fibrex/shared. Used by: ./CallSheetPage.tsx,
 * ./StatusDifferencesPage.tsx.
 */
import { useEffect, useMemo, useState } from 'react';
import { TRACKING_REASON_REQUIRED } from '@fibrex/shared';
import { api } from '../api/client';
import { useI18n } from '../i18n';
import { Modal } from '../ui/Modal';
import { Button, ErrorAlert, Field, Select, Textarea } from '../ui/components';

export interface Choice {
  id: string;
  code: string;
  label: string;
}
interface LookupItem {
  id: string;
  code: string;
  labels: Record<string, string> | string;
}

/** What the dialog needs to know about the person: who, their status, today's entry. */
export interface StatusTarget {
  partyId: string;
  name: string;
  statusCode: string | null;
  entry: { id: string; version: number } | null;
}

/** The values of a lookup list as dropdown choices in the user's language. */
export function useLookup(key: string, language: string): Choice[] {
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
export function useStatuses(
  language: string,
  fallbackCodes: string[],
): { code: string; label: string }[] {
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

export function StatusDialog({
  row,
  date,
  statuses,
  reasons,
  onClose,
  onDone,
}: {
  row: StatusTarget;
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
