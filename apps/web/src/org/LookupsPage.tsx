/**
 * Lookups settings screen (phase 2 row 2.3): the dropdown lists the business may change.
 * Left to right: the lists (create, rename, delete with a reason; the key never changes) and,
 * for the list you open, its values (code, labels in each language, order, active, parent
 * when the list allows a hierarchy). A value's code never changes once created because
 * records store it; retire a value with Active = No instead of deleting it.
 * Depends on: api client, ui components, @fibrex/shared lookups. Used by: App.tsx routes.
 */
import { useCallback, useEffect, useState } from 'react';
import { ListTree, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  labelsFromForm,
  lookupLabel,
  lookupTypeFormSchema,
  lookupValueFormSchema,
  type LookupLabels,
  type LookupValueForm,
} from '@fibrex/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, Field, PageHeader } from '../ui/components';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DataTable } from '../ui/DataTable';
import { EntityForm } from '../ui/EntityForm';

interface TypeRow {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
  allowHierarchy: boolean;
  version: number;
}
interface ValueRow {
  id: string;
  lookupTypeId: string;
  code: string;
  labels: LookupLabels;
  parentId: string | null;
  sortOrder: number;
  active: boolean;
  version: number;
}
type Removing = { kind: 'types'; row: TypeRow } | { kind: 'values'; row: ValueRow };

const ifMatch = (version: number) => ({ 'If-Match': `"${String(version)}"` });

/** The form's starting values for an existing value (or the empty form). */
export function valueFormInitial(row: ValueRow | null): Record<string, unknown> {
  return {
    code: row?.code ?? '',
    labelEn: row?.labels.en ?? '',
    labelBn: row?.labels.bn ?? '',
    labelUr: row?.labels.ur ?? '',
    labelHi: row?.labels.hi ?? '',
    labelNe: row?.labels.ne ?? '',
    sortOrder: row?.sortOrder ?? 0,
    active: row?.active ?? true,
    parentId: row?.parentId ?? '',
  };
}

export function LookupsPage() {
  const { t, language } = useI18n();
  const auth = useAuth();
  const [types, setTypes] = useState<TypeRow[]>([]);
  const [values, setValues] = useState<ValueRow[]>([]);
  const [open, setOpen] = useState<TypeRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editingType, setEditingType] = useState<TypeRow | 'new' | null>(null);
  const [editingValue, setEditingValue] = useState<ValueRow | 'new' | null>(null);
  const [removing, setRemoving] = useState<Removing | null>(null);
  const [reason, setReason] = useState('');

  const loadTypes = useCallback(() => {
    setLoading(true);
    api<{ items: TypeRow[] }>('/lookup-types', { query: { page: 1, pageSize: 200 } })
      .then((r) => {
        setTypes(r.items);
        setError(null);
        // Keep the open list in step with what was just saved.
        setOpen((current) => r.items.find((x) => x.id === current?.id) ?? null);
      })
      .catch((e: unknown) => {
        setError(e);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);
  useEffect(loadTypes, [loadTypes]);

  const openId = open?.id;
  const loadValues = useCallback(() => {
    if (openId === undefined) {
      setValues([]);
      return;
    }
    api<{ items: ValueRow[] }>('/lookup-values', {
      query: { lookupTypeId: openId, page: 1, pageSize: 200 },
    })
      .then((r) => {
        setValues(
          r.items.sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code)),
        );
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, [openId]);
  useEffect(loadValues, [loadValues]);

  const labelOf = (row: ValueRow) => lookupLabel(row.labels, language, row.code);
  const parentOptions = [
    { value: '', label: '-' },
    ...values
      .filter((v) => typeof editingValue !== 'object' || v.id !== editingValue?.id)
      .map((v) => ({ value: v.id, label: `${labelOf(v)} (${v.code})` })),
  ];
  const valueFields = [
    {
      name: 'code',
      label: t('lookups.code'),
      hint: t('lookups.codeHint'),
      readOnly: editingValue !== 'new',
    },
    { name: 'labelEn', label: t('lookups.labelEn') },
    { name: 'labelBn', label: t('lookups.labelBn') },
    { name: 'labelUr', label: t('lookups.labelUr') },
    { name: 'labelHi', label: t('lookups.labelHi') },
    { name: 'labelNe', label: t('lookups.labelNe') },
    { name: 'sortOrder', label: t('lookups.sortOrder') },
    { name: 'active', label: t('lookups.active'), type: 'checkbox' as const },
    ...(open?.allowHierarchy === true
      ? [
          {
            name: 'parentId',
            label: t('lookups.parent'),
            type: 'select' as const,
            options: parentOptions,
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title={t('lookups.title')}
        icon={ListTree}
        description={t('lookups.intro')}
        actions={
          auth.can('platform.lookup_type.create') ? (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setEditingType('new');
              }}
            >
              {t('lookups.newType')}
            </Button>
          ) : null
        }
      />
      {editingType !== null ? (
        <section className="card">
          <EntityForm
            key={editingType === 'new' ? 'new' : `${editingType.id}-${String(editingType.version)}`}
            fields={[
              {
                name: 'key',
                label: t('lookups.key'),
                hint: t('lookups.keyHint'),
                readOnly: editingType !== 'new',
              },
              { name: 'name', label: t('lookups.name') },
              { name: 'allowHierarchy', label: t('lookups.allowHierarchy'), type: 'checkbox' },
            ]}
            schema={lookupTypeFormSchema}
            initial={
              editingType === 'new'
                ? { key: '', name: '', allowHierarchy: false }
                : {
                    key: editingType.key,
                    name: editingType.name,
                    allowHierarchy: editingType.allowHierarchy,
                  }
            }
            onCancel={() => {
              setEditingType(null);
            }}
            onSubmit={async (form) => {
              if (editingType === 'new') {
                await api('/lookup-types', { method: 'POST', body: form });
              } else {
                await api(`/lookup-types/${editingType.id}`, {
                  method: 'PATCH',
                  body: { name: form.name, allowHierarchy: form.allowHierarchy },
                  headers: ifMatch(editingType.version),
                });
              }
              setEditingType(null);
              loadTypes();
            }}
          />
        </section>
      ) : null}
      <DataTable
        columns={[
          { key: 'key', header: t('lookups.key'), value: (r) => r.key },
          { key: 'name', header: t('lookups.name'), value: (r) => r.name },
          {
            key: 'system',
            header: t('lookups.system'),
            value: (r) => (r.isSystem ? t('common.yes') : t('common.no')),
          },
          {
            key: 'tree',
            header: t('lookups.allowHierarchy'),
            value: (r) => (r.allowHierarchy ? t('common.yes') : t('common.no')),
          },
        ]}
        rows={types}
        rowKey={(r) => r.id}
        total={types.length}
        page={1}
        pageSize={200}
        onPageChange={() => undefined}
        loading={loading}
        error={error}
        exportName="lookup-lists"
        actions={(r) => (
          <>
            <Button
              variant="link"
              icon={ListTree}
              onClick={() => {
                setOpen(r);
                setEditingValue(null);
              }}
            >
              {t('lookups.values')}
            </Button>
            {auth.can('platform.lookup_type.update') ? (
              <Button
                variant="link"
                icon={Pencil}
                onClick={() => {
                  setEditingType(r);
                }}
              >
                {t('common.edit')}
              </Button>
            ) : null}
            {auth.can('platform.lookup_type.delete') && !r.isSystem ? (
              <Button
                variant="link"
                dangerText
                icon={Trash2}
                onClick={() => {
                  setRemoving({ kind: 'types', row: r });
                }}
              >
                {t('common.delete')}
              </Button>
            ) : null}
          </>
        )}
      />
      {open !== null ? (
        <section className="card" aria-label={t('lookups.valuesOf', { name: open.name })}>
          <h2>{t('lookups.valuesOf', { name: open.name })}</h2>
          {auth.can('platform.lookup_value.create') ? (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setEditingValue('new');
              }}
            >
              {t('lookups.newValue')}
            </Button>
          ) : null}
          {editingValue !== null ? (
            <EntityForm
              key={
                editingValue === 'new'
                  ? 'new-value'
                  : `${editingValue.id}-${String(editingValue.version)}`
              }
              fields={valueFields}
              schema={lookupValueFormSchema}
              initial={valueFormInitial(editingValue === 'new' ? null : editingValue)}
              onCancel={() => {
                setEditingValue(null);
              }}
              onSubmit={async (raw) => {
                const form = raw as LookupValueForm;
                const common = {
                  labels: labelsFromForm(form),
                  sortOrder: form.sortOrder,
                  active: form.active,
                  parentId: form.parentId === '' ? null : form.parentId,
                };
                if (editingValue === 'new') {
                  await api('/lookup-values', {
                    method: 'POST',
                    body: { ...common, lookupTypeId: open.id, code: form.code },
                  });
                } else {
                  await api(`/lookup-values/${editingValue.id}`, {
                    method: 'PATCH',
                    body: common,
                    headers: ifMatch(editingValue.version),
                  });
                }
                setEditingValue(null);
                loadValues();
              }}
            />
          ) : null}
          <DataTable
            columns={[
              { key: 'code', header: t('lookups.code'), value: (r) => r.code },
              { key: 'label', header: t('lookups.label'), value: labelOf },
              { key: 'order', header: t('lookups.sortOrder'), value: (r) => String(r.sortOrder) },
              {
                key: 'active',
                header: t('lookups.active'),
                value: (r) => (r.active ? t('common.yes') : t('common.no')),
              },
            ]}
            rows={values}
            rowKey={(r) => r.id}
            total={values.length}
            page={1}
            pageSize={200}
            onPageChange={() => undefined}
            loading={false}
            error={null}
            exportName={`lookup-${open.key}`}
            actions={(r) => (
              <>
                {auth.can('platform.lookup_value.update') ? (
                  <Button
                    variant="link"
                    icon={Pencil}
                    onClick={() => {
                      setEditingValue(r);
                    }}
                  >
                    {t('common.edit')}
                  </Button>
                ) : null}
                {auth.can('platform.lookup_value.delete') ? (
                  <Button
                    variant="link"
                    dangerText
                    icon={Trash2}
                    onClick={() => {
                      setRemoving({ kind: 'values', row: r });
                    }}
                  >
                    {t('common.delete')}
                  </Button>
                ) : null}
              </>
            )}
          />
        </section>
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        danger
        title={t('common.delete')}
        onCancel={() => {
          setRemoving(null);
        }}
        onConfirm={() => {
          if (removing === null || reason.trim() === '') return;
          api(`/lookup-${removing.kind}/${removing.row.id}`, {
            method: 'DELETE',
            body: { reason: reason.trim() },
            headers: ifMatch(removing.row.version),
          })
            .then(() => {
              setRemoving(null);
              setReason('');
              loadTypes();
              loadValues();
            })
            .catch((e: unknown) => {
              setRemoving(null);
              setError(e);
            });
        }}
      >
        <p className="muted">{t('lookups.deleteHint')}</p>
        <Field
          label={t('users.deleteReason')}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
          }}
        />
      </ConfirmDialog>
    </>
  );
}
