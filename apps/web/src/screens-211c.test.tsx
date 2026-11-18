/**
 * Row 2.11c screens: pure helpers only (parallel groups in the builder, the delegation and
 * binding request bodies). The journeys of the screens run in Playwright.
 */
import { describe, expect, it } from 'vitest';
import { workflowGraphSchema } from '@fibrex/shared';
import { bindingBody } from './org/WorkflowBindingsPage';
import {
  emptyStep,
  formFromStep,
  graphProblem,
  keepEscalation,
  stepFromForm,
} from './org/WorkflowBuilderPage';
import { delegationBody } from './workflow/DelegationsPage';

const branch = (key: string, role: string) => ({
  ...emptyStep(),
  key,
  name: key,
  roles: role,
});

describe('parallel groups in the builder', () => {
  it('builds a group from two branches and keeps it valid', () => {
    const form = {
      ...emptyStep(),
      kind: 'parallel_group' as const,
      key: 'checks',
      name: 'Checks',
      branches: [branch('legal', 'legal'), branch('finance', 'manager')],
    };
    expect(stepFromForm(form)).toMatchObject({
      kind: 'parallel_group',
      branches: [{ key: 'legal', assignee: { roles: ['legal'] } }, { key: 'finance' }],
    });
    expect(graphProblem({ steps: [stepFromForm(form)] })).toBeNull();
  });

  it('refuses a group with one branch', () => {
    const form = {
      ...emptyStep(),
      kind: 'parallel_group' as const,
      key: 'checks',
      name: 'Checks',
      branches: [branch('legal', 'legal')],
    };
    expect(graphProblem({ steps: [stepFromForm(form)] })).not.toBeNull();
  });

  it('turns a saved group back into a form and again into the same step', () => {
    const saved = workflowGraphSchema.parse({
      steps: [
        {
          key: 'checks',
          kind: 'parallel_group',
          name: 'Checks',
          branches: [
            { key: 'a', kind: 'approval', name: 'A', assignee: { roles: ['x'] }, quorum: 'all' },
            { key: 'b', kind: 'approval', name: 'B', assignee: { users: [crypto.randomUUID()] } },
          ],
        },
      ],
    }).steps[0];
    if (saved === undefined) throw new Error('no step');
    const again = workflowGraphSchema.parse({ steps: [stepFromForm(formFromStep(saved))] })
      .steps[0];
    expect(again).toEqual(saved);
  });
});

describe('editing keeps what the form cannot show', () => {
  it('keeps the escalation target of an approval and of its group branches', () => {
    const escalateTo = { roles: ['boss'] };
    const oldStep = workflowGraphSchema.parse({
      steps: [
        {
          key: 'checks',
          kind: 'parallel_group',
          name: 'Checks',
          branches: [
            { key: 'a', kind: 'approval', name: 'A', assignee: { roles: ['x'] }, escalateTo },
            { key: 'b', kind: 'approval', name: 'B', assignee: { roles: ['y'] } },
          ],
        },
      ],
    }).steps[0];
    if (oldStep === undefined) throw new Error('no step');
    const edited = workflowGraphSchema.parse({ steps: [stepFromForm(formFromStep(oldStep))] })
      .steps[0];
    if (edited === undefined) throw new Error('no step');
    expect(JSON.stringify(edited)).not.toContain('boss'); // the form alone loses it ...
    const kept = keepEscalation(oldStep, edited);
    expect(kept).toEqual(oldStep); // ... and keepEscalation puts it back
  });
});

describe('delegation and binding bodies', () => {
  const base = {
    userId: 'u1',
    delegateUserId: 'u2',
    validFrom: '2026-12-01',
    validTo: '2026-12-10',
    keys: '',
    note: '',
  };
  it('sends no scope keys for "all workflows" and trims the list otherwise', () => {
    expect(delegationBody(base)).toMatchObject({ ok: true, body: { scope: {}, note: null } });
    expect(delegationBody({ ...base, keys: ' vehicle.request, hire ' })).toMatchObject({
      ok: true,
      body: { scope: { definitionKeys: ['vehicle.request', 'hire'] } },
    });
  });
  it('refuses a missing stand-in, reversed dates and a bad key', () => {
    expect(delegationBody({ ...base, delegateUserId: '' }).ok).toBe(false);
    expect(delegationBody({ ...base, validTo: '2026-11-01' }).ok).toBe(false);
    expect(delegationBody({ ...base, keys: 'Bad Key' }).ok).toBe(false);
  });
  it('names the state only for "on transition"', () => {
    const form = {
      workflowDefinitionId: 'w',
      trigger: 'on_create' as const,
      toStateCode: 'submitted',
      conditionFormulaKey: '',
    };
    expect(bindingBody(form)).toMatchObject({ toStateCode: null, conditionFormulaKey: null });
    expect(bindingBody({ ...form, trigger: 'on_transition' })).toMatchObject({
      toStateCode: 'submitted',
    });
  });
});
