/**
 * NotificationBell: unread count in the top bar and a short list of recent notifications.
 * The count is refreshed every 30 seconds and whenever the list is opened. (Socket.IO push
 * to the browser is listed as deferred in PROGRESS.md; polling is the fallback that always
 * works.) The panel closes on Escape and on a click outside.
 * Depends on: api client, i18n. Used by: shell/AppShell.tsx.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, CheckCheck } from 'lucide-react';
import { api } from '../api/client';
import { useI18n } from '../i18n';
import { Button } from '../ui/components';

interface Item {
  id: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}

export const BELL_POLL_MS = 30_000;

export function NotificationBell() {
  const { t } = useI18n();
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const root = useRef<HTMLDivElement>(null);

  const refreshCount = useCallback(() => {
    api<{ unread: number }>('/notifications/unread-count')
      .then((r) => {
        setUnread(r.unread);
      })
      .catch(() => {
        // A failed poll keeps the last number; the next poll tries again.
      });
  }, []);

  useEffect(() => {
    refreshCount();
    const timer = setInterval(refreshCount, BELL_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [refreshCount]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (root.current !== null && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const load = () => {
    api<{ items: Item[] }>('/notifications', { query: { pageSize: 10 } })
      .then((r) => {
        setItems(r.items);
      })
      .catch(() => {
        setItems([]);
      });
    refreshCount();
  };

  const markRead = (id: string) => {
    api(`/notifications/${id}/read`, { method: 'POST' })
      .then(() => {
        setItems((all) => all.map((n) => (n.id === id ? { ...n, read: true } : n)));
        refreshCount();
      })
      .catch(() => undefined);
  };
  const markAll = () => {
    api('/notifications/read-all', { method: 'POST' })
      .then(() => {
        setItems((all) => all.map((n) => ({ ...n, read: true })));
        setUnread(0);
      })
      .catch(() => undefined);
  };

  return (
    <div className="bell" ref={root}>
      <Button
        variant="ghost"
        iconOnly
        icon={Bell}
        aria-label={`${t('bell.label')}${unread > 0 ? ` (${String(unread)})` : ''}`}
        aria-expanded={open}
        onClick={() => {
          if (!open) load();
          setOpen(!open);
        }}
      />
      {unread > 0 ? (
        <span className="badge" aria-hidden>
          {unread > 99 ? '99+' : unread}
        </span>
      ) : null}
      {open ? (
        <div className="bell-panel" role="region" aria-label={t('bell.label')}>
          <div className="bell-head">
            <span>{t('bell.label')}</span>
            <Button
              variant="link"
              size="sm"
              icon={CheckCheck}
              onClick={markAll}
              disabled={unread === 0}
            >
              {t('bell.markAll')}
            </Button>
          </div>
          {items.length === 0 ? (
            <p className="bell-empty muted">{t('bell.empty')}</p>
          ) : (
            <ul>
              {items.map((n) => (
                <li key={n.id} className={n.read ? 'read' : 'unread'}>
                  <button
                    type="button"
                    className="bell-item"
                    onClick={() => {
                      markRead(n.id);
                    }}
                  >
                    <strong>{n.title}</strong>
                    <span>{n.body}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
