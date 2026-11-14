/**
 * Basic design-system components: Button, Field, Select, Textarea, Checkbox, SearchInput,
 * PageHeader, Pill, Skeleton, EmptyState, ErrorAlert.
 * Purpose: one look and one accessibility behaviour (labels tied to inputs, errors announced,
 * focus rings and 44 px touch targets from styles.css). Every icon comes from lucide-react
 * and is `aria-hidden`, so a button's accessible name is always its text or aria-label.
 * Depends on: react, lucide-react, i18n. Used by: all screens.
 */
import { useId } from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { CircleAlert, Inbox, Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ApiError } from '../api/client';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/en';
import { en } from '../i18n/en';

/* ---------- Button ---------- */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger' | 'ghost' | 'link';
  size?: 'default' | 'sm';
  /** Icon shown before the text. */
  icon?: LucideIcon;
  /** Square button with only the icon; give it an aria-label. */
  iconOnly?: boolean;
  /** Link variant in the danger colour (row "Delete" links). */
  dangerText?: boolean;
  block?: boolean;
}

export function Button({
  variant = 'default',
  size = 'default',
  icon: Icon,
  iconOnly = false,
  dangerText = false,
  block = false,
  className,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  const cls = [
    'btn',
    variant === 'default' ? '' : `btn-${variant}`,
    size === 'sm' ? 'btn-sm' : '',
    iconOnly ? 'btn-icon' : '',
    dangerText ? 'btn-danger-text' : '',
    block ? 'btn-block' : '',
    className ?? '',
  ]
    .filter((c) => c !== '')
    .join(' ');
  return (
    <button type={type} className={cls} {...rest}>
      {Icon ? <Icon aria-hidden /> : null}
      {iconOnly ? null : children}
    </button>
  );
}

/* ---------- Form controls ---------- */
interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string | undefined;
  hint?: string;
}

/** Describes an input by its hint and error, so screen readers read them with the label. */
function useDescribedBy(id: string, error: string | undefined, hint: string | undefined) {
  const ids = [error ? `${id}-err` : null, hint ? `${id}-hint` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

function FieldFooter({ id, error, hint }: { id: string; error?: string; hint?: string }) {
  return (
    <>
      {hint ? (
        <span id={`${id}-hint`} className="hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${id}-err`} className="field-error" role="alert">
          <CircleAlert size={14} aria-hidden />
          {error}
        </span>
      ) : null}
    </>
  );
}

export function Field({ label, error, hint, ...input }: FieldProps) {
  const id = useId();
  const describedBy = useDescribedBy(id, error, hint);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...input}
      />
      <FieldFooter
        id={id}
        {...(error === undefined ? {} : { error })}
        {...(hint === undefined ? {} : { hint })}
      />
    </div>
  );
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  error?: string | undefined;
  hint?: string;
  options: readonly { value: string; label: string }[];
  /** Text of the empty first option; omit for no empty option. */
  placeholder?: string;
}

export function Select({ label, error, hint, options, placeholder, ...select }: SelectProps) {
  const id = useId();
  const describedBy = useDescribedBy(id, error, hint);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...select}
      >
        {placeholder === undefined ? null : <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <FieldFooter
        id={id}
        {...(error === undefined ? {} : { error })}
        {...(hint === undefined ? {} : { hint })}
      />
    </div>
  );
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  error?: string | undefined;
  hint?: string;
}

export function Textarea({ label, error, hint, ...area }: TextareaProps) {
  const id = useId();
  const describedBy = useDescribedBy(id, error, hint);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...area}
      />
      <FieldFooter
        id={id}
        {...(error === undefined ? {} : { error })}
        {...(hint === undefined ? {} : { hint })}
      />
    </div>
  );
}

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  type?: 'checkbox' | 'radio';
}

/** A tick box or radio button with its label as one 44 px row. */
export function Checkbox({ label, type = 'checkbox', className, ...input }: CheckboxProps) {
  return (
    <label className={className ? `check ${className}` : 'check'}>
      <input type={type} {...input} />
      <span>{label}</span>
    </label>
  );
}

interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string;
}

/** A search box with a magnifier icon; the label is for assistive technology and placeholder. */
export function SearchInput({ label, className, ...input }: SearchInputProps) {
  return (
    <div className={className ? `search ${className}` : 'search'}>
      <Search aria-hidden />
      <input type="search" aria-label={label} placeholder={label} {...input} />
    </div>
  );
}

/* ---------- Page header ---------- */
interface PageHeaderProps {
  title: string;
  icon?: LucideIcon;
  description?: string;
  /** Buttons on the end side. */
  actions?: ReactNode;
}

export function PageHeader({ title, icon: Icon, description, actions }: PageHeaderProps) {
  return (
    <div className="page-head">
      <div className="page-head-text">
        <h1>
          {Icon ? <Icon aria-hidden /> : null}
          {title}
        </h1>
        {description ? <p className="page-desc">{description}</p> : null}
      </div>
      {actions ? <div className="page-head-actions">{actions}</div> : null}
    </div>
  );
}

/* ---------- Status pill ---------- */
export type PillTone = 'neutral' | 'success' | 'danger' | 'warning' | 'info' | 'accent';

export function Pill({
  tone = 'neutral',
  icon: Icon,
  children,
}: {
  tone?: PillTone;
  icon?: LucideIcon;
  children: ReactNode;
}) {
  return (
    <span className={tone === 'neutral' ? 'pill' : `pill pill-${tone}`}>
      {Icon ? <Icon aria-hidden /> : null}
      {children}
    </span>
  );
}

/* ---------- Loading, empty, error ---------- */
/** Grey shimmer lines shown while data loads. */
export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton-lines" aria-busy="true" aria-live="polite">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" style={{ inlineSize: `${String(92 - (i % 4) * 14)}%` }} />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  icon: Icon = Inbox,
  children,
}: {
  title?: string;
  icon?: LucideIcon;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon aria-hidden />
      </div>
      <p className="empty-title">{title ?? t('common.empty')}</p>
      {children}
    </div>
  );
}

/** The translated text for a failed call: by problem code, else a generic message. */
export function errorText(err: unknown, t: (key: MessageKey) => string): string {
  if (err instanceof ApiError) {
    const key = `error.${err.code}`;
    if (key in en) return t(key as MessageKey);
    // The server's own detail is plain English; show it rather than hide the reason.
    if (err.status < 500 && err.message !== '') return err.message;
    return t('error.unknown');
  }
  if (err instanceof TypeError) return t('error.network');
  return t('error.unknown');
}

export function ErrorAlert({ error }: { error: unknown }) {
  const { t } = useI18n();
  if (error === null || error === undefined) return null;
  return (
    <div className="alert" role="alert">
      <CircleAlert aria-hidden />
      <span>{errorText(error, t)}</span>
    </div>
  );
}
