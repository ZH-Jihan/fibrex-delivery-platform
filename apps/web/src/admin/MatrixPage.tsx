/**
 * Permission matrix: one row per permission (grouped by module), one column per role, a
 * tick box in each cell. Ticks are collected as pending changes and saved together with
 * PUT /permission-matrix. The API asks for a recent re-authentication on this call, so the
 * save runs through `useReauth`. Without `iam.permission_matrix.update` the boxes are
 * read-only. The matrix shows role grants only; per-user overrides are a later screen.
 * Depends on: api client, useReauth, i18n. Used by: App.tsx routes.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, ErrorAlert, Skeleton, errorText } from '../ui/components';
import { useReauth } from '../ui/useReauth';
import { useToast } from '../ui/toast';

interface Matrix {
  roles: { id: string; key: string; name: string; isBuiltin: boolean }[];
  permissions: { key: string; moduleKey: string; description: string }[];
  grants: { roleId: string; permissionKey: string }[];
}

const cell = (roleId: string, permissionKey: string) => `${roleId}|${permissionKey}`;

export function MatrixPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const reauth = useReauth();
  const [matrix, setMatrix] = useState<Matrix | null>(null);
  const [error, setError] = useState<unknown>(null);
  // Cells whose state differs from the server: cell id -> wanted state.
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(new Map());

  const load = useCallback(() => {
    api<Matrix>('/permission-matrix')
      .then((m) => {
        setMatrix(m);
        setPending(new Map());
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, []);
  useEffect(load, [load]);

  const granted = useMemo(
    () => new Set((matrix?.grants ?? []).map((g) => cell(g.roleId, g.permissionKey))),
    [matrix],
  );
  const canEdit = auth.can('iam.permission_matrix.update');

  const toggle = (roleId: string, key: string, wanted: boolean) => {
    const id = cell(roleId, key);
    const next = new Map(pending);
    // Setting a cell back to what the server has cancels the pending change.
    if (granted.has(id) === wanted) next.delete(id);
    else next.set(id, wanted);
    setPending(next);
  };

  const save = () => {
    const changes = [...pending].map(([id, isGranted]) => {
      const [roleId = '', permissionKey = ''] = id.split('|');
      return { roleId, permissionKey, granted: isGranted };
    });
    reauth
      .run(() => api('/permission-matrix', { method: 'PUT', body: { changes } }))
      .then(() => {
        toast.show(t('matrix.saved'), 'success');
        load();
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.message === 'cancelled') return;
        toast.show(errorText(e, t), 'error');
      });
  };

  if (error !== null) return <ErrorAlert error={error} />;
  if (matrix === null) return <Skeleton lines={6} />;

  let lastModule = '';
  return (
    <>
      <div className="page-head">
        <h1>{t('matrix.title')}</h1>
        {canEdit ? (
          <div className="row-actions">
            {pending.size > 0 ? <span>{t('matrix.pending', { count: pending.size })}</span> : null}
            <Button variant="primary" disabled={pending.size === 0} onClick={save}>
              {t('matrix.save')}
            </Button>
          </div>
        ) : null}
      </div>
      <div className="table-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th />
              {matrix.roles.map((r) => (
                <th key={r.id}>{r.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.permissions.map((p) => {
              const heading = p.moduleKey !== lastModule;
              lastModule = p.moduleKey;
              return [
                heading ? (
                  <tr key={`m-${p.moduleKey}`} className="matrix-module">
                    <th colSpan={matrix.roles.length + 1}>{p.moduleKey}</th>
                  </tr>
                ) : null,
                <tr key={p.key}>
                  <th scope="row" title={p.description}>
                    {p.key}
                  </th>
                  {matrix.roles.map((r) => {
                    const id = cell(r.id, p.key);
                    const on = pending.get(id) ?? granted.has(id);
                    return (
                      <td key={r.id}>
                        <input
                          type="checkbox"
                          aria-label={`${r.name}: ${p.key}`}
                          checked={on}
                          disabled={!canEdit}
                          onChange={(e) => {
                            toggle(r.id, p.key, e.target.checked);
                          }}
                        />
                      </td>
                    );
                  })}
                </tr>,
              ];
            })}
          </tbody>
        </table>
      </div>
      {reauth.dialog}
    </>
  );
}
