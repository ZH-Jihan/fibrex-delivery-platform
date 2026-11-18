/**
 * Workflows (PLAN 3.7 `workflow_*` tables, PLAN 5.9 "Workflow"; SPEC 2.10).
 *
 * Purpose: the one description of a workflow graph (its steps in order), the checks a
 * graph must pass before it can be published, the bodies of the task actions, and the
 * quorum rule. The API runs them before it stores or acts; the web screens (row 2.11b)
 * use the same schemas to check their forms.
 *
 * A graph is an ordered list of steps, walked from the top:
 *   - approval: tasks for the people the assignee rule names. Quorum "any": the first
 *     approval completes the step and the other tasks are skipped. Quorum "all": every
 *     task must be approved. One rejection rejects the whole workflow.
 *   - parallel_group: two or more approval branches opened at the same time; the group is
 *     complete when every branch is (each branch by its own quorum).
 *   - condition: a boolean formula of the formula engine (never an inline expression),
 *     read with the record's fields. True: carry on with the next step. False: jump to the
 *     step named by `onFalse` (always further down, so a workflow can never loop) or to
 *     the end. Amount thresholds are written this way ("amount > 5000 needs the manager").
 *   - notify: announces an event for the notification rules, then carries on.
 *
 * Rules of a graph (business rules, checked by `checkWorkflowGraph`):
 *   1. Step keys are unique, branch keys included (tasks and the timeline hold them).
 *   2. At least one approval: a workflow that approves nothing is a mistake.
 *   3. A condition's `onFalse` names a later top-level step, or "end".
 *   4. A reminder comes before the deadline it reminds of.
 *
 * Depends on: zod, ../formulas (formula keys), ../states (state codes, field keys).
 * Used by: apps/api kernel/workflows, apps/web (row 2.11b).
 */
import { z } from 'zod';
import { formulaKeySchema } from '../formulas/index.js';
import { stateCodeSchema, stateEntityKeySchema, stateFieldKeySchema } from '../states/index.js';

export const workflowKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_.]{0,59}$/, 'lower-case letters, digits, _ and .');

export const workflowStepKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,49}$/, 'lower-case letters, digits and _');

export const workflowEntityKeySchema = stateEntityKeySchema;

const roleKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_.:-]{0,63}$/i, 'a role key');

export const eventTypeKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, 'an event type like workflow.notify');

/** Who gets the tasks of an approval step: named users, roles, or a record field. */
export const assigneeRuleSchema = z
  .strictObject({
    users: z.array(z.uuid()).max(20).optional(),
    roles: z.array(roleKeySchema).max(20).optional(),
    /** A field of the record that holds a user id (for example "managerUserId"). */
    userField: stateFieldKeySchema.optional(),
  })
  .refine(
    (rule) =>
      (rule.users?.length ?? 0) > 0 ||
      (rule.roles?.length ?? 0) > 0 ||
      rule.userField !== undefined,
    'name at least one user, role or field',
  );
export type AssigneeRule = z.infer<typeof assigneeRuleSchema>;

/** Who takes over a task that passed its deadline. */
export const escalationSchema = z
  .strictObject({
    users: z.array(z.uuid()).max(20).optional(),
    roles: z.array(roleKeySchema).max(20).optional(),
  })
  .refine(
    (rule) => (rule.users?.length ?? 0) > 0 || (rule.roles?.length ?? 0) > 0,
    'name at least one user or role',
  );
export type Escalation = z.infer<typeof escalationSchema>;

export const QUORUMS = ['any', 'all'] as const;
export const quorumSchema = z.enum(QUORUMS);
export type Quorum = z.infer<typeof quorumSchema>;

const hours = z.number().int().min(1).max(8760);
const stepName = z.string().trim().min(1).max(200);

export const approvalStepSchema = z.strictObject({
  key: workflowStepKeySchema,
  kind: z.literal('approval'),
  name: stepName,
  assignee: assigneeRuleSchema,
  quorum: quorumSchema.default('any'),
  slaHours: hours.optional(),
  reminderHours: hours.optional(),
  escalateTo: escalationSchema.optional(),
  /** Off by default: the person who started a workflow does not approve it. */
  allowSelfApproval: z.boolean().default(false),
});
export type ApprovalStep = z.infer<typeof approvalStepSchema>;

export const parallelStepSchema = z.strictObject({
  key: workflowStepKeySchema,
  kind: z.literal('parallel_group'),
  name: stepName,
  branches: z.array(approvalStepSchema).min(2).max(10),
});
export type ParallelStep = z.infer<typeof parallelStepSchema>;

export const conditionStepSchema = z.strictObject({
  key: workflowStepKeySchema,
  kind: z.literal('condition'),
  name: stepName,
  formulaKey: formulaKeySchema,
  onFalse: z.union([z.literal('end'), workflowStepKeySchema]).default('end'),
});
export type ConditionStep = z.infer<typeof conditionStepSchema>;

export const notifyStepSchema = z.strictObject({
  key: workflowStepKeySchema,
  kind: z.literal('notify'),
  name: stepName,
  eventType: eventTypeKeySchema.default('workflow.notify'),
});
export type NotifyStep = z.infer<typeof notifyStepSchema>;

export const workflowStepSchema = z.discriminatedUnion('kind', [
  approvalStepSchema,
  parallelStepSchema,
  conditionStepSchema,
  notifyStepSchema,
]);
export type WorkflowStep = z.infer<typeof workflowStepSchema>;

/** A state move made when the workflow ends (the workflow's approval is the authority). */
const outcomeMoveSchema = z.strictObject({ toStateCode: stateCodeSchema });

export const workflowGraphSchema = z.strictObject({
  steps: z.array(workflowStepSchema).min(1).max(50),
  onApproved: outcomeMoveSchema.optional(),
  onRejected: outcomeMoveSchema.optional(),
});
export type WorkflowGraph = z.infer<typeof workflowGraphSchema>;

export interface GraphIssue {
  path: string;
  code: string;
  message: string;
}

/** Rules 1 to 4 of the header; an empty list means the graph can be published. */
export function checkWorkflowGraph(graph: WorkflowGraph): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const seen = new Set<string>();
  const claim = (key: string, path: string) => {
    if (seen.has(key)) {
      issues.push({ path, code: 'duplicate_step', message: `Step key "${key}" is used twice.` });
    }
    seen.add(key);
  };
  const checkTimes = (step: ApprovalStep, path: string) => {
    if (
      step.reminderHours !== undefined &&
      step.slaHours !== undefined &&
      step.reminderHours >= step.slaHours
    ) {
      issues.push({
        path: `${path}.reminderHours`,
        code: 'reminder_after_deadline',
        message: 'The reminder must come before the deadline.',
      });
    }
  };

  let approvals = 0;
  graph.steps.forEach((step, index) => {
    const path = `steps.${String(index)}`;
    claim(step.key, `${path}.key`);
    if (step.kind === 'approval') {
      approvals += 1;
      checkTimes(step, path);
    } else if (step.kind === 'parallel_group') {
      approvals += 1;
      step.branches.forEach((branch, b) => {
        const branchPath = `${path}.branches.${String(b)}`;
        claim(branch.key, `${branchPath}.key`);
        checkTimes(branch, branchPath);
      });
    } else if (step.kind === 'condition' && step.onFalse !== 'end') {
      // Rule 3: only forward, so the walk always ends.
      const target = graph.steps.findIndex((s) => s.key === step.onFalse);
      if (target <= index) {
        issues.push({
          path: `${path}.onFalse`,
          code: 'invalid_jump',
          message: `"${step.onFalse}" must be a step further down, or "end".`,
        });
      }
    }
  });
  if (approvals === 0) {
    issues.push({
      path: 'steps',
      code: 'no_approval',
      message: 'A workflow needs at least one approval step.',
    });
  }
  return issues;
}

/** One task of a step, as far as the quorum is concerned. */
export interface QuorumTask {
  status: 'open' | 'done' | 'skipped' | 'expired';
  action: 'approve' | 'reject' | 'send_back' | null;
}

/**
 * Whether the tasks of one round of a step complete it. Expired tasks (replaced by an
 * escalation) and skipped ones do not count; "all" needs every remaining task approved.
 */
export function quorumReached(quorum: Quorum, tasks: readonly QuorumTask[]): boolean {
  const counted = tasks.filter((t) => t.status === 'open' || t.status === 'done');
  const approved = counted.filter((t) => t.action === 'approve').length;
  if (quorum === 'any') return approved > 0;
  return counted.length > 0 && approved === counted.length;
}

const comment = z.string().trim().min(1).max(4000);

/** Body of approve: an optional comment and, for example, a changed amount. */
export const taskApproveSchema = z.strictObject({
  comment: comment.optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});
/** Reject, send back and comment always say why. */
export const taskCommentSchema = z.strictObject({ comment });
export const taskDelegateSchema = z.strictObject({
  toUserId: z.uuid(),
  comment: comment.optional(),
});

export const WORKFLOW_TRIGGERS = ['on_create', 'on_transition', 'manual'] as const;
export const workflowTriggerSchema = z.enum(WORKFLOW_TRIGGERS);
export type WorkflowTrigger = z.infer<typeof workflowTriggerSchema>;
