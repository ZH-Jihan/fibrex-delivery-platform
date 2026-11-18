/**
 * Small pieces shared by the cash, bank, statement and reconciliation screens (phase 2 row
 * 2.17b): a list hook, a form dialog, a delete-with-reason dialog and the If-Match header.
 *
 * Depends on: api client, i18n, ui components. Used by: ledger/BankPage.tsx,
 * StatementsPage.tsx, ReconciliationPage.tsx, MatchRulesPage.tsx.
 */
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { api } from '../api/client';
import { useI18n } from '../i18n';
import { Button, Field } from '../ui/components';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Modal } from '../ui/Modal';

export const ifMatch = (version: number) => ({ 'If-Match': `"${String(version)}"` });

export interface ApiList<T> {
  rows: T[];
  total: number;
  loading: boolean;
  error: unknown;
  setError: (error: unknown) => void;
  reload: () => void;
}

/** Loads `{ items, total }` from a list endpoint and reloads on demand. */
export function useApiList<T>(
  path: string,
  query: Record<string, string | number | undefined> = {},
): ApiList<T> {
  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const key = JSON.stringify(query);
  const load = useCallback(() => {
    setLoading(true);
    api<{ items: T[]; total: number }>(path, { query: JSON.parse(key) as Record<string, string> })
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
  }, [path, key]);
  useEffect(load, [load]);
  return { rows, total, loading, error, setError, reload: load };
}

interface ModalFormProps {
  open: boolean;
  title: string;
  submitLabel: string;
  onClose: () => void;
  onSubmit: () => void;
  children: ReactNode;
}

/** A dialog holding one form; Enter submits, Escape or the backdrop closes. */
export function ModalForm({
  open,
  title,
  submitLabel,
  onClose,
  onSubmit,
  children,
}: ModalFormProps) {
  const { t } = useI18n();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  return (
    <Modal open={open} onClose={onClose} aria-label={title}>
      <form onSubmit={submit} className="card">
        <h2>{title}</h2>
        {children}
        <div className="form-actions">
          <Button type="button" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary">
            {submitLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

interface ReasonDialogProps {
  open: boolean;
  title: string;
  hint?: string;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}

/** Asks for the reason the server requires before anything is deleted or unmatched. */
export function ReasonDialog({ open, title, hint, onCancel, onConfirm }: ReasonDialogProps) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  return (
    <ConfirmDialog
      open={open}
      danger
      title={title}
      confirmLabel={title}
      onCancel={() => {
        setReason('');
        onCancel();
      }}
      onConfirm={() => {
        if (reason.trim() === '') return;
        const given = reason.trim();
        setReason('');
        onConfirm(given);
      }}
    >
      {hint === undefined ? null : <p>{hint}</p>}
      <Field
        label={t('gl.reason')}
        value={reason}
        onChange={(e) => {
          setReason(e.target.value);
        }}
      />
    </ConfirmDialog>
  );
}
