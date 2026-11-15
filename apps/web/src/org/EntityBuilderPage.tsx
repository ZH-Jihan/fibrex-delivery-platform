/**
 * Record-type builder screen (phase 2 row 2.6, part a): where the business defines its own
 * record types and their fields without code. Left to right: the types (create, edit name and
 * numbering, delete with a reason, publish) and, for the type you open, its fields (add, edit
 * label/required/order, retire). Changes stay drafts until Publish; the published version is
 * what records are checked against. A field's key and type never change once created.
 * Not here yet (row 2.6b): generated list/form/detail pages, layouts, custom fields on system forms.
 * Depends on: api client, ui components, @fibrex/shared entities. Used by: App.tsx routes.
 */
import { useCallback, useEffect, useState } from 'react';
import { Blocks, Pencil, Plus, Rocket, Trash2 } from 'lucide-react';
import {
  entityLabels,
  entityTypeFormSchema,
  fieldFormSchema,
  FIELD_TYPES,
  type FieldForm,
  type EntityTypeForm,
} from '@fibrex/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, Field, PageHeader } from '../ui/components';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DataTable } from '../ui/DataTable';
import { EntityForm } from '../ui/EntityForm';

interface EntityRow {
  id: string;
  key: string;
  name: Record<string, string>;
  kind: 'system' | 'custom';
  numberingKey: string | null;
  status: 'draft' | 'published';
  publishedVersion: number;
  hasUnpublishedChanges: boolean;
  version: number;
}
interface FieldRow {
  id: string;
  key: string;
  label: Record<string, string>;
  type: string;
  required: boolean;
  sortOrder: number;
  status: 'draft' | 'published' | 'retired';
  lookupTypeId: string | null;
  refEntityKey: string | null;
  version: number;
}
interface LookupTypeRow {
  id: string;
  name: string;
}

const ifMatch = (version: number) => ({ 'If-Match': `"${String(version)}"` });

export function entityFormInitial(row: EntityRow | null): Record<string, unknown> {
  return {
    key: row?.key ?? '',
    labelEn: row?.name.en ?? '',
    labelBn: row?.name.bn ?? '',
    numberingKey: row?.numberingKey ?? '',
  };
}

export function fieldFormInitial(row: FieldRow | null): Record<string, unknown> {
  return {
    key: row?.key ?? '',
    labelEn: row?.label.en ?? '',
    labelBn: row?.label.bn ?? '',
    type: row?.type ?? 'text',
    required: row?.required ?? false,
    sortOrder: row?.sortOrder ?? 0,
    lookupTypeId: row?.lookupTypeId ?? '',
    refEntityKey: row?.refEntityKey ?? '',
  };
}

export function EntityBuilderPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const [entities, setEntities] = useState<EntityRow[]>([]);
  const [fields, setFields] = useState<FieldRow[]>([]);
  const [lookups, setLookups] = useState<LookupTypeRow[]>([]);
  const [open, setOpen] = useState<EntityRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editingEntity, setEditingEntity] = useState<EntityRow | 'new' | null>(null);
  const [editingField, setEditingField] = useState<FieldRow | 'new' | null>(null);
  const [removing, setRemoving] = useState<EntityRow | null>(null);
  const [reason, setReason] = useState('');

  const loadEntities = useCallback(() => {
    setLoading(true);
    api<{ items: EntityRow[] }>('/entity-definitions', {
      query: { kind: 'custom', page: 1, pageSize: 200 },
    })
      .then((r) => {
        setEntities(r.items);
        setError(null);
        setOpen((current) => r.items.find((x) => x.id === current?.id) ?? null);
      })
      .catch((e: unknown) => {
        setError(e);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);
  useEffect(loadEntities, [loadEntities]);

  useEffect(() => {
    // Lookup lists a dropdown field can point at; the screen works without them.
    api<{ items: LookupTypeRow[] }>('/lookup-types', { query: { page: 1, pageSize: 200 } })
      .then((r) => {
        setLookups(r.items);
      })
      .catch(() => undefined);
  }, []);

  const openId = open?.id;
  const loadFields = useCallback(() => {
    if (openId === undefined) {
      setFields([]);
      return;
    }
    api<{ items: FieldRow[] }>('/field-definitions', {
      query: { entityDefinitionId: openId, page: 1, pageSize: 200 },
    })
      .then((r) => {
        setFields(r.items.sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key)));
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, [openId]);
  useEffect(loadFields, [loadFields]);

  const statusText = (r: EntityRow) =>
    r.status === 'draft'
      ? t('entities.draft')
      : r.hasUnpublishedChanges
        ? t('entities.changed', { version: String(r.publishedVersion) })
        : t('entities.published', { version: String(r.publishedVersion) });

  const publish = (r: EntityRow) => {
    api(`/entity-definitions/${r.id}/publish`, { method: 'POST', headers: ifMatch(r.version) })
      .then(() => {
        loadEntities();
        loadFields();
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };

  const typeOptions = FIELD_TYPES.map((x) => ({ value: x, label: t(`entities.type.${x}`) }));
  const lookupOptions = [
    { value: '', label: '-' },
    ...lookups.map((l) => ({ value: l.id, label: l.name })),
  ];

  return (
    <>
      <PageHeader
        title={t('entities.title')}
        icon={Blocks}
        description={t('entities.intro')}
        actions={
          auth.can('platform.entity_definition.create') ? (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setEditingEntity('new');
              }}
            >
              {t('entities.newType')}
            </Button>
          ) : null
        }
      />
      {editingEntity !== null ? (
        <section className="card">
          <EntityForm
            key={
              editingEntity === 'new'
                ? 'new-entity'
                : `${editingEntity.id}-${String(editingEntity.version)}`
            }
            fields={[
              {
                name: 'key',
                label: t('entities.key'),
                hint: t('entities.keyHint'),
                readOnly: editingEntity !== 'new',
              },
              { name: 'labelEn', label: t('entities.labelEn') },
              { name: 'labelBn', label: t('entities.labelBn') },
              {
                name: 'numberingKey',
                label: t('entities.numberingKey'),
                hint: t('entities.numberingHint'),
              },
            ]}
            schema={entityTypeFormSchema}
            initial={entityFormInitial(editingEntity === 'new' ? null : editingEntity)}
            onCancel={() => {
              setEditingEntity(null);
            }}
            onSubmit={async (raw) => {
              const form = raw as EntityTypeForm;
              const numberingKey = form.numberingKey === '' ? null : form.numberingKey;
              if (editingEntity === 'new') {
                await api('/entity-definitions', {
                  method: 'POST',
                  body: { key: form.key, name: entityLabels(form), numberingKey },
                });
              } else {
                await api(`/entity-definitions/${editingEntity.id}`, {
                  method: 'PATCH',
                  body: { name: entityLabels(form), numberingKey },
                  headers: ifMatch(editingEntity.version),
                });
              }
              setEditingEntity(null);
              loadEntities();
            }}
          />
        </section>
      ) : null}
      <DataTable
        columns={[
          { key: 'key', header: t('entities.key'), value: (r) => r.key },
          { key: 'name', header: t('entities.labelEn'), value: (r) => r.name.en ?? r.key },
          { key: 'status', header: t('entities.status'), value: statusText },
        ]}
        rows={entities}
        rowKey={(r) => r.id}
        total={entities.length}
        page={1}
        pageSize={200}
        onPageChange={() => undefined}
        loading={loading}
        error={error}
        exportName="record-types"
        actions={(r) => (
          <>
            <Button
              variant="link"
              icon={Blocks}
              onClick={() => {
                setOpen(r);
                setEditingField(null);
              }}
            >
              {t('entities.fields')}
            </Button>
            {auth.can('platform.entity_definition.update') ? (
              <Button
                variant="link"
                icon={Pencil}
                onClick={() => {
                  setEditingEntity(r);
                }}
              >
                {t('common.edit')}
              </Button>
            ) : null}
            {auth.can('platform.entity_definition.publish') &&
            (r.status === 'draft' || r.hasUnpublishedChanges) ? (
              <Button
                variant="link"
                icon={Rocket}
                onClick={() => {
                  publish(r);
                }}
              >
                {t('entities.publish')}
              </Button>
            ) : null}
            {auth.can('platform.entity_definition.delete') ? (
              <Button
                variant="link"
                dangerText
                icon={Trash2}
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
      {open !== null ? (
        <section
          className="card"
          aria-label={t('entities.fieldsOf', { name: open.name.en ?? open.key })}
        >
          <h2>{t('entities.fieldsOf', { name: open.name.en ?? open.key })}</h2>
          {auth.can('platform.field_definition.create') ? (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setEditingField('new');
              }}
            >
              {t('entities.newField')}
            </Button>
          ) : null}
          {editingField !== null ? (
            <EntityForm
              key={
                editingField === 'new'
                  ? 'new-field'
                  : `${editingField.id}-${String(editingField.version)}`
              }
              fields={[
                {
                  name: 'key',
                  label: t('entities.key'),
                  hint: t('entities.fieldKeyHint'),
                  readOnly: editingField !== 'new',
                },
                { name: 'labelEn', label: t('entities.labelEn') },
                { name: 'labelBn', label: t('entities.labelBn') },
                {
                  name: 'type',
                  label: t('entities.fieldType'),
                  type: 'select',
                  options: typeOptions,
                  readOnly: editingField !== 'new',
                },
                { name: 'required', label: t('entities.required'), type: 'checkbox' },
                { name: 'sortOrder', label: t('lookups.sortOrder') },
                {
                  name: 'lookupTypeId',
                  label: t('entities.lookupList'),
                  hint: t('entities.lookupHint'),
                  type: 'select',
                  options: lookupOptions,
                  readOnly: editingField !== 'new',
                },
                {
                  name: 'refEntityKey',
                  label: t('entities.refEntity'),
                  hint: t('entities.refHint'),
                  readOnly: editingField !== 'new',
                },
              ]}
              schema={fieldFormSchema}
              initial={fieldFormInitial(editingField === 'new' ? null : editingField)}
              onCancel={() => {
                setEditingField(null);
              }}
              onSubmit={async (raw) => {
                const form = raw as FieldForm;
                if (editingField === 'new') {
                  await api('/field-definitions', {
                    method: 'POST',
                    body: {
                      entityDefinitionId: open.id,
                      key: form.key,
                      label: entityLabels(form),
                      type: form.type,
                      required: form.required,
                      sortOrder: form.sortOrder,
                      lookupTypeId: form.lookupTypeId === '' ? null : form.lookupTypeId,
                      refEntityKey: form.refEntityKey === '' ? null : form.refEntityKey,
                    },
                  });
                } else {
                  await api(`/field-definitions/${editingField.id}`, {
                    method: 'PATCH',
                    body: {
                      label: entityLabels(form),
                      required: form.required,
                      sortOrder: form.sortOrder,
                    },
                    headers: ifMatch(editingField.version),
                  });
                }
                setEditingField(null);
                loadFields();
                loadEntities();
              }}
            />
          ) : null}
          <DataTable
            columns={[
              { key: 'key', header: t('entities.key'), value: (r) => r.key },
              { key: 'label', header: t('entities.labelEn'), value: (r) => r.label.en ?? r.key },
              {
                key: 'type',
                header: t('entities.fieldType'),
                value: (r) => t(`entities.type.${r.type as (typeof FIELD_TYPES)[number]}`),
              },
              {
                key: 'required',
                header: t('entities.required'),
                value: (r) => (r.required ? t('common.yes') : t('common.no')),
              },
              { key: 'order', header: t('lookups.sortOrder'), value: (r) => String(r.sortOrder) },
              {
                key: 'status',
                header: t('entities.status'),
                value: (r) => t(`entities.field.${r.status}`),
              },
            ]}
            rows={fields}
            rowKey={(r) => r.id}
            total={fields.length}
            page={1}
            pageSize={200}
            onPageChange={() => undefined}
            loading={false}
            error={null}
            exportName={`fields-${open.key}`}
            actions={(r) => (
              <>
                {auth.can('platform.field_definition.update') ? (
                  <Button
                    variant="link"
                    icon={Pencil}
                    onClick={() => {
                      setEditingField(r);
                    }}
                  >
                    {t('common.edit')}
                  </Button>
                ) : null}
                {auth.can('platform.field_definition.update') && r.status !== 'retired' ? (
                  <Button
                    variant="link"
                    dangerText
                    icon={Trash2}
                    onClick={() => {
                      api(`/field-definitions/${r.id}`, {
                        method: 'PATCH',
                        body: { status: 'retired' },
                        headers: ifMatch(r.version),
                      })
                        .then(() => {
                          loadFields();
                          loadEntities();
                        })
                        .catch((e: unknown) => {
                          setError(e);
                        });
                    }}
                  >
                    {t('entities.retire')}
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
          api(`/entity-definitions/${removing.id}`, {
            method: 'DELETE',
            body: { reason: reason.trim() },
            headers: ifMatch(removing.version),
          })
            .then(() => {
              setRemoving(null);
              setReason('');
              loadEntities();
            })
            .catch((e: unknown) => {
              setRemoving(null);
              setError(e);
            });
        }}
      >
        <p className="muted">{t('entities.deleteHint')}</p>
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
