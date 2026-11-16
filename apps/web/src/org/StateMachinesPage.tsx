/**
 * State machines screen (phase 2 row 2.10; PLAN 3.7 `state_machine`, `state`,
 * `state_transition`).
 *
 * Flow: pick or create a machine for a record type -> its states (code, label, category,
 * which one records start in, which ones are final) and its transitions (from, to, the
 * permission the move needs, the fields that must be filled in first, whether a reason is
 * needed and from which list). The server enforces the rules (one first state, nothing
 * leaves a final state, a state in use is not deleted); this screen checks the forms with
 * the shared schemas and shows the server's answer otherwise. A transition's ends cannot
 * be edited: delete it and add another.
 *
 * Depends on: api client, auth, i18n, ui components, @fibrex/shared (state schemas).
 * Used by: App.tsx routes.
 */
import { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, Save, Trash2, Workflow } from 'lucide-react';
import {
  STATE_CATEGORIES,
  stateFormSchema,
  stateMachineFormSchema,
  stateTransitionFormSchema,
  type StateCategory,
} from '@fibrex/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, Checkbox, ErrorAlert, Field, PageHeader, Select } from '../ui/components';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DataTable } from '../ui/DataTable';

interface Machine {
  id: string;
  entityKey: string;
  name: string;
  version: number;
}
interface StateRow {
  id: string;
  code: string;
  labels: Record<string, string>;
  category: StateCategory;
  isInitial: boolean;
  isFinal: boolean;
  colour: string | null;
  sortOrder: number;
  version: number;
}
interface TransitionRow {
  id: string;
  fromCode: string;
  toCode: string;
  permissionKey: string | null;
  requiredFields: string[];
  reasonRequired: boolean;
  reasonLookupTypeId: string | null;
  version: number;
}
interface LookupList {
  id: string;
  name: string;
}
interface StateForm {
  code: string;
  label: string;
  category: StateCategory;
  isInitial: boolean;
  isFinal: boolean;
  colour: string;
}
interface TransitionForm {
  fromCode: string;
  toCode: string;
  permissionKey: string;
  requiredFields: string;
  reasonRequired: boolean;
  reasonLookupTypeId: string;
}

const ifMatch = (version: number) => ({ 'If-Match': `"${String(version)}"` });
const emptyState = (): StateForm => ({
  code: '',
  label: '',
  category: 'open',
  isInitial: false,
  isFinal: false,
  colour: '',
});
const emptyTransition = (): TransitionForm => ({
  fromCode: '',
  toCode: '',
  permissionKey: '',
  requiredFields: '',
  reasonRequired: false,
  reasonLookupTypeId: '',
});

/** "plate, seats" -> ["plate", "seats"]. */
export function splitFields(text: string): string[] {
  return text
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f !== '');
}

/** The API body of a state form: an empty colour means none. */
export function stateBody(form: StateForm, labels: Record<string, string> = {}) {
  return {
    code: form.code.trim(),
    labels: { ...labels, en: form.label.trim() },
    category: form.category,
    isInitial: form.isInitial,
    isFinal: form.isFinal,
    colour: form.colour.trim() === '' ? null : form.colour.trim(),
  };
}

/** The API body of a transition form: empty boxes mean "none". */
export function transitionBody(form: TransitionForm) {
  return {
    fromCode: form.fromCode,
    toCode: form.toCode,
    permissionKey: form.permissionKey.trim() === '' ? null : form.permissionKey.trim(),
    requiredFields: splitFields(form.requiredFields),
    reasonRequired: form.reasonRequired,
    reasonLookupTypeId: form.reasonLookupTypeId === '' ? null : form.reasonLookupTypeId,
  };
}

type Removing = { kind: 'state'; row: StateRow } | { kind: 'transition'; row: TransitionRow };

export function StateMachinesPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ entityKey: '', name: '' });
  const [selected, setSelected] = useState<Machine | null>(null);
  const [states, setStates] = useState<StateRow[]>([]);
  const [transitions, setTransitions] = useState<TransitionRow[]>([]);
  const [lists, setLists] = useState<LookupList[]>([]);
  const [stateForm, setStateForm] = useState<StateForm | null>(null);
  const [editing, setEditing] = useState<StateRow | null>(null);
  const [transitionForm, setTransitionForm] = useState<TransitionForm | null>(null);
  const [removing, setRemoving] = useState<Removing | null>(null);
  const [reason, setReason] = useState('');
  const canReadLists = auth.can('platform.lookup_type.read');

  const loadMachines = useCallback(() => {
    setLoading(true);
    api<{ items: Machine[] }>('/state-machines', { query: { page: 1, pageSize: 200 } })
      .then((r) => {
        setMachines(r.items);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);
  useEffect(loadMachines, [loadMachines]);

  const loadParts = useCallback((machine: Machine | null) => {
    if (machine === null) {
      setStates([]);
      setTransitions([]);
      return;
    }
    const query = { stateMachineId: machine.id, page: 1, pageSize: 200 };
    Promise.all([
      api<{ items: StateRow[] }>('/states', { query }),
      api<{ items: TransitionRow[] }>('/state-transitions', { query }),
    ])
      .then(([s, tr]) => {
        setStates([...s.items].sort((a, b) => a.sortOrder - b.sortOrder));
        setTransitions(tr.items);
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, []);
  useEffect(() => {
    loadParts(selected);
  }, [selected, loadParts]);

  // Reason lists for the transition form; only for people allowed to see lookup lists.
  useEffect(() => {
    if (!canReadLists) return;
    api<{ items: LookupList[] }>('/lookup-types', { query: { page: 1, pageSize: 200 } })
      .then((r) => {
        setLists(r.items);
      })
      .catch(() => {
        setLists([]);
      });
  }, [canReadLists]);

  const run = (job: Promise<unknown>, after?: () => void) => {
    job
      .then(() => {
        setError(null);
        after?.();
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };

  const createMachine = () => {
    const checked = stateMachineFormSchema.safeParse(draft);
    if (!checked.success) {
      setProblem(t('states.entityKeyHint'));
      return;
    }
    run(api('/state-machines', { method: 'POST', body: checked.data }), () => {
      setCreating(false);
      setProblem(null);
      setDraft({ entityKey: '', name: '' });
      loadMachines();
    });
  };

  const saveState = () => {
    if (selected === null || stateForm === null) return;
    const body = stateBody(stateForm, editing?.labels);
    const checked = stateFormSchema.safeParse(body);
    if (!checked.success) {
      setProblem(checked.error.issues[0]?.message ?? t('states.code'));
      return;
    }
    setProblem(null);
    const changes = {
      labels: body.labels,
      category: body.category,
      isInitial: body.isInitial,
      isFinal: body.isFinal,
      colour: body.colour,
    };
    const job =
      editing === null
        ? api('/states', {
            method: 'POST',
            body: { ...body, stateMachineId: selected.id, sortOrder: (states.length + 1) * 10 },
          })
        : // The code never changes; only the rest is sent.
          api(`/states/${editing.id}`, {
            method: 'PATCH',
            headers: ifMatch(editing.version),
            body: changes,
          });
    run(job, () => {
      setStateForm(null);
      setEditing(null);
      loadParts(selected);
    });
  };

  const saveTransition = () => {
    if (selected === null || transitionForm === null) return;
    const body = transitionBody(transitionForm);
    const checked = stateTransitionFormSchema.safeParse(body);
    if (!checked.success) {
      setProblem(checked.error.issues[0]?.message ?? t('states.transitions'));
      return;
    }
    setProblem(null);
    run(
      api('/state-transitions', {
        method: 'POST',
        body: { ...body, stateMachineId: selected.id },
      }),
      () => {
        setTransitionForm(null);
        loadParts(selected);
      },
    );
  };

  const labelOf = (code: string) => states.find((s) => s.code === code)?.labels.en ?? code;
  const stateOptions = states.map((s) => ({ value: s.code, label: s.labels.en ?? s.code }));
  const listName = (id: string | null) =>
    id === null ? '' : (lists.find((l) => l.id === id)?.name ?? t('states.reasonList'));

  return (
    <>
      <PageHeader
        title={t('states.title')}
        icon={Workflow}
        description={t('states.intro')}
        actions={
          auth.can('platform.state_machine.create') ? (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setCreating(true);
                setProblem(null);
              }}
            >
              {t('states.new')}
            </Button>
          ) : null
        }
      />
      {error !== null && !loading ? <ErrorAlert error={error} /> : null}
      {creating ? (
        <section className="card" aria-label={t('states.new')}>
          <Field
            label={t('states.entityKey')}
            hint={t('states.entityKeyHint')}
            value={draft.entityKey}
            onChange={(e) => {
              setDraft({ ...draft, entityKey: e.target.value });
            }}
          />
          <Field
            label={t('states.name')}
            value={draft.name}
            onChange={(e) => {
              setDraft({ ...draft, name: e.target.value });
            }}
          />
          {problem === null ? null : (
            <p className="field-error" role="alert">
              {problem}
            </p>
          )}
          <Button variant="primary" icon={Save} onClick={createMachine}>
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
          { key: 'entityKey', header: t('states.entityKey'), value: (r) => r.entityKey },
          { key: 'name', header: t('states.name'), value: (r) => r.name },
        ]}
        rows={machines}
        rowKey={(r) => r.id}
        total={machines.length}
        page={1}
        pageSize={200}
        onPageChange={() => undefined}
        loading={loading}
        error={null}
        exportName="state-machines"
        actions={(r) => (
          <Button
            variant="link"
            icon={Pencil}
            onClick={() => {
              setSelected(r);
              setStateForm(null);
              setEditing(null);
              setTransitionForm(null);
              setProblem(null);
            }}
          >
            {t('states.states')}
          </Button>
        )}
      />
      {selected !== null ? (
        <section className="card" aria-label={t('states.statesOf', { name: selected.name })}>
          <h2>{t('states.statesOf', { name: selected.name })}</h2>
          {auth.can('platform.state.create') ? (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setEditing(null);
                setStateForm(emptyState());
                setProblem(null);
              }}
            >
              {t('states.addState')}
            </Button>
          ) : null}
          <DataTable
            columns={[
              { key: 'code', header: t('states.code'), value: (r: StateRow) => r.code },
              {
                key: 'label',
                header: t('states.label'),
                value: (r: StateRow) => r.labels.en ?? '',
              },
              {
                key: 'category',
                header: t('states.category'),
                value: (r: StateRow) => t(`states.category.${r.category}`),
              },
              {
                key: 'role',
                header: t('states.role'),
                value: (r: StateRow) =>
                  r.isInitial ? t('states.initial') : r.isFinal ? t('states.final') : '',
              },
            ]}
            rows={states}
            rowKey={(r) => r.id}
            total={states.length}
            page={1}
            pageSize={200}
            onPageChange={() => undefined}
            loading={false}
            error={null}
            exportName="states"
            actions={(r) => (
              <>
                {auth.can('platform.state.update') ? (
                  <Button
                    variant="link"
                    icon={Pencil}
                    onClick={() => {
                      setEditing(r);
                      setStateForm({
                        code: r.code,
                        label: r.labels.en ?? '',
                        category: r.category,
                        isInitial: r.isInitial,
                        isFinal: r.isFinal,
                        colour: r.colour ?? '',
                      });
                      setProblem(null);
                    }}
                  >
                    {t('common.edit')}
                  </Button>
                ) : null}
                {auth.can('platform.state.delete') ? (
                  <Button
                    variant="link"
                    dangerText
                    icon={Trash2}
                    onClick={() => {
                      setRemoving({ kind: 'state', row: r });
                    }}
                  >
                    {t('common.delete')}
                  </Button>
                ) : null}
              </>
            )}
          />
          {stateForm === null ? null : (
            <div
              role="region"
              aria-label={editing === null ? t('states.addState') : t('states.editState')}
            >
              <h3>{editing === null ? t('states.addState') : t('states.editState')}</h3>
              <Field
                label={t('states.code')}
                hint={t('states.codeHint')}
                value={stateForm.code}
                readOnly={editing !== null}
                onChange={(e) => {
                  setStateForm({ ...stateForm, code: e.target.value });
                }}
              />
              <Field
                label={t('states.label')}
                value={stateForm.label}
                onChange={(e) => {
                  setStateForm({ ...stateForm, label: e.target.value });
                }}
              />
              <Select
                label={t('states.category')}
                hint={t('states.categoryHint')}
                value={stateForm.category}
                options={STATE_CATEGORIES.map((c) => ({
                  value: c,
                  label: t(`states.category.${c}`),
                }))}
                onChange={(e) => {
                  setStateForm({ ...stateForm, category: e.target.value as StateCategory });
                }}
              />
              <Checkbox
                label={t('states.isInitial')}
                checked={stateForm.isInitial}
                onChange={(e) => {
                  setStateForm({ ...stateForm, isInitial: e.target.checked });
                }}
              />
              <Checkbox
                label={t('states.isFinal')}
                checked={stateForm.isFinal}
                onChange={(e) => {
                  setStateForm({ ...stateForm, isFinal: e.target.checked });
                }}
              />
              <Field
                label={t('states.colour')}
                hint={t('states.colourHint')}
                value={stateForm.colour}
                onChange={(e) => {
                  setStateForm({ ...stateForm, colour: e.target.value });
                }}
              />
              {problem === null ? null : (
                <p className="field-error" role="alert">
                  {problem}
                </p>
              )}
              <Button variant="primary" icon={Save} onClick={saveState}>
                {t('common.save')}
              </Button>
              <Button
                onClick={() => {
                  setStateForm(null);
                  setEditing(null);
                }}
              >
                {t('common.cancel')}
              </Button>
            </div>
          )}

          <h2>{t('states.transitions')}</h2>
          {auth.can('platform.state_transition.create') ? (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setTransitionForm(emptyTransition());
                setProblem(null);
              }}
            >
              {t('states.addTransition')}
            </Button>
          ) : null}
          <DataTable
            columns={[
              {
                key: 'from',
                header: t('states.from'),
                value: (r: TransitionRow) => labelOf(r.fromCode),
              },
              { key: 'to', header: t('states.to'), value: (r: TransitionRow) => labelOf(r.toCode) },
              {
                key: 'permission',
                header: t('states.permission'),
                value: (r: TransitionRow) => r.permissionKey ?? t('states.permissionDefault'),
              },
              {
                key: 'required',
                header: t('states.requiredFields'),
                value: (r: TransitionRow) => r.requiredFields.join(', '),
              },
              {
                key: 'reason',
                header: t('states.reason'),
                value: (r: TransitionRow) =>
                  r.reasonRequired
                    ? r.reasonLookupTypeId === null
                      ? t('states.reasonNote')
                      : listName(r.reasonLookupTypeId)
                    : '',
              },
            ]}
            rows={transitions}
            rowKey={(r) => r.id}
            total={transitions.length}
            page={1}
            pageSize={200}
            onPageChange={() => undefined}
            loading={false}
            error={null}
            exportName="state-transitions"
            actions={(r) =>
              auth.can('platform.state_transition.delete') ? (
                <Button
                  variant="link"
                  dangerText
                  icon={Trash2}
                  onClick={() => {
                    setRemoving({ kind: 'transition', row: r });
                  }}
                >
                  {t('common.delete')}
                </Button>
              ) : null
            }
          />
          {transitionForm === null ? null : (
            <div role="region" aria-label={t('states.addTransition')}>
              <h3>{t('states.addTransition')}</h3>
              <Select
                label={t('states.from')}
                placeholder={t('states.choose')}
                value={transitionForm.fromCode}
                options={stateOptions.filter(
                  (o) => states.find((s) => s.code === o.value)?.isFinal !== true,
                )}
                onChange={(e) => {
                  setTransitionForm({ ...transitionForm, fromCode: e.target.value });
                }}
              />
              <Select
                label={t('states.to')}
                placeholder={t('states.choose')}
                value={transitionForm.toCode}
                options={stateOptions}
                onChange={(e) => {
                  setTransitionForm({ ...transitionForm, toCode: e.target.value });
                }}
              />
              <Field
                label={t('states.permission')}
                hint={t('states.permissionHint')}
                value={transitionForm.permissionKey}
                onChange={(e) => {
                  setTransitionForm({ ...transitionForm, permissionKey: e.target.value });
                }}
              />
              <Field
                label={t('states.requiredFields')}
                hint={t('states.requiredFieldsHint')}
                value={transitionForm.requiredFields}
                onChange={(e) => {
                  setTransitionForm({ ...transitionForm, requiredFields: e.target.value });
                }}
              />
              <Checkbox
                label={t('states.reasonRequired')}
                checked={transitionForm.reasonRequired}
                onChange={(e) => {
                  setTransitionForm({ ...transitionForm, reasonRequired: e.target.checked });
                }}
              />
              {canReadLists ? (
                <Select
                  label={t('states.reasonList')}
                  hint={t('states.reasonListHint')}
                  placeholder={t('states.reasonNote')}
                  value={transitionForm.reasonLookupTypeId}
                  options={lists.map((l) => ({ value: l.id, label: l.name }))}
                  onChange={(e) => {
                    setTransitionForm({ ...transitionForm, reasonLookupTypeId: e.target.value });
                  }}
                />
              ) : null}
              {problem === null ? null : (
                <p className="field-error" role="alert">
                  {problem}
                </p>
              )}
              <Button variant="primary" icon={Save} onClick={saveTransition}>
                {t('common.save')}
              </Button>
              <Button
                onClick={() => {
                  setTransitionForm(null);
                }}
              >
                {t('common.cancel')}
              </Button>
            </div>
          )}
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
          const target = removing;
          setRemoving(null);
          setReason('');
          const path = target.kind === 'state' ? '/states' : '/state-transitions';
          run(
            api(`${path}/${target.row.id}`, {
              method: 'DELETE',
              body: { reason: reason.trim() },
              headers: ifMatch(target.row.version),
            }),
            () => {
              loadParts(selected);
            },
          );
        }}
      >
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
