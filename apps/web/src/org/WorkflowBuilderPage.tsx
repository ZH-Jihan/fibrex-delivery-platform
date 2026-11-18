/**
 * Workflow builder (phase 2 row 2.11b; PLAN 5.9 "Workflow").
 *
 * Flow: pick or create a workflow for a record type -> see its versions -> edit the draft
 * (or start one from the newest version): the steps in order (approval, condition, notify;
 * a parallel group made elsewhere is kept as it is), the states to move to when it is
 * approved or rejected -> save the draft -> publish. A published version is never edited:
 * running workflows keep theirs. The graph is checked here with the shared schema and
 * `checkWorkflowGraph`; the server checks it again against the formulas and states that
 * exist, and its answer is shown.
 *
 * Depends on: api client, auth, i18n, ui components, @fibrex/shared (workflow schemas).
 * Used by: App.tsx route /organisation/workflows.
 */
import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, GitBranch, Plus, Save, Send, Trash2 } from 'lucide-react';
import { checkWorkflowGraph, workflowGraphSchema, type WorkflowStep } from '@fibrex/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, Checkbox, ErrorAlert, Field, PageHeader, Select } from '../ui/components';
import { DataTable } from '../ui/DataTable';

interface Definition {
  id: string;
  key: string;
  name: string;
  entityKey: string;
}
interface VersionRow {
  id: string;
  versionNo: number;
  graph: unknown;
  status: 'draft' | 'published' | 'retired';
  version: number;
}
export interface StepForm {
  kind: 'approval' | 'condition' | 'notify';
  key: string;
  name: string;
  roles: string;
  users: string;
  userField: string;
  quorum: 'any' | 'all';
  slaHours: string;
  reminderHours: string;
  allowSelfApproval: boolean;
  formulaKey: string;
  onFalse: string;
  eventType: string;
}

const ifMatch = (version: number) => ({ 'If-Match': `"${String(version)}"` });
export const emptyStep = (): StepForm => ({
  kind: 'approval',
  key: '',
  name: '',
  roles: '',
  users: '',
  userField: '',
  quorum: 'any',
  slaHours: '',
  reminderHours: '',
  allowSelfApproval: false,
  formulaKey: '',
  onFalse: 'end',
  eventType: 'workflow.notify',
});

const list = (text: string) =>
  text
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '');
const hours = (text: string) => (text.trim() === '' ? {} : { v: Number(text) });

/** The step the form describes; empty boxes are left out so the schema's defaults apply. */
export function stepFromForm(f: StepForm): unknown {
  const base = { key: f.key.trim(), kind: f.kind, name: f.name.trim() };
  if (f.kind === 'condition') {
    return { ...base, formulaKey: f.formulaKey.trim(), onFalse: f.onFalse.trim() || 'end' };
  }
  if (f.kind === 'notify') return { ...base, eventType: f.eventType.trim() };
  const roles = list(f.roles);
  const users = list(f.users);
  return {
    ...base,
    assignee: {
      ...(roles.length > 0 ? { roles } : {}),
      ...(users.length > 0 ? { users } : {}),
      ...(f.userField.trim() === '' ? {} : { userField: f.userField.trim() }),
    },
    quorum: f.quorum,
    ...(f.slaHours.trim() === '' ? {} : { slaHours: hours(f.slaHours).v }),
    ...(f.reminderHours.trim() === '' ? {} : { reminderHours: hours(f.reminderHours).v }),
    allowSelfApproval: f.allowSelfApproval,
  };
}

/** The first problem of a graph (shape or rule), or null when it can be saved. */
export function graphProblem(graph: unknown): string | null {
  const parsed = workflowGraphSchema.safeParse(graph);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid';
  }
  return checkWorkflowGraph(parsed.data)[0]?.message ?? null;
}

export function WorkflowBuilderPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const [defs, setDefs] = useState<Definition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draftDef, setDraftDef] = useState({ key: '', name: '', entityKey: '' });
  const [selected, setSelected] = useState<Definition | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [onApproved, setOnApproved] = useState('');
  const [onRejected, setOnRejected] = useState('');
  const [form, setForm] = useState<StepForm | null>(null);

  const loadDefs = useCallback(() => {
    setLoading(true);
    api<{ items: Definition[] }>('/workflow-definitions', { query: { page: 1, pageSize: 200 } })
      .then((r) => {
        setDefs(r.items);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);
  useEffect(loadDefs, [loadDefs]);

  const loadVersions = useCallback((def: Definition) => {
    api<{ items: VersionRow[] }>('/workflow-versions', {
      query: { workflowDefinitionId: def.id, page: 1, pageSize: 100 },
    })
      .then((r) => {
        const sorted = [...r.items].sort((a, b) => b.versionNo - a.versionNo);
        setVersions(sorted);
        // Edit the open draft, or start from the newest version.
        const base = sorted.find((v) => v.status === 'draft') ?? sorted[0];
        const graph = workflowGraphSchema.safeParse(base?.graph);
        setSteps(graph.success ? graph.data.steps : []);
        setOnApproved(graph.success ? (graph.data.onApproved?.toStateCode ?? '') : '');
        setOnRejected(graph.success ? (graph.data.onRejected?.toStateCode ?? '') : '');
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, []);
  useEffect(() => {
    if (selected !== null) loadVersions(selected);
  }, [selected, loadVersions]);

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

  const createDefinition = () => {
    setProblem(null);
    run(api('/workflow-definitions', { method: 'POST', body: draftDef }), () => {
      setCreating(false);
      setDraftDef({ key: '', name: '', entityKey: '' });
      loadDefs();
    });
  };

  const graph = (): unknown => ({
    steps,
    ...(onApproved.trim() === '' ? {} : { onApproved: { toStateCode: onApproved.trim() } }),
    ...(onRejected.trim() === '' ? {} : { onRejected: { toStateCode: onRejected.trim() } }),
  });

  const addStep = () => {
    if (form === null) return;
    const checked = workflowGraphSchema.safeParse({ steps: [stepFromForm(form)] });
    if (!checked.success) {
      const issue = checked.error.issues[0];
      setProblem(issue ? `${issue.path.slice(1).join('.')}: ${issue.message}` : 'invalid');
      return;
    }
    setProblem(null);
    setSteps([...steps, ...checked.data.steps]);
    setForm(null);
  };

  const move = (index: number, by: -1 | 1) => {
    const next = [...steps];
    const other = index + by;
    const a = next[index];
    const b = next[other];
    if (a === undefined || b === undefined) return;
    next[index] = b;
    next[other] = a;
    setSteps(next);
  };

  const saveDraft = () => {
    if (selected === null) return;
    const found = graphProblem(graph());
    if (found !== null) {
      setProblem(found);
      return;
    }
    setProblem(null);
    const draft = versions.find((v) => v.status === 'draft');
    run(
      draft === undefined
        ? api('/workflow-versions', {
            method: 'POST',
            body: { workflowDefinitionId: selected.id, graph: graph() },
          })
        : api(`/workflow-versions/${draft.id}`, {
            method: 'PATCH',
            headers: ifMatch(draft.version),
            body: { graph: graph() },
          }),
      () => {
        loadVersions(selected);
      },
    );
  };

  const publish = () => {
    if (selected === null) return;
    run(api(`/workflow-definitions/${selected.id}/versions/publish`, { method: 'POST' }), () => {
      loadVersions(selected);
    });
  };

  const hasDraft = versions.some((v) => v.status === 'draft');
  const canEdit =
    auth.can('platform.workflow_version.update') || auth.can('platform.workflow_version.create');
  const stepSummary = (s: WorkflowStep) =>
    s.kind === 'approval'
      ? `${t('wf.kind.approval')} · ${[...(s.assignee.roles ?? []), ...(s.assignee.users ?? [])].join(', ')}`
      : s.kind === 'condition'
        ? `${t('wf.kind.condition')} · ${s.formulaKey} → ${s.onFalse}`
        : s.kind === 'notify'
          ? `${t('wf.kind.notify')} · ${s.eventType}`
          : `${t('wf.kind.parallel_group')} · ${String(s.branches.length)}`;

  return (
    <>
      <PageHeader
        title={t('wf.builder')}
        icon={GitBranch}
        description={t('wf.builderIntro')}
        actions={
          auth.can('platform.workflow_definition.create') ? (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setCreating(true);
                setProblem(null);
              }}
            >
              {t('wf.newWorkflow')}
            </Button>
          ) : null
        }
      />
      {error !== null && !loading ? <ErrorAlert error={error} /> : null}
      {creating ? (
        <section className="card" aria-label={t('wf.newWorkflow')}>
          <Field
            label={t('wf.key')}
            value={draftDef.key}
            onChange={(e) => {
              setDraftDef({ ...draftDef, key: e.target.value });
            }}
          />
          <Field
            label={t('wf.name')}
            value={draftDef.name}
            onChange={(e) => {
              setDraftDef({ ...draftDef, name: e.target.value });
            }}
          />
          <Field
            label={t('wf.entityKey')}
            value={draftDef.entityKey}
            onChange={(e) => {
              setDraftDef({ ...draftDef, entityKey: e.target.value });
            }}
          />
          <Button variant="primary" icon={Save} onClick={createDefinition}>
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
          { key: 'key', header: t('wf.key'), value: (r: Definition) => r.key },
          { key: 'name', header: t('wf.name'), value: (r: Definition) => r.name },
          { key: 'entityKey', header: t('wf.entityKey'), value: (r: Definition) => r.entityKey },
        ]}
        rows={defs}
        rowKey={(r) => r.id}
        total={defs.length}
        page={1}
        pageSize={200}
        onPageChange={() => undefined}
        loading={loading}
        error={null}
        exportName="workflows"
        actions={(r) => (
          <Button
            variant="link"
            onClick={() => {
              setSelected(r);
              setForm(null);
              setProblem(null);
            }}
          >
            {t('wf.steps')}
          </Button>
        )}
      />
      {selected === null ? null : (
        <section className="card" aria-label={t('wf.stepsOf', { name: selected.name })}>
          <h2>{t('wf.stepsOf', { name: selected.name })}</h2>
          <p>
            {versions
              .map((v) => `v${String(v.versionNo)} ${t(`wf.version.${v.status}`)}`)
              .join(' · ')}
          </p>
          <ol>
            {steps.map((s, i) => (
              <li key={s.key}>
                <strong>{s.name}</strong> ({s.key}) · {stepSummary(s)}
                {canEdit ? (
                  <>
                    <Button
                      variant="link"
                      icon={ArrowUp}
                      aria-label={`${t('wf.moveUp')} ${s.key}`}
                      disabled={i === 0}
                      onClick={() => {
                        move(i, -1);
                      }}
                    />
                    <Button
                      variant="link"
                      icon={ArrowDown}
                      aria-label={`${t('wf.moveDown')} ${s.key}`}
                      disabled={i === steps.length - 1}
                      onClick={() => {
                        move(i, 1);
                      }}
                    />
                    <Button
                      variant="link"
                      dangerText
                      icon={Trash2}
                      aria-label={`${t('common.delete')} ${s.key}`}
                      onClick={() => {
                        setSteps(steps.filter((x) => x.key !== s.key));
                      }}
                    />
                  </>
                ) : null}
              </li>
            ))}
          </ol>
          {canEdit ? (
            <>
              <Field
                label={t('wf.onApproved')}
                hint={t('wf.onStateHint')}
                value={onApproved}
                onChange={(e) => {
                  setOnApproved(e.target.value);
                }}
              />
              <Field
                label={t('wf.onRejected')}
                value={onRejected}
                onChange={(e) => {
                  setOnRejected(e.target.value);
                }}
              />
              <Button
                icon={Plus}
                onClick={() => {
                  setForm(emptyStep());
                  setProblem(null);
                }}
              >
                {t('wf.addStep')}
              </Button>
            </>
          ) : null}
          {form === null ? null : (
            <div role="region" aria-label={t('wf.addStep')}>
              <Select
                label={t('wf.kind')}
                value={form.kind}
                options={(['approval', 'condition', 'notify'] as const).map((k) => ({
                  value: k,
                  label: t(`wf.kind.${k}`),
                }))}
                onChange={(e) => {
                  setForm({ ...form, kind: e.target.value as StepForm['kind'] });
                }}
              />
              <Field
                label={t('wf.stepKey')}
                value={form.key}
                onChange={(e) => {
                  setForm({ ...form, key: e.target.value });
                }}
              />
              <Field
                label={t('wf.name')}
                value={form.name}
                onChange={(e) => {
                  setForm({ ...form, name: e.target.value });
                }}
              />
              {form.kind === 'approval' ? (
                <>
                  <Field
                    label={t('wf.roles')}
                    hint={t('wf.listHint')}
                    value={form.roles}
                    onChange={(e) => {
                      setForm({ ...form, roles: e.target.value });
                    }}
                  />
                  <Field
                    label={t('wf.users')}
                    hint={t('wf.listHint')}
                    value={form.users}
                    onChange={(e) => {
                      setForm({ ...form, users: e.target.value });
                    }}
                  />
                  <Field
                    label={t('wf.userField')}
                    value={form.userField}
                    onChange={(e) => {
                      setForm({ ...form, userField: e.target.value });
                    }}
                  />
                  <Select
                    label={t('wf.quorum')}
                    value={form.quorum}
                    options={[
                      { value: 'any', label: t('wf.quorum.any') },
                      { value: 'all', label: t('wf.quorum.all') },
                    ]}
                    onChange={(e) => {
                      setForm({ ...form, quorum: e.target.value as 'any' | 'all' });
                    }}
                  />
                  <Field
                    label={t('wf.slaHours')}
                    value={form.slaHours}
                    onChange={(e) => {
                      setForm({ ...form, slaHours: e.target.value });
                    }}
                  />
                  <Field
                    label={t('wf.reminderHours')}
                    value={form.reminderHours}
                    onChange={(e) => {
                      setForm({ ...form, reminderHours: e.target.value });
                    }}
                  />
                  <Checkbox
                    label={t('wf.selfApproval')}
                    checked={form.allowSelfApproval}
                    onChange={(e) => {
                      setForm({ ...form, allowSelfApproval: e.target.checked });
                    }}
                  />
                </>
              ) : null}
              {form.kind === 'condition' ? (
                <>
                  <Field
                    label={t('wf.formulaKey')}
                    value={form.formulaKey}
                    onChange={(e) => {
                      setForm({ ...form, formulaKey: e.target.value });
                    }}
                  />
                  <Field
                    label={t('wf.onFalse')}
                    hint={t('wf.onFalseHint')}
                    value={form.onFalse}
                    onChange={(e) => {
                      setForm({ ...form, onFalse: e.target.value });
                    }}
                  />
                </>
              ) : null}
              {form.kind === 'notify' ? (
                <Field
                  label={t('wf.eventType')}
                  value={form.eventType}
                  onChange={(e) => {
                    setForm({ ...form, eventType: e.target.value });
                  }}
                />
              ) : null}
              <Button variant="primary" onClick={addStep}>
                {t('wf.addStep')}
              </Button>
              <Button
                onClick={() => {
                  setForm(null);
                }}
              >
                {t('common.cancel')}
              </Button>
            </div>
          )}
          {problem === null ? null : (
            <p className="field-error" role="alert">
              {problem}
            </p>
          )}
          {canEdit ? (
            <Button variant="primary" icon={Save} onClick={saveDraft}>
              {t('wf.saveDraft')}
            </Button>
          ) : null}
          {hasDraft && auth.can('platform.workflow_definition.publish') ? (
            <Button icon={Send} onClick={publish}>
              {t('wf.publish')}
            </Button>
          ) : null}
        </section>
      )}
    </>
  );
}
