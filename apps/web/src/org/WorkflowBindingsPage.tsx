/**
 * Workflow bindings (phase 2 row 2.11c; PLAN 5.9 "Workflow", bindings).
 *
 * Purpose: decide which workflow starts by itself, and when: on create of a record, on a
 * move into a named state (optionally only when a yes/no formula is true), or only by hand.
 * The binding takes its record type from its workflow; the server checks the state and the
 * formula exist and shows its answer. A binding can be switched off without deleting it.
 *
 * Depends on: api client, auth, i18n, ui components, @fibrex/shared (trigger list).
 * Used by: App.tsx route /organisation/workflow-bindings.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link2, Plus, Save } from 'lucide-react';
import { WORKFLOW_TRIGGERS } from '@fibrex/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, ErrorAlert, Field, PageHeader, Select } from '../ui/components';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DataTable } from '../ui/DataTable';

type Trigger = (typeof WORKFLOW_TRIGGERS)[number];
interface Binding {
  id: string;
  entityKey: string;
  trigger: Trigger;
  toStateCode: string | null;
  workflowDefinitionId: string;
  conditionFormulaKey: string | null;
  active: boolean;
  version: number;
}
interface Definition {
  id: string;
  key: string;
  name: string;
}

const ifMatch = (version: number) => ({ 'If-Match': `"${String(version)}"` });

/** The create body from the form: state only for "on_transition", empty boxes become null. */
export function bindingBody(form: {
  workflowDefinitionId: string;
  trigger: Trigger;
  toStateCode: string;
  conditionFormulaKey: string;
}): Record<string, unknown> {
  return {
    workflowDefinitionId: form.workflowDefinitionId,
    trigger: form.trigger,
    toStateCode:
      form.trigger === 'on_transition' && form.toStateCode.trim() !== ''
        ? form.toStateCode.trim()
        : null,
    conditionFormulaKey:
      form.conditionFormulaKey.trim() === '' ? null : form.conditionFormulaKey.trim(),
  };
}

export function WorkflowBindingsPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const [rows, setRows] = useState<Binding[]>([]);
  const [defs, setDefs] = useState<Definition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<Binding | null>(null);
  const [reason, setReason] = useState('');
  const [form, setForm] = useState({
    workflowDefinitionId: '',
    trigger: 'on_create' as Trigger,
    toStateCode: '',
    conditionFormulaKey: '',
  });

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api<{ items: Binding[] }>('/workflow-bindings', { query: { page: 1, pageSize: 200 } }),
      api<{ items: Definition[] }>('/workflow-definitions', { query: { page: 1, pageSize: 200 } }),
    ])
      .then(([b, d]) => {
        setRows(b.items);
        setDefs(d.items);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);
  useEffect(load, [load]);

  const run = (job: Promise<unknown>, after: () => void) => {
    job
      .then(() => {
        setError(null);
        after();
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };
  const nameOf = (id: string) => defs.find((d) => d.id === id)?.name ?? id;
  const canEdit = auth.can('platform.workflow_binding.update');

  return (
    <>
      <PageHeader
        title={t('wf.bindingsTitle')}
        icon={Link2}
        description={t('wf.bindingsIntro')}
        actions={
          auth.can('platform.workflow_binding.create') ? (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setCreating(true);
              }}
            >
              {t('wf.newBinding')}
            </Button>
          ) : null
        }
      />
      {error !== null && !loading ? <ErrorAlert error={error} /> : null}
      {creating ? (
        <section className="card" aria-label={t('wf.newBinding')}>
          <Select
            label={t('wf.workflow')}
            placeholder={t('wf.choosePerson')}
            value={form.workflowDefinitionId}
            options={defs.map((d) => ({ value: d.id, label: `${d.name} (${d.key})` }))}
            onChange={(e) => {
              setForm({ ...form, workflowDefinitionId: e.target.value });
            }}
          />
          <Select
            label={t('wf.trigger')}
            value={form.trigger}
            options={WORKFLOW_TRIGGERS.map((k) => ({ value: k, label: t(`wf.trigger.${k}`) }))}
            onChange={(e) => {
              setForm({ ...form, trigger: e.target.value as Trigger });
            }}
          />
          {form.trigger === 'on_transition' ? (
            <Field
              label={t('wf.toState')}
              value={form.toStateCode}
              onChange={(e) => {
                setForm({ ...form, toStateCode: e.target.value });
              }}
            />
          ) : null}
          <Field
            label={t('wf.condition')}
            value={form.conditionFormulaKey}
            onChange={(e) => {
              setForm({ ...form, conditionFormulaKey: e.target.value });
            }}
          />
          <Button
            variant="primary"
            icon={Save}
            disabled={form.workflowDefinitionId === ''}
            onClick={() => {
              run(api('/workflow-bindings', { method: 'POST', body: bindingBody(form) }), () => {
                setCreating(false);
                load();
              });
            }}
          >
            {t('common.save')}
          </Button>
          <Button
            onClick={() => {
              setCreating(false);
            }}
          >
            {t('common.cancel')}
          </Button>
        </section>
      ) : null}
      <DataTable
        columns={[
          {
            key: 'wf',
            header: t('wf.workflow'),
            value: (r: Binding) => nameOf(r.workflowDefinitionId),
          },
          { key: 'entity', header: t('wf.entityKey'), value: (r: Binding) => r.entityKey },
          {
            key: 'trigger',
            header: t('wf.trigger'),
            value: (r: Binding) => t(`wf.trigger.${r.trigger}`),
          },
          { key: 'state', header: t('wf.toState'), value: (r: Binding) => r.toStateCode },
          { key: 'cond', header: t('wf.condition'), value: (r: Binding) => r.conditionFormulaKey },
          { key: 'active', header: t('wf.active'), value: (r: Binding) => r.active },
        ]}
        rows={rows}
        rowKey={(r) => r.id}
        total={rows.length}
        page={1}
        pageSize={200}
        onPageChange={() => undefined}
        loading={loading}
        error={null}
        exportName="workflow-bindings"
        actions={(r) => (
          <>
            {canEdit ? (
              <Button
                variant="link"
                onClick={() => {
                  run(
                    api(`/workflow-bindings/${r.id}`, {
                      method: 'PATCH',
                      headers: ifMatch(r.version),
                      body: { active: !r.active },
                    }),
                    load,
                  );
                }}
              >
                {r.active ? t('wf.deactivate') : t('wf.activate')}
              </Button>
            ) : null}
            {auth.can('platform.workflow_binding.delete') ? (
              <Button
                variant="link"
                dangerText
                onClick={() => {
                  setRemoving(r);
                  setReason('');
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
        confirmLabel={t('common.delete')}
        onConfirm={() => {
          if (removing === null || reason.trim() === '') return;
          run(
            api(`/workflow-bindings/${removing.id}`, {
              method: 'DELETE',
              body: { reason: reason.trim() },
              headers: ifMatch(removing.version),
            }),
            () => {
              setRemoving(null);
              load();
            },
          );
        }}
        onCancel={() => {
          setRemoving(null);
        }}
      >
        <Field
          label={t('wf.deleteReason')}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
          }}
        />
      </ConfirmDialog>
    </>
  );
}
