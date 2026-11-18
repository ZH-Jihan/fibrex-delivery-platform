import { describe, expect, it } from 'vitest';
import { checkWorkflowGraph, quorumReached, workflowGraphSchema } from './index.js';

const approval = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  kind: 'approval',
  name: key,
  assignee: { roles: ['manager'] },
  ...extra,
});

describe('workflow graph', () => {
  it('accepts a three-step approval with a threshold condition', () => {
    const graph = workflowGraphSchema.parse({
      steps: [
        approval('review'),
        {
          key: 'big',
          kind: 'condition',
          name: 'Big amount',
          formulaKey: 'wf.big',
          onFalse: 'tell',
        },
        approval('owner', { quorum: 'all', slaHours: 48, reminderHours: 24 }),
        { key: 'tell', kind: 'notify', name: 'Tell finance' },
      ],
      onApproved: { toStateCode: 'approved' },
    });
    expect(checkWorkflowGraph(graph)).toEqual([]);
    expect(graph.steps[0]).toMatchObject({ quorum: 'any', allowSelfApproval: false });
    expect(graph.steps[3]).toMatchObject({ eventType: 'workflow.notify' });
  });

  it('refuses duplicate keys, backward jumps, late reminders and no approval', () => {
    const dup = workflowGraphSchema.parse({
      steps: [
        approval('a'),
        { key: 'p', kind: 'parallel_group', name: 'p', branches: [approval('a'), approval('b')] },
      ],
    });
    expect(checkWorkflowGraph(dup).map((i) => i.code)).toEqual(['duplicate_step']);

    const back = workflowGraphSchema.parse({
      steps: [
        approval('a'),
        { key: 'c', kind: 'condition', name: 'c', formulaKey: 'x', onFalse: 'a' },
      ],
    });
    expect(checkWorkflowGraph(back).map((i) => i.code)).toEqual(['invalid_jump']);

    const late = workflowGraphSchema.parse({
      steps: [approval('a', { slaHours: 4, reminderHours: 4 })],
    });
    expect(checkWorkflowGraph(late).map((i) => i.code)).toEqual(['reminder_after_deadline']);

    const none = workflowGraphSchema.parse({
      steps: [{ key: 'n', kind: 'notify', name: 'n' }],
    });
    expect(checkWorkflowGraph(none).map((i) => i.code)).toEqual(['no_approval']);
  });

  it('needs someone to approve and refuses unknown step kinds', () => {
    expect(
      workflowGraphSchema.safeParse({ steps: [approval('a', { assignee: {} })] }).success,
    ).toBe(false);
    expect(
      workflowGraphSchema.safeParse({ steps: [{ key: 'x', kind: 'script', name: 'x' }] }).success,
    ).toBe(false);
  });
});

describe('quorum', () => {
  const open = { status: 'open', action: null } as const;
  const yes = { status: 'done', action: 'approve' } as const;
  const expired = { status: 'expired', action: null } as const;

  it('"any" needs one approval, "all" every counted task', () => {
    expect(quorumReached('any', [open, yes])).toBe(true);
    expect(quorumReached('any', [open, open])).toBe(false);
    expect(quorumReached('all', [open, yes])).toBe(false);
    expect(quorumReached('all', [yes, yes])).toBe(true);
    // An expired task was replaced by its escalation and no longer counts.
    expect(quorumReached('all', [expired, yes])).toBe(true);
    expect(quorumReached('all', [expired])).toBe(false);
  });
});
