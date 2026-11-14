/**
 * CommandPalette: Ctrl+K (or Cmd+K) opens a search box that jumps to any screen the user
 * may open. It reads the same menu list the sidebar uses, already filtered by `can()`, so
 * it can never offer a screen the user cannot see. Party search is added with the people
 * screens in commit 12b.
 * Depends on: i18n, react-router. Used by: shell/AppShell.tsx.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/en';

export interface PaletteEntry {
  to: string;
  label: MessageKey;
}

export function CommandPalette({ entries }: { entries: readonly PaletteEntry[] }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  useEffect(() => {
    const d = dialog.current;
    if (d === null) return;
    if (open && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    }
    if (!open && d.open) {
      if (typeof d.close === 'function') d.close();
      else d.removeAttribute('open');
    }
    if (!open) setText('');
  }, [open]);

  const needle = text.trim().toLowerCase();
  const matches = entries.filter((e) => needle === '' || t(e.label).toLowerCase().includes(needle));
  const go = (to: string) => {
    setOpen(false);
    void navigate(to);
  };

  return (
    <dialog
      ref={dialog}
      className="dialog palette"
      aria-label={t('palette.title')}
      onClose={() => {
        setOpen(false);
      }}
    >
      <input
        autoFocus
        aria-label={t('palette.title')}
        placeholder={t('palette.hint')}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && matches[0] !== undefined) go(matches[0].to);
        }}
      />
      {matches.length === 0 ? (
        <p>{t('palette.none')}</p>
      ) : (
        <ul>
          {matches.map((m) => (
            <li key={m.to}>
              <button
                type="button"
                className="th-sort"
                onClick={() => {
                  go(m.to);
                }}
              >
                {t(m.label)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </dialog>
  );
}
