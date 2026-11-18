/**
 * Starting notification rules for the `workflow.*` events (phase 2 row 2.11c).
 *
 * Purpose: out of the box, the person a workflow task is given to hears about it (in the app
 * and by e-mail), is reminded, and the starter hears how the workflow ended. Each rule is
 * tenant-wide data like any other rule: an administrator edits or switches it off on the
 * notification screens, and this seed never overwrites or re-creates one that is there
 * (found by its name), so an edit or a deliberate delete-and-keep is respected on the next run.
 *
 * Who is told, and why these fields:
 *   - task_assigned / task_reminder / task_escalated / task_overdue: `assigneeId`, the person
 *     holding the task. A task given to a ROLE has no `assigneeId` (anyone holding the role may
 *     take it), so nobody is messaged for it; it shows in each holder's task inbox instead.
 *   - completed / notify: `starterId`, the person who started the workflow.
 *
 * Depends on: pg (the seed's client). Used by: seed/seed.ts.
 */
import type pg from 'pg';

interface RuleSeed {
  name: string;
  eventTypeKey: string;
  recipientField: string;
  title: string;
  body: string;
}

const RULES: RuleSeed[] = [
  {
    name: 'Workflow: task assigned',
    eventTypeKey: 'workflow.task_assigned',
    recipientField: 'assigneeId',
    title: 'Approval needed: {{definitionName}}',
    body: 'Step "{{stepName}}" of {{definitionName}} is waiting for you in your task inbox.',
  },
  {
    name: 'Workflow: task reminder',
    eventTypeKey: 'workflow.task_reminder',
    recipientField: 'assigneeId',
    title: 'Reminder: {{definitionName}}',
    body: 'A task of {{definitionName}} is still waiting for you (due {{dueAt}}).',
  },
  {
    name: 'Workflow: task escalated',
    eventTypeKey: 'workflow.task_escalated',
    recipientField: 'assigneeId',
    title: 'Escalated to you: {{definitionName}}',
    body: 'Step "{{stepName}}" of {{definitionName}} passed its deadline and was given to you.',
  },
  {
    name: 'Workflow: task overdue',
    eventTypeKey: 'workflow.task_overdue',
    recipientField: 'assigneeId',
    title: 'Overdue: {{definitionName}}',
    body: 'A task of {{definitionName}} passed its deadline. Please act on it.',
  },
  {
    name: 'Workflow: finished',
    eventTypeKey: 'workflow.completed',
    recipientField: 'starterId',
    title: '{{definitionName}}: {{outcome}}',
    body: 'The workflow you started, {{definitionName}}, ended as {{outcome}}.',
  },
  {
    name: 'Workflow: notify step',
    eventTypeKey: 'workflow.notify',
    recipientField: 'starterId',
    title: '{{definitionName}}: {{stepName}}',
    body: 'The workflow {{definitionName}} reached "{{stepName}}".',
  },
];

/** Adds the rules that are missing; returns how many were added. */
export async function seedWorkflowNotificationRules(
  client: Pick<pg.PoolClient, 'query'>,
  tenantId: string,
): Promise<number> {
  let added = 0;
  for (const rule of RULES) {
    const made = await client.query(
      `INSERT INTO notify.notification_rule
         (tenant_id, company_id, name, event_type_key, channels, recipients, title_template, body_template)
       SELECT $1, NULL, $2, $3, ARRAY['in_app', 'email'], $4::jsonb, $5, $6
        WHERE NOT EXISTS (SELECT 1 FROM notify.notification_rule WHERE tenant_id = $1 AND name = $2)`,
      [
        tenantId,
        rule.name,
        rule.eventTypeKey,
        JSON.stringify({ payloadUserFields: [rule.recipientField] }),
        rule.title,
        rule.body,
      ],
    );
    added += made.rowCount ?? 0;
  }
  return added;
}
