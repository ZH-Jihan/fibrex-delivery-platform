/**
 * Roles screen: list, create, edit and delete roles. The key is fixed once the role exists
 * (it appears in the audit trail); built-in roles can be edited but the API decides what
 * it allows. Deleting needs a reason. The permissions of a role are edited in the
 * permission matrix, not here.
 * Depends on: api client, ui components, shared schemas. Used by: App.tsx routes.
 */
import { useCallback, useEffect, useState } from 'react';
import { roleCreateSchema, roleUpdateSchema } from '@fibrex/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button } from '../ui/components';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DataTable } from '../ui/DataTable';
import { EntityForm } from '../ui/EntityForm';
import { HistoryTab } from '../ui/HistoryTab';

interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isBuiltin: boolean;
  mfaRequired: boolean;
  version: number;
}

export function RolesPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: RoleRow[]; total: number }>({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<RoleRow | 'new' | null>(null);
  const [removing, setRemoving] = useState<RoleRow | null>(null);
  const [reason, setReason] = useState('');
  const pageSize = 25;

  const load = useCallback(() => {
    setLoading(true);
    api<{ items: RoleRow[]; total: number }>('/roles', { query: { page, pageSize } })
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [page]);
  useEffect(load, [load]);

  const fields = (isNew: boolean) => [
    { name: 'key', label: t('roles.key'), readOnly: !isNew },
    { name: 'name', label: t('roles.name') },
    { name: 'description', label: t('roles.description'), type: 'textarea' as const },
    { name: 'mfaRequired', label: t('roles.mfaRequired'), type: 'checkbox' as const },
  ];
  const visibleFields = (isNew: boolean) => (isNew ? fields(true) : fields(false).slice(1));

  return (
    <>
      <div className="page-head">
        <h1>{t('roles.title')}</h1>
        {auth.can('iam.role.create') ? (
          <Button
            variant="primary"
            onClick={() => {
              setEditing('new');
            }}
          >
            {t('roles.new')}
          </Button>
        ) : null}
      </div>
      {editing !== null ? (
        <section className="card">
          <EntityForm
            key={editing === 'new' ? 'new' : `${editing.id}-${String(editing.version)}`}
            fields={visibleFields(editing === 'new')}
            schema={editing === 'new' ? roleCreateSchema : roleUpdateSchema}
            initial={
              editing === 'new'
                ? {}
                : {
                    name: editing.name,
                    description: editing.description ?? '',
                    mfaRequired: editing.mfaRequired,
                  }
            }
            onCancel={() => {
              setEditing(null);
            }}
            onSubmit={async (values) => {
              if (editing === 'new') {
                await api('/roles', { method: 'POST', body: values });
              } else {
                await api(`/roles/${editing.id}`, {
                  method: 'PATCH',
                  body: values,
                  headers: { 'If-Match': `"${String(editing.version)}"` },
                });
              }
              setEditing(null);
              load();
            }}
          />
          {editing !== 'new' ? (
            <>
              <h2>{t('history.title')}</h2>
              <HistoryTab entityType="iam.role" entityId={editing.id} />
            </>
          ) : null}
        </section>
      ) : null}
      <DataTable
        columns={[
          { key: 'key', header: t('roles.key'), value: (r) => r.key },
          { key: 'name', header: t('roles.name'), value: (r) => r.name },
          { key: 'description', header: t('roles.description'), value: (r) => r.description },
          {
            key: 'builtin',
            header: t('roles.builtin'),
            value: (r) => (r.isBuiltin ? t('common.yes') : t('common.no')),
          },
          {
            key: 'mfa',
            header: t('roles.mfaRequired'),
            value: (r) => (r.mfaRequired ? t('common.yes') : t('common.no')),
          },
        ]}
        rows={data.items}
        rowKey={(r) => r.id}
        total={data.total}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        loading={loading}
        error={error}
        exportName="roles"
        actions={(r) => (
          <>
            {auth.can('iam.role.update') ? (
              <Button
                variant="link"
                onClick={() => {
                  setEditing(r);
                }}
              >
                {t('common.edit')}
              </Button>
            ) : null}{' '}
            {auth.can('iam.role.delete') && !r.isBuiltin ? (
              <Button
                variant="link"
                onClick={() => {
                  setRemoving(r);
                }}
              >
                {t('common.delete')}
              </Button>
            ) : null}
          </>
        )}
      />
      <ConfirmDialog
        open={removing !== null}
        danger
        title={t('common.delete')}
        onCancel={() => {
          setRemoving(null);
        }}
        onConfirm={() => {
          if (removing === null || reason.trim() === '') return;
          api(`/roles/${removing.id}`, {
            method: 'DELETE',
            body: { reason: reason.trim() },
            headers: { 'If-Match': `"${String(removing.version)}"` },
          })
            .then(() => {
              setRemoving(null);
              setReason('');
              load();
            })
            .catch((e: unknown) => {
              setRemoving(null);
              setError(e);
            });
        }}
      >
        <label>
          {t('users.deleteReason')}
          <input
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
            }}
          />
        </label>
      </ConfirmDialog>
    </>
  );
}
