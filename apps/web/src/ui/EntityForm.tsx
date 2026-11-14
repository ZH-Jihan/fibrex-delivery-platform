/**
 * EntityForm: a form described by a list of fields and checked with a Zod schema from
 * `packages/shared` (or any object with `safeParse`). The same schema the API uses gives
 * the same messages, so the screen and the server never disagree about what is valid.
 * Behaviour: validate on submit, show each error beside its field, send only on success,
 * show the server's refusal (including a 409 version conflict) above the buttons.
 * Why not React Hook Form: these forms are small and flat; one controlled state object
 * keeps the dependency list short. Swap it in if a form ever needs nested arrays.
 * Depends on: ui/components, i18n. Used by: admin and later module screens.
 */
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useI18n } from '../i18n';
import { Button, ErrorAlert, Field } from './components';

export interface FormField {
  name: string;
  label: string;
  type?: 'text' | 'email' | 'tel' | 'password' | 'checkbox' | 'textarea' | 'select';
  options?: readonly { value: string; label: string }[];
  hint?: string;
  readOnly?: boolean;
}

/** The part of a Zod schema this form needs. */
export interface FormSchema {
  safeParse: (
    value: unknown,
  ) =>
    | { success: true; data: unknown }
    | {
        success: false;
        error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] };
      };
}

interface Props {
  fields: readonly FormField[];
  schema: FormSchema;
  initial?: Record<string, unknown>;
  submitLabel?: string;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
  onCancel?: () => void;
}

export function EntityForm({
  fields,
  schema,
  initial = {},
  submitLabel,
  onSubmit,
  onCancel,
}: Props) {
  const { t } = useI18n();
  const id = useId();
  const [values, setValues] = useState<Record<string, unknown>>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const set = (name: string, value: unknown) => {
    setValues((v) => ({ ...v, [name]: value }));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFailure(null);
    // Empty text boxes mean "not given": drop them so optional fields stay optional.
    const cleaned: Record<string, unknown> = {};
    for (const f of fields) {
      const v = values[f.name];
      if (v === '' || v === undefined) continue;
      cleaned[f.name] = v;
    }
    const result = schema.safeParse(cleaned);
    if (!result.success) {
      const next: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const key = String(issue.path[0] ?? '');
        next[key] ??=
          issue.message === 'Invalid input: expected string, received undefined'
            ? t('form.required')
            : issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await onSubmit(result.data as Record<string, unknown>);
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      {fields.map((f) => {
        const error = errors[f.name];
        const value = values[f.name];
        const kind = f.type ?? 'text';
        if (kind === 'checkbox') {
          return (
            <label key={f.name} className="check">
              <input
                type="checkbox"
                checked={value === true}
                disabled={f.readOnly}
                onChange={(e) => {
                  set(f.name, e.target.checked);
                }}
              />{' '}
              {f.label}
            </label>
          );
        }
        if (kind === 'textarea' || kind === 'select') {
          const fid = `${id}-${f.name}`;
          return (
            <div className="field" key={f.name}>
              <label htmlFor={fid}>{f.label}</label>
              {kind === 'textarea' ? (
                <textarea
                  id={fid}
                  value={typeof value === 'string' ? value : ''}
                  readOnly={f.readOnly}
                  aria-invalid={error ? true : undefined}
                  onChange={(e) => {
                    set(f.name, e.target.value);
                  }}
                />
              ) : (
                <select
                  id={fid}
                  value={typeof value === 'string' ? value : ''}
                  disabled={f.readOnly}
                  onChange={(e) => {
                    set(f.name, e.target.value);
                  }}
                >
                  <option value="" />
                  {f.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              )}
              {error ? (
                <span className="field-error" role="alert">
                  {error}
                </span>
              ) : null}
            </div>
          );
        }
        return (
          <Field
            key={f.name}
            label={f.label}
            type={kind}
            value={typeof value === 'string' ? value : ''}
            readOnly={f.readOnly}
            error={error}
            {...(f.hint === undefined ? {} : { hint: f.hint })}
            onChange={(e) => {
              set(f.name, e.target.value);
            }}
          />
        );
      })}
      <ErrorAlert error={failure} />
      <div className="form-actions">
        {onCancel ? <Button onClick={onCancel}>{t('common.cancel')}</Button> : null}
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? t('form.saving') : (submitLabel ?? t('common.save'))}
        </Button>
      </div>
    </form>
  );
}
