/**
 * Generated record pages (phase 2 row 2.6b): the list, form and detail screens of every
 * published custom record type, drawn from its published definition (`GET /entities/:key`)
 * and stored through the records API (`/records/:key`). No page is written per type: the
 * field list, labels, required marks, dropdown options, list columns and form/detail
 * sections all come from the definition, so a type published in the builder is usable at once.
 * Records are checked in the browser with the same `validateRecordData` the API runs.
 * Not here: custom-field section on system forms, state transitions (row 2.10).
 * Depends on: api client, ui components, @fibrex/shared entities. Used by: App.tsx routes.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Blocks, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  LIST_BUILTIN_COLUMNS,
  validateRecordData,
  type FieldSpec,
  type Layout,
  type ListConfig,
  type RecordJsonSchema,
} from '@fibrex/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, EmptyState, ErrorAlert, Field, PageHeader, Skeleton } from '../ui/components';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DataTable, type Column } from '../ui/DataTable';
import { EntityForm, type FormField } from '../ui/EntityForm';
import { WorkflowTimeline } from '../workflow/WorkflowTimeline';

export interface PublishedType {
  id: string;
  key: string;
  name: Record<string, string>;
  version: number;
  listConfig: ListConfig;
  formLayout: Layout;
  detailLayout: Layout;
  numberingKey: string | null;
  fields: (FieldSpec & { id: string })[];
  jsonSchema: RecordJsonSchema;
}
export interface RecordItem {
  id: string;
  number: string | null;
  stateCode: string | null;
  data: Record<string, unknown>;
  version: number;
  createdAt?: string;
  updatedAt?: string;
}
interface LookupItem {
  code: string;
  labels: Record<string, string>;
}

/** Text of a stored scalar (objects have no meaningful text and show empty). */
const text = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';

const ifMatch = (version: number) => ({ 'If-Match': `"${String(version)}"` });

/** The label in the user's language, else English, else the key. */
export function pick(labels: Record<string, string> | undefined, lang: string, key: string) {
  return labels?.[lang] ?? labels?.en ?? key;
}

/** Fields offered on forms and shown in pages: everything except retired ones, in order. */
export function activeFields(type: PublishedType): (FieldSpec & { id: string })[] {
  return type.fields
    .filter((f) => f.status !== 'retired')
    .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key));
}

/**
 * Sections of a layout with every field key placed; fields the layout does not mention
 * go to a last, untitled section so a new field is never hidden.
 */
export function sectionsOf(
  layout: Layout,
  fields: readonly { key: string }[],
  lang: string,
): { title: string; keys: string[] }[] {
  const known = new Set(fields.map((f) => f.key));
  const placed = new Set<string>();
  const out = layout.sections.map((s) => {
    const keys = s.fields.filter((k) => known.has(k));
    keys.forEach((k) => placed.add(k));
    return { title: pick(s.title, lang, ''), keys };
  });
  const rest = fields.map((f) => f.key).filter((k) => !placed.has(k));
  if (rest.length > 0) out.push({ title: '', keys: rest });
  return out.filter((s) => s.keys.length > 0);
}

/** Form text and flags -> typed record data (numbers as numbers, lists split on commas). */
export function formToData(
  fields: readonly FieldSpec[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (v === undefined || v === '') continue;
    if (f.type === 'number') {
      data[f.key] = typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : v;
    } else if (f.type === 'multi') {
      data[f.key] =
        typeof v === 'string'
          ? v
              .split(',')
              .map((x) => x.trim())
              .filter((x) => x !== '')
          : v;
    } else if (f.type === 'boolean') {
      data[f.key] = v === true;
    } else {
      data[f.key] = typeof v === 'string' ? v.trim() : v;
    }
  }
  return data;
}

/** Stored record data -> form starting values (the reverse of `formToData`). */
export function dataToForm(
  fields: readonly FieldSpec[],
  data: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = data[f.key];
    if (v === undefined || v === null) {
      if (f.type === 'boolean') out[f.key] = false;
      continue;
    }
    out[f.key] = Array.isArray(v) ? v.join(', ') : f.type === 'boolean' ? v === true : text(v);
  }
  return out;
}

/** Text shown for one stored value; dropdown codes use the list's label when known. */
export function displayValue(
  field: FieldSpec,
  value: unknown,
  lookups: Record<string, LookupItem[]>,
  lang: string,
  yes: string,
  no: string,
): string {
  if (value === undefined || value === null || value === '') return '';
  if (field.type === 'boolean') return value === true ? yes : no;
  const label = (code: string) => {
    const hit = lookups[field.lookupKey ?? '']?.find((l) => l.code === code);
    return hit === undefined ? code : pick(hit.labels, lang, code);
  };
  if (Array.isArray(value)) return value.map((v) => label(text(v))).join(', ');
  if (field.type === 'dropdown') return label(text(value));
  return text(value);
}

/** Loads the published type and the lookup lists its dropdown fields use. */
function useRecordType(key: string) {
  const [type, setType] = useState<PublishedType | null>(null);
  const [lookups, setLookups] = useState<Record<string, LookupItem[]>>({});
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    setType(null);
    setError(null);
    api<PublishedType>(`/entities/${key}`)
      .then(async (published) => {
        const keys = [
          ...new Set(
            published.fields
              .map((f) => f.lookupKey)
              .filter((k): k is string => typeof k === 'string' && k !== ''),
          ),
        ];
        const loaded: Record<string, LookupItem[]> = {};
        await Promise.all(
          keys.map((k) =>
            api<{ items: LookupItem[] }>(`/lookups/${k}`)
              .then((l) => {
                loaded[k] = l.items;
              })
              .catch(() => undefined),
          ),
        );
        if (!live) return;
        setLookups(loaded);
        setType(published);
      })
      .catch((e: unknown) => {
        if (live) setError(e);
      });
    return () => {
      live = false;
    };
  }, [key]);
  return { type, lookups, error };
}

/** `/records`: the published record types, one tile each (the menu entry for generated pages). */
export function RecordTypesIndexPage() {
  const { t, language } = useI18n();
  const [types, setTypes] = useState<{ id: string; key: string; name: Record<string, string> }[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api<{ items: { id: string; key: string; name: Record<string, string>; status: string }[] }>(
      '/entity-definitions',
      { query: { kind: 'custom', page: 1, pageSize: 200 } },
    )
      .then((r) => {
        setTypes(r.items.filter((x) => x.status === 'published'));
      })
      .catch((e: unknown) => {
        setError(e);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);
  return (
    <>
      <PageHeader title={t('records.title')} icon={Blocks} description={t('records.intro')} />
      {error !== null ? <ErrorAlert error={error} /> : null}
      {loading ? (
        <Skeleton />
      ) : types.length === 0 ? (
        <EmptyState title={t('records.noTypes')} />
      ) : (
        <ul className="tiles">
          {types.map((x) => (
            <li key={x.id} className="card">
              <Link to={`/records/${x.key}`}>{pick(x.name, language, x.key)}</Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** `/records/:key`: list with search, create, edit, detail and delete for one record type. */
export function RecordsPage() {
  const { key = '' } = useParams();
  const { t, language } = useI18n();
  const auth = useAuth();
  const { type, lookups, error: typeError } = useRecordType(key);
  const [rows, setRows] = useState<RecordItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<RecordItem | 'new' | null>(null);
  const [viewing, setViewing] = useState<RecordItem | null>(null);
  const [removing, setRemoving] = useState<RecordItem | null>(null);
  const [reason, setReason] = useState('');
  const pageSize = 25;

  const load = useCallback(() => {
    setLoading(true);
    api<{ items: RecordItem[]; total: number }>(`/records/${key}`, {
      query: { page, pageSize, ...(search === '' ? {} : { q: search }) },
    })
      .then((r) => {
        setRows(r.items);
        setTotal(r.total);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [key, page, search]);
  useEffect(load, [load]);

  const fields = useMemo(() => (type === null ? [] : activeFields(type)), [type]);
  const yes = t('common.yes');
  const no = t('common.no');
  const cell = useCallback(
    (f: FieldSpec, r: RecordItem) => displayValue(f, r.data[f.key], lookups, language, yes, no),
    [lookups, language, yes, no],
  );

  const columns: Column<RecordItem>[] = useMemo(() => {
    if (type === null) return [];
    // Columns from the list configuration; without one, the number and the first fields.
    const wanted =
      type.listConfig.columns.length > 0
        ? type.listConfig.columns
        : ['number', ...fields.slice(0, 4).map((f) => f.key)];
    const out: Column<RecordItem>[] = [];
    for (const c of wanted) {
      if ((LIST_BUILTIN_COLUMNS as readonly string[]).includes(c)) {
        out.push({
          key: c,
          header: t(`records.col.${c}` as 'records.col.number'),
          value: (r) =>
            c === 'number'
              ? r.number
              : c === 'state'
                ? r.stateCode
                : c === 'createdAt'
                  ? r.createdAt
                  : r.updatedAt,
        });
        continue;
      }
      const f = fields.find((x) => x.key === c);
      if (f !== undefined) {
        out.push({
          key: f.key,
          header: pick(f.label, language, f.key),
          value: (r) => cell(f, r),
          sortable: true,
        });
      }
    }
    return out;
  }, [type, fields, language, cell, t]);

  if (typeError !== null) return <ErrorAlert error={typeError} />;
  if (type === null) return <Skeleton />;

  const title = pick(type.name, language, type.key);
  const perm = (action: string) => auth.can(`custom.${type.key}.${action}`);

  const formFields: FormField[] = fields.map((f) => {
    const base = { name: f.key, label: pick(f.label, language, f.key) };
    if (f.type === 'boolean') return { ...base, type: 'checkbox' as const };
    if (f.type === 'dropdown') {
      return {
        ...base,
        type: 'select' as const,
        options: [
          { value: '', label: '-' },
          ...(lookups[f.lookupKey ?? ''] ?? []).map((l) => ({
            value: l.code,
            label: pick(l.labels, language, l.code),
          })),
        ],
      };
    }
    if (f.type === 'multi') return { ...base, hint: t('records.multiHint') };
    if (f.type === 'date') return { ...base, hint: 'YYYY-MM-DD' };
    return base;
  });

  /** Adapter so EntityForm runs the shared record check and shows each field's message. */
  const schema = {
    safeParse: (values: unknown) => {
      const data = formToData(fields, values as Record<string, unknown>);
      const issues = validateRecordData(type.jsonSchema, data);
      if (issues.length === 0) return { success: true as const, data };
      return {
        success: false as const,
        error: {
          issues: issues.map((i) => ({
            path: [i.path === '' ? 'form' : i.path],
            message: i.message,
          })),
        },
      };
    },
  };

  const sections = (layout: Layout) => sectionsOf(layout, fields, language);

  return (
    <>
      <PageHeader
        title={title}
        icon={Blocks}
        actions={
          perm('create') ? (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setViewing(null);
                setEditing('new');
              }}
            >
              {t('records.new', { name: title })}
            </Button>
          ) : null
        }
      />
      {editing !== null ? (
        <section className="card">
          <EntityForm
            key={editing === 'new' ? 'new' : `${editing.id}-${String(editing.version)}`}
            fields={formFields}
            schema={schema}
            initial={editing === 'new' ? dataToForm(fields, {}) : dataToForm(fields, editing.data)}
            onCancel={() => {
              setEditing(null);
            }}
            onSubmit={async (data) => {
              if (editing === 'new') {
                await api(`/records/${key}`, { method: 'POST', body: { data } });
              } else {
                // Cleared fields must be sent as null so the API removes them.
                const body: Record<string, unknown> = {};
                for (const f of fields) body[f.key] = data[f.key] ?? null;
                await api(`/records/${key}/${editing.id}`, {
                  method: 'PATCH',
                  body: { data: body },
                  headers: ifMatch(editing.version),
                });
              }
              setEditing(null);
              load();
            }}
          />
        </section>
      ) : null}
      {viewing !== null ? (
        <section className="card" aria-label={t('records.detail')}>
          <h2>{viewing.number ?? title}</h2>
          {sections(type.detailLayout).map((s, i) => (
            <div key={`${s.title}-${String(i)}`}>
              {s.title === '' ? null : <h3>{s.title}</h3>}
              {s.keys.map((k) => {
                const f = fields.find((x) => x.key === k);
                if (f === undefined) return null;
                return (
                  <Field
                    key={k}
                    label={pick(f.label, language, f.key)}
                    readOnly
                    value={cell(f, viewing)}
                    onChange={() => undefined}
                  />
                );
              })}
            </div>
          ))}
          <WorkflowTimeline entityType={key} entityId={viewing.id} />
          <Button
            variant="link"
            onClick={() => {
              setViewing(null);
            }}
          >
            {t('common.back')}
          </Button>
        </section>
      ) : null}
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        total={total}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        search={search}
        onSearch={(s) => {
          setPage(1);
          setSearch(s);
        }}
        loading={loading}
        error={error}
        exportName={type.key}
        actions={(r) => (
          <>
            <Button
              variant="link"
              onClick={() => {
                setEditing(null);
                setViewing(r);
              }}
            >
              {t('records.open')}
            </Button>
            {perm('update') ? (
              <Button
                variant="link"
                icon={Pencil}
                onClick={() => {
                  setViewing(null);
                  setEditing(r);
                }}
              >
                {t('common.edit')}
              </Button>
            ) : null}
            {perm('delete') ? (
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
      <ConfirmDialog
        open={removing !== null}
        danger
        title={t('common.delete')}
        onCancel={() => {
          setRemoving(null);
          setReason('');
        }}
        onConfirm={() => {
          if (removing === null || reason.trim() === '') return;
          api(`/records/${key}/${removing.id}`, {
            method: 'DELETE',
            body: { reason: reason.trim() },
            headers: ifMatch(removing.version),
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
        <p className="muted">{t('records.deleteBody')}</p>
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
