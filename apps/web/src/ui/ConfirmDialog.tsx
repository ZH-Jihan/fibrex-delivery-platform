/**
 * ConfirmDialog: a modal question built on the native <dialog> element (focus trap, Escape
 * and backdrop come from the browser). Used before deletes and other hard-to-undo actions.
 * Depends on: ui/components, i18n. Used by: screens.
 */
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { Button } from './components';

interface Props {
  open: boolean;
  title?: string;
  children?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: Props) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    // jsdom has no showModal; the guard keeps tests and old browsers working.
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="confirm-title" onClose={onCancel}>
      <h2 id="confirm-title">{title ?? t('confirm.title')}</h2>
      {children}
      <div className="dialog-actions">
        <Button onClick={onCancel}>{t('common.cancel')}</Button>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
          {confirmLabel ?? t('common.confirm')}
        </Button>
      </div>
    </dialog>
  );
}
