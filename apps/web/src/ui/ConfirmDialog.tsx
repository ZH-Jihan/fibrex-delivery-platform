/**
 * ConfirmDialog: a modal question built on the native <dialog> element through Modal (focus
 * trap, Escape and backdrop come from the browser). Used before deletes and other
 * hard-to-undo actions; `danger` turns the confirm button red with a warning icon.
 * Depends on: ui/components, ui/Modal, i18n. Used by: screens.
 */
import type { ReactNode } from 'react';
import { Check, TriangleAlert, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { Button } from './components';
import { Modal } from './Modal';

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
  return (
    <Modal open={open} onClose={onCancel} aria-labelledby="confirm-title">
      <h2 id="confirm-title">{title ?? t('confirm.title')}</h2>
      {children}
      <div className="dialog-actions">
        <Button icon={X} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button
          variant={danger ? 'danger' : 'primary'}
          icon={danger ? TriangleAlert : Check}
          onClick={onConfirm}
        >
          {confirmLabel ?? t('common.confirm')}
        </Button>
      </div>
    </Modal>
  );
}
