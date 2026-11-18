/**
 * Stand-ins (phase 2 row 2.11c; PLAN 5.9 "Workflow", delegation).
 *
 * Purpose: self-service delegation. Anyone with the delegation permissions names a stand-in
 * for a period (optionally only for some workflows); while it runs, their approval tasks also
 * appear in the stand-in's inbox. An ordinary user lists and changes only the stand-ins they
 * gave (and sees those given to them); a holder of `platform.workflow_delegation.manage_all`
 * can also name the away person. The server enforces this; the screen only hides what would
 * be refused.
 *
 * Depends on: api client, auth, i18n, ui components, @fibrex/shared (workflow key schema).
 * Used by: App.tsx route /delegations.
 */
import { useCallback, useEffect, useState } from 'react';
import { Plus, Save, UserRoundCheck } from 'lucide-react';
import { workflowKeySchema } from '@fibrex/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, ErrorAlert, Field, PageHeader, Select } from '../ui/components';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DataTable } from '../ui/DataTable';

interface Delegation {
  id: string;
  userId: string;
  delegateUserId: string;
  validFrom: string;
  validTo: string;
  scope: { definitionKeys?: string[] };
  note: string | null;
  version: number;
}
interface Person {
  id: string;
  displayName: string;
}

/** The request body of the form, or the first problem in plain words. */
export function delegationBody(input: {
  userId: string;
  delegateUserId: string;
  validFrom: string;
  validTo: string;
  keys: string;
  note: string;
}): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
  if (input.delegateUserId === '') return { ok: false, message: 'wf.choosePerson' };
  if (input.validFrom === '' || input.validTo === '') return { ok: false, message: 'wf.validFrom' };
  if (input.validTo < input.validFrom) return { ok: false, message: 'wf.validTo' };
  const keys = input.keys
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k !== '');
  for (const key of keys) {
    if (!workflowKeySchema.safeParse(key).success) return { ok: false, message: 'wf.scopeKeys' };
  }
  const note = input.note.trim();
  return {
    ok: true,
    body: {
      userId: input.userId,
      delegateUserId: input.delegateUserId,
      validFrom: input.validFrom,
      validTo: input.validTo,
      scope: keys.length > 0 ? { definitionKeys: keys } : {},
      note: note === '' ? null : note,
    },
  };
}

export function DelegationsPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const [rows, setRows] = useState<Delegation[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<Delegation | null>(null);
  const [reason, setReason] = useState('');
  const [form, setForm] = useState({
    userId: '',
    delegateUserId: '',
    validFrom: '',
    validTo: '',
    keys: '',
    note: '',
  });
  const canAll = auth.can('platform.workflow_delegation.manage_all');
  const me = auth.grant?.user.id ?? '';

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api<{ items: Delegation[] }>('/delegations', { query: { page: 1, pageSize: 200 } }),
      api<{ items: Person[] }>('/workflow-people'),
    ])
      .then(([d, p]) => {
        setRows(d.items);
        setPeople(p.items);
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

  const nameOf = (id: string) => people.find((p) => p.id === id)?.displayName ?? id;

  const save = () => {
    const checked = delegationBody({
      ...form,
      userId: canAll && form.userId !== '' ? form.userId : me,
    });
    if (!checked.ok) {
      setProblem(t(checked.message as 'wf.choosePerson'));
      return;
    }
    setProblem(null);
    api('/delegations', { method: 'POST', body: checked.body })
      .then(() => {
        setCreating(false);
        setForm({ userId: '', delegateUserId: '', validFrom: '', validTo: '', keys: '', note: '' });
        load();
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };

  const remove = () => {
    if (removing === null || reason.trim() === '') return;
    api(`/delegations/${removing.id}`, {
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
        setError(e);
      });
  };

  const mayChange = (row: Delegation) => canAll || row.userId === me;
  const others = people.filter((p) => p.id !== (form.userId !== '' && canAll ? form.userId : me));

  return (
    <>
      <PageHeader
        title={t('wf.delegationsTitle')}
        icon={UserRoundCheck}
        description={t('wf.delegationsIntro')}
        actions={
          auth.can('platform.workflow_delegation.create') ? (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setCreating(true);
                setProblem(null);
              }}
            >
              {t('wf.newDelegation')}
            </Button>
          ) : null
        }
      />
      {error !== null && !loading ? <ErrorAlert error={error} /> : null}
      {creating ? (
        <section className="card" aria-label={t('wf.newDelegation')}>
          {canAll ? (
            <Select
              label={t('wf.delegator')}
              placeholder={nameOf(me)}
              value={form.userId}
              options={people.map((p) => ({ value: p.id, label: p.displayName }))}
              onChange={(e) => {
                setForm({ ...form, userId: e.target.value });
              }}
            />
          ) : null}
          <Select
            label={t('wf.standIn')}
            placeholder={t('wf.choosePerson')}
            value={form.delegateUserId}
            options={others.map((p) => ({ value: p.id, label: p.displayName }))}
            onChange={(e) => {
              setForm({ ...form, delegateUserId: e.target.value });
            }}
          />
          <Field
            type="date"
            label={t('wf.validFrom')}
            value={form.validFrom}
            onChange={(e) => {
              setForm({ ...form, validFrom: e.target.value });
            }}
          />
          <Field
            type="date"
            label={t('wf.validTo')}
            value={form.validTo}
            onChange={(e) => {
              setForm({ ...form, validTo: e.target.value });
            }}
          />
          <Field
            label={t('wf.scopeKeys')}
            hint={t('wf.scopeHint')}
            value={form.keys}
            onChange={(e) => {
              setForm({ ...form, keys: e.target.value });
            }}
          />
          <Field
            label={t('wf.note')}
            value={form.note}
            onChange={(e) => {
              setForm({ ...form, note: e.target.value });
            }}
          />
          {problem === null ? null : (
            <p className="field-error" role="alert">
              {problem}
            </p>
          )}
          <Button variant="primary" icon={Save} onClick={save}>
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
          { key: 'who', header: t('wf.delegator'), value: (r: Delegation) => nameOf(r.userId) },
          {
            key: 'standIn',
            header: t('wf.standIn'),
            value: (r: Delegation) => nameOf(r.delegateUserId),
          },
          { key: 'from', header: t('wf.validFrom'), value: (r: Delegation) => r.validFrom },
          { key: 'to', header: t('wf.validTo'), value: (r: Delegation) => r.validTo },
          {
            key: 'scope',
            header: t('wf.scopeKeys'),
            value: (r: Delegation) =>
              r.scope.definitionKeys?.length
                ? r.scope.definitionKeys.join(', ')
                : t('wf.allWorkflows'),
          },
        ]}
        rows={rows}
        rowKey={(r) => r.id}
        total={rows.length}
        page={1}
        pageSize={200}
        onPageChange={() => undefined}
        loading={loading}
        error={null}
        exportName="delegations"
        actions={(r) =>
          mayChange(r) && auth.can('platform.workflow_delegation.delete') ? (
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
          ) : null
        }
      />
      <ConfirmDialog
        open={removing !== null}
        danger
        confirmLabel={t('common.delete')}
        onConfirm={remove}
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
