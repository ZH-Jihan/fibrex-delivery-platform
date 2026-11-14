/**
 * CommandPalette: Ctrl+K (or Cmd+K), or the search button in the top bar, opens a box that
 * jumps to any screen the user may open. It reads the same menu list the sidebar uses,
 * already filtered by `can()`, so it can never offer a screen the user cannot see. Party
 * search is listed as deferred in PROGRESS.md.
 * Depends on: i18n, react-router, ui/Modal. Used by: shell/AppShell.tsx.
 */
import { useEffect, useState } from 'react';
import { ArrowRight, Hash, Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/en';
import { Button, SearchInput } from '../ui/components';
import { Modal } from '../ui/Modal';

export interface PaletteEntry {
  to: string;
  label: MessageKey;
  icon?: LucideIcon;
}

export function CommandPalette({
  entries,
  compact = false,
}: {
  entries: readonly PaletteEntry[];
  /** Icon-only trigger (mobile top bar). */
  compact?: boolean;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');

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
    if (!open) setText('');
  }, [open]);

  const needle = text.trim().toLowerCase();
  const matches = entries.filter((e) => needle === '' || t(e.label).toLowerCase().includes(needle));
  const go = (to: string) => {
    setOpen(false);
    void navigate(to);
  };

  return (
    <>
      {compact ? (
        <Button
          variant="ghost"
          iconOnly
          icon={Search}
          aria-label={t('shell.search')}
          onClick={() => {
            setOpen(true);
          }}
        />
      ) : (
        <Button
          icon={Search}
          className="palette-trigger"
          aria-label={t('shell.search')}
          onClick={() => {
            setOpen(true);
          }}
        >
          {t('shell.search')}
          <kbd aria-hidden>Ctrl K</kbd>
        </Button>
      )}
      <Modal
        open={open}
        className="palette"
        aria-label={t('palette.title')}
        onClose={() => {
          setOpen(false);
        }}
      >
        <SearchInput
          autoFocus
          label={t('palette.title')}
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
          <p className="palette-none">{t('palette.none')}</p>
        ) : (
          <ul>
            {matches.map((m) => {
              const Icon = m.icon ?? Hash;
              return (
                <li key={m.to}>
                  <button
                    type="button"
                    className="palette-item"
                    onClick={() => {
                      go(m.to);
                    }}
                  >
                    <Icon aria-hidden />
                    <span>{t(m.label)}</span>
                    <span className="spacer" />
                    <ArrowRight className="flip-rtl" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Modal>
    </>
  );
}
