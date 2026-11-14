/**
 * Basic design-system components: Button, Field, Skeleton, EmptyState, ErrorAlert.
 * Purpose: one look and one accessibility behaviour (labels tied to inputs, errors announced,
 * focus rings from styles.css). Depends on: react, i18n. Used by: all screens.
 */
import { useId } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { ApiError } from '../api/client';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/en';
import { en } from '../i18n/en';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger' | 'link';
}

export function Button({ variant = 'default', className, type = 'button', ...rest }: ButtonProps) {
  const cls = variant === 'default' ? 'btn' : `btn btn-${variant}`;
  return <button type={type} className={className ? `${cls} ${className}` : cls} {...rest} />;
}

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string | undefined;
  hint?: string;
}

export function Field({ label, error, hint, ...input }: FieldProps) {
  const id = useId();
  const describedBy = [error ? `${id}-err` : null, hint ? `${id}-hint` : null].filter(Boolean);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy.length > 0 ? describedBy.join(' ') : undefined}
        {...input}
      />
      {hint ? (
        <span id={`${id}-hint`} className="hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${id}-err`} className="field-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** Grey shimmer lines shown while data loads. */
export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div aria-busy="true" aria-live="polite">
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className="skeleton"
          style={{ marginBlockEnd: 8, inlineSize: `${90 - i * 12}%` }}
        />
      ))}
    </div>
  );
}

export function EmptyState({ title, children }: { title?: string; children?: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="empty">
      <p>{title ?? t('common.empty')}</p>
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
      {errorText(error, t)}
    </div>
  );
}
