/**
 * Menu: a small dropdown (trigger button + floating panel) for row actions, the column
 * chooser and the account menu. Closes on Escape, on a click outside, and after an item is
 * chosen (any click inside the panel unless the item says `keepOpen`). Arrow keys move
 * between items. No positioning library: the panel is absolutely positioned under the trigger
 * and aligned to the end edge (or the start edge with `align="start"`).
 * Depends on: react, ui/components. Used by: ui/DataTable, shell/AppShell.
 */
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { Check } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from './components';
import type { ButtonProps } from './components';

const MenuContext = createContext<{ close: () => void } | null>(null);

interface MenuProps {
  /** The trigger: either a label (text) or a fully custom button through `trigger`. */
  label?: string;
  icon?: LucideIcon;
  /** Icon-only trigger; `label` becomes its aria-label. */
  iconOnly?: boolean;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  align?: 'start' | 'end';
  className?: string;
  panelClassName?: string;
  /** Replaces the default button; gets the props it must spread. */
  trigger?: (props: ButtonHTMLAttributes<HTMLButtonElement>) => ReactNode;
  children: ReactNode;
}

export function Menu({
  label,
  icon,
  iconOnly = false,
  variant = 'default',
  size,
  align = 'end',
  className,
  panelClassName,
  trigger,
  children,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useCallback(() => {
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (root.current !== null && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onPanelKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>(
        '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], button, a, input',
      ),
    ).filter((el) => !el.hasAttribute('disabled'));
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };
  const onPanelClick = (e: MouseEvent<HTMLDivElement>) => {
    // A click on anything that is not marked keep-open chooses and closes.
    const target = e.target as HTMLElement;
    if (target.closest('[data-keep-open]') !== null) return;
    if (target.closest('button, a, [role^="menuitem"]') !== null) setOpen(false);
  };

  const triggerProps: ButtonHTMLAttributes<HTMLButtonElement> = {
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? id : undefined,
    onClick: () => {
      setOpen((o) => !o);
    },
  };

  return (
    <div ref={root} className={className ? `menu ${className}` : 'menu'}>
      {trigger ? (
        trigger(triggerProps)
      ) : (
        <Button
          variant={variant}
          {...(size === undefined ? {} : { size })}
          {...(icon === undefined ? {} : { icon })}
          {...(iconOnly ? { iconOnly: true, 'aria-label': label } : {})}
          {...triggerProps}
        >
          {iconOnly ? null : label}
        </Button>
      )}
      {open ? (
        <div
          id={id}
          role="menu"
          className={['menu-panel', align === 'start' ? 'align-start' : '', panelClassName ?? '']
            .filter((c) => c !== '')
            .join(' ')}
          onKeyDown={onPanelKey}
          onClick={onPanelClick}
        >
          <MenuContext.Provider value={{ close }}>{children}</MenuContext.Provider>
        </div>
      ) : null}
    </div>
  );
}

interface ItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  icon?: LucideIcon;
  danger?: boolean;
  /** Renders as a checkable item showing a tick when true. */
  checked?: boolean;
}

export function MenuItem({ icon: Icon, danger, checked, className, children, ...rest }: ItemProps) {
  const cls = ['menu-item', danger ? 'danger' : '', className ?? '']
    .filter((c) => c !== '')
    .join(' ');
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={checked}
      className={cls}
      {...rest}
    >
      {Icon ? <Icon aria-hidden /> : null}
      <span>{children}</span>
      {checked === undefined ? null : <Check className="menu-check" aria-hidden />}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="menu-sep" role="separator" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="menu-label">{children}</div>;
}

/** Lets custom content inside a menu close it (for example a link's onClick). */
export function useMenuClose(): () => void {
  return useContext(MenuContext)?.close ?? (() => undefined);
}
