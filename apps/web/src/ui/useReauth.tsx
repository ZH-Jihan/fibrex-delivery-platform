/**
 * useReauth: run a sensitive call, and if the API answers `reauth_required`, ask for the
 * password once (POST /auth/reauth), then repeat the call. Used by screens that change
 * access (permission matrix, users' roles). The password is held in component state only
 * for the length of the dialog and is never stored.
 * Depends on: api client, ConfirmDialog, i18n. Used by: admin screens.
 */
import { useRef, useState } from 'react';
import { ApiError, api } from '../api/client';
import { useI18n } from '../i18n';
import { Field } from './components';
import { ConfirmDialog } from './ConfirmDialog';

export function useReauth() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const pending = useRef<{ resolve: () => void; reject: (e: unknown) => void } | null>(null);

  /** Calls `action`; on reauth_required asks for the password and calls it again. */
  const run = async <T,>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== 'reauth_required') throw err;
    }
    await new Promise<void>((resolve, reject) => {
      pending.current = { resolve, reject };
      setOpen(true);
    });
    return action();
  };

  const confirm = () => {
    const p = pending.current;
    api('/auth/reauth', { method: 'POST', body: { password } })
      .then(() => {
        setOpen(false);
        setPassword('');
        p?.resolve();
      })
      .catch((e: unknown) => {
        setOpen(false);
        setPassword('');
        p?.reject(e);
      });
  };
  const cancel = () => {
    setOpen(false);
    setPassword('');
    pending.current?.reject(new Error('cancelled'));
  };

  const dialog = (
    <ConfirmDialog open={open} title={t('matrix.reauth')} onConfirm={confirm} onCancel={cancel}>
      <Field
        label={t('matrix.password')}
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
        }}
      />
    </ConfirmDialog>
  );
  return { run, dialog };
}
