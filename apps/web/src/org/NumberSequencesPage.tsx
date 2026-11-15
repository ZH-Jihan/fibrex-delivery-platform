/**
 * Numbering sequences settings screen (phase 2 row 2.2): the patterns behind `L0001`-style
 * numbers, one row per key of the current company. List with the next number; create and
 * edit with a live sample rendered from the shared pattern rules (the same the API uses);
 * delete with a reason (the counter is kept in the recycle bin and carries on when
 * restored). The key never changes once created: modules allocate by it.
 * Depends on: api client, ui components, @fibrex/shared numbering. Used by: App.tsx routes.
 */
import { useCallback, useEffect, useState } from 'react';
import { Hash, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  numberSequenceFormSchema,
  patternProblem,
  renderNumber,
  RESET_POLICIES,
  type ResetPolicy,
} from '@fibrex/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, Field, PageHeader } from '../ui/components';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DataTable } from '../ui/DataTable';
import { EntityForm } from '../ui/EntityForm';
import { HistoryTab } from '../ui/HistoryTab';

interface SequenceRow {
  id: string;
  key: string;
  prefix: string;
  format: string;
  padding: number;
  resetPolicy: ResetPolicy;
  nextValue: number;
  sample: string;
  version: number;
}

/** The sample for values typed in the form, or the problem with the pattern. */
export function liveSample(values: {
  prefix: string;
  format: string;
  padding: number;
  resetPolicy: ResetPolicy;
  nextValue: number;
}): { sample: string } | { problem: string } {
  const problem = patternProblem(values.format, values.resetPolicy);
  if (problem !== null) return { problem };
  return {
    sample: renderNumber(values.format, {
      prefix: values.prefix,
      padding: values.padding,
      value: values.nextValue,
      date: new Date(),
    }),
  };
}

export function NumberSequencesPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: SequenceRow[]; total: number }>({
    items: [],
    total: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<SequenceRow | 'new' | null>(null);
  const [removing, setRemoving] = useState<SequenceRow | null>(null);
  const [reason, setReason] = useState('');
  const pageSize = 25;

  const load = useCallback(() => {
    setLoading(true);
    api<{ items: SequenceRow[]; total: number }>('/number-sequences', {
      query: { page, pageSize },
    })
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

  const resetLabel = (p: ResetPolicy) => t(`numbering.reset.${p}`);
  const fields = [
    {
      name: 'key',
      label: t('numbering.key'),
      hint: t('numbering.keyHint'),
      readOnly: editing !== 'new',
    },
    { name: 'format', label: t('numbering.format'), hint: t('numbering.formatHint') },
    { name: 'prefix', label: t('numbering.prefix') },
    { name: 'padding', label: t('numbering.padding'), hint: t('numbering.paddingHint') },
    {
      name: 'resetPolicy',
      label: t('numbering.reset'),
      type: 'select' as const,
      options: RESET_POLICIES.map((p) => ({ value: p, label: resetLabel(p) })),
    },
    { name: 'nextValue', label: t('numbering.nextValue'), hint: t('numbering.nextValueHint') },
  ];

  return (
    <>
      <PageHeader
        title={t('numbering.title')}
        icon={Hash}
        description={t('numbering.intro')}
        actions={
          auth.can('platform.number_sequence.create') ? (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setEditing('new');
              }}
            >
              {t('numbering.new')}
            </Button>
          ) : null
        }
      />
      {editing !== null ? (
        <section className="card">
          <EntityForm
            key={editing === 'new' ? 'new' : `${editing.id}-${String(editing.version)}`}
            fields={fields}
            schema={numberSequenceFormSchema}
            initial={
              editing === 'new'
                ? { key: '', prefix: '', format: '{0000}', padding: 4, resetPolicy: 'never', nextValue: 1 }
                : {
                    key: editing.key,
                    prefix: editing.prefix,
                    format: editing.format,
                    padding: editing.padding,
                    resetPolicy: editing.resetPolicy,
                    nextValue: editing.nextValue,
                  }
            }
            onCancel={() => {
              setEditing(null);
            }}
            onSubmit={async (values) => {
              if (editing === 'new') {
                await api('/number-sequences', { method: 'POST', body: values });
              } else {
                // The key is the identity of the sequence and is not sent on an update.
                const changes = Object.fromEntries(
                  Object.entries(values).filter(([name]) => name !== 'key'),
                );
                await api(`/number-sequences/${editing.id}`, {
                  method: 'PATCH',
                  body: changes,
                  headers: { 'If-Match': `"${String(editing.version)}"` },
                });
              }
              setEditing(null);
              load();
            }}
          />
          {editing !== 'new' ? (
            <>
              <p className="muted">
                {t('numbering.next')}: <strong>{editing.sample}</strong>
              </p>
              <h2>{t('history.title')}</h2>
              <HistoryTab entityType="platform.number_sequence" entityId={editing.id} />
            </>
          ) : null}
        </section>
      ) : null}
      <DataTable
        columns={[
          { key: 'key', header: t('numbering.key'), value: (r) => r.key },
          { key: 'format', header: t('numbering.format'), value: (r) => r.format },
          { key: 'sample', header: t('numbering.next'), value: (r) => r.sample },
          { key: 'reset', header: t('numbering.reset'), value: (r) => resetLabel(r.resetPolicy) },
        ]}
        rows={data.items}
        rowKey={(r) => r.id}
        total={data.total}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        loading={loading}
        error={error}
        exportName="number-sequences"
        actions={(r) => (
          <>
            {auth.can('platform.number_sequence.update') ? (
              <Button
                variant="link"
                icon={Pencil}
                onClick={() => {
                  setEditing(r);
                }}
              >
                {t('common.edit')}
              </Button>
            ) : null}
            {auth.can('platform.number_sequence.delete') ? (
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
        }}
        onConfirm={() => {
          if (removing === null || reason.trim() === '') return;
          api(`/number-sequences/${removing.id}`, {
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
        <p className="muted">{t('numbering.deleteHint')}</p>
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
