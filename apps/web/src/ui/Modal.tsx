/**
 * Modal: the one wrapper around the native <dialog> element. The browser gives us the focus
 * trap, Escape and the inert background for free; this component only keeps the element in
 * step with an `open` prop and offers three shapes through CSS classes:
 *   center  a classic centred dialog (confirmations, command palette)
 *   sheet   a bottom sheet (filters on a phone)
 *   drawer  a full-height panel sliding in from the start edge (the mobile menu)
 * Clicking the backdrop closes it. jsdom has no showModal, so the `open` attribute is the
 * fallback there (tests and very old browsers).
 * Depends on: react. Used by: ConfirmDialog, CommandPalette, DataTable, shell/AppShell.
 */
import { useEffect, useRef } from 'react';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';

export type ModalVariant = 'center' | 'sheet' | 'drawer';

interface Props {
  open: boolean;
  onClose: () => void;
  variant?: ModalVariant;
  className?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  children: ReactNode;
}

export function Modal({ open, onClose, variant = 'center', className, children, ...aria }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    if (!open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [open]);

  // Escape closes even when focus is outside the dialog (jsdom never moves it inside).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  const onBackdrop = (e: MouseEvent<HTMLDialogElement>) => {
    // Only the backdrop is the dialog element itself; content clicks have a child target.
    if (e.target === e.currentTarget) onClose();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>) => {
    // Escape also works where the browser does not fire `cancel` (jsdom).
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const cls = ['dialog', variant === 'center' ? '' : `dialog-${variant}`, className ?? '']
    .filter((c) => c !== '')
    .join(' ');
  return (
    <dialog
      ref={ref}
      className={cls}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={onBackdrop}
      onKeyDown={onKeyDown}
      {...aria}
    >
      {children}
    </dialog>
  );
}
