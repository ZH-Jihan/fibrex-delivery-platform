/**
 * Toasts: short messages that disappear by themselves (5 s), each with an icon for its kind.
 * A polite live region lets screen readers announce them. Depends on: react, lucide-react.
 * Used by: screens through useToast().
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CircleCheck, CircleX, Info } from 'lucide-react';

type Kind = 'info' | 'success' | 'error';
interface Toast {
  id: number;
  kind: Kind;
  text: string;
}
interface ToastApi {
  show: (text: string, kind?: Kind) => void;
}
const Context = createContext<ToastApi | null>(null);
const ICONS = { info: Info, success: CircleCheck, error: CircleX } as const;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const show = useCallback((text: string, kind: Kind = 'info') => {
    const id = nextId.current++;
    setToasts((list) => [...list, { id, kind, text }]);
    setTimeout(() => {
      setToasts((list) => list.filter((x) => x.id !== id));
    }, 5000);
  }, []);

  const value = useMemo(() => ({ show }), [show]);
  return (
    <Context.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((x) => {
          const Icon = ICONS[x.kind];
          return (
            <div key={x.id} className={`toast ${x.kind}`}>
              <Icon aria-hidden />
              <span>{x.text}</span>
            </div>
          );
        })}
      </div>
    </Context.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(Context);
  if (ctx === null) throw new Error('useToast needs a ToastProvider');
  return ctx;
}
