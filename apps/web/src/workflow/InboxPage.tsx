/**
 * Task inbox (phase 2 row 2.11b; PLAN 5.9 "Workflow").
 *
 * Purpose: the open workflow tasks of the signed-in user, soonest deadline first, with the
 * actions of the task API: approve (comment optional), reject, send back and comment (a
 * comment is required, as the shared schemas say). Each entry can open the timeline of its
 * workflow. The server decides who may act (not the starter, only the assignee or a
 * delegate); this screen shows its answer when an action is refused.
 *
 * Depends on: api client, i18n, ui components, @fibrex/shared (task schemas),
 * workflow/WorkflowTimeline.
 * Used by: App.tsx route /tasks.
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, History, Inbox, MessageSquare, Undo2, UserRoundPlus, X } from 'lucide-react';
import { taskApproveSchema, taskCommentSchema } from '@fibrex/shared';
import { api } from '../api/client';
import { useI18n } from '../i18n';
import {
  Button,
  EmptyState,
  ErrorAlert,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
} from '../ui/components';
import { InstanceTimeline } from './WorkflowTimeline';

export interface InboxEntry {
  task: {
    id: string;
    instanceId: string;
    dueAt: string | null;
    escalatedFromTaskId: string | null;
    /** Null for a task given to a role: it cannot be passed on, whoever holds the role takes it. */
    assigneeUserId?: string | null;
  };
  instance: { entityType: string; entityId: string };
  definition: { name: string };
  stepName: string;
}

type Action = 'approve' | 'reject' | 'send-back' | 'comment';

/** The request body of an action: approve may go without a comment, the others need one. */
export function actionBody(
  action: Action,
  comment: string,
): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
  const text = comment.trim();
  const schema = action === 'approve' ? taskApproveSchema : taskCommentSchema;
  const checked = schema.safeParse(text === '' ? {} : { comment: text });
  if (!checked.success) return { ok: false, message: checked.error.issues[0]?.message ?? '' };
  return { ok: true, body: checked.data };
}

export function InboxPage() {
  const { t } = useI18n();
  const [items, setItems] = useState<InboxEntry[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [problem, setProblem] = useState<{ id: string; text: string } | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  // Passing a task on: which task has its picker open, who is on offer, and who is chosen.
  const [passing, setPassing] = useState<string | null>(null);
  const [people, setPeople] = useState<{ id: string; displayName: string }[]>([]);
  const [target, setTarget] = useState('');

  const load = useCallback(() => {
    api<{ items: InboxEntry[] }>('/tasks')
      .then((r) => {
        setItems(r.items);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, []);
  useEffect(load, [load]);

  const act = (entry: InboxEntry, action: Action) => {
    const checked = actionBody(action, comments[entry.task.id] ?? '');
    if (!checked.ok) {
      setProblem({ id: entry.task.id, text: t('wf.commentRequired') });
      return;
    }
    setProblem(null);
    api(`/tasks/${entry.task.id}/${action}`, { method: 'POST', body: checked.body })
      .then(() => {
        setComments((c) => ({ ...c, [entry.task.id]: '' }));
        load();
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };

  /** Opens or closes the "pass on" picker of one task; the people load on first use. */
  const togglePass = (entry: InboxEntry) => {
    const id = entry.task.id;
    setTarget('');
    if (passing === id) {
      setPassing(null);
      return;
    }
    setPassing(id);
    if (people.length === 0) {
      api<{ items: { id: string; displayName: string }[] }>('/workflow-people')
        .then((r) => {
          setPeople(r.items);
        })
        .catch((e: unknown) => {
          setError(e);
        });
    }
  };

  const pass = (entry: InboxEntry) => {
    if (target === '') return;
    const note = (comments[entry.task.id] ?? '').trim();
    api(`/tasks/${entry.task.id}/delegate`, {
      method: 'POST',
      body: note === '' ? { toUserId: target } : { toUserId: target, comment: note },
    })
      .then(() => {
        setPassing(null);
        setTarget('');
        load();
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };

  return (
    <>
      <PageHeader title={t('wf.inbox')} icon={Inbox} description={t('wf.inboxIntro')} />
      {error === null ? null : <ErrorAlert error={error} />}
      {items === null && error === null ? <Skeleton lines={4} /> : null}
      {items?.length === 0 ? <EmptyState title={t('wf.inboxEmpty')} /> : null}
      {items?.map((entry) => {
        const id = entry.task.id;
        return (
          <section
            className="card"
            key={id}
            aria-label={`${entry.definition.name} ${entry.stepName}`}
          >
            <h2>{entry.definition.name}</h2>
            <p>
              {entry.stepName} · {entry.instance.entityType}
              {entry.task.dueAt === null
                ? ''
                : ` · ${t('wf.due')} ${new Date(entry.task.dueAt).toLocaleString()}`}
              {entry.task.escalatedFromTaskId === null ? '' : ` · ${t('wf.escalated')}`}
            </p>
            <Textarea
              label={t('wf.comment')}
              value={comments[id] ?? ''}
              onChange={(e) => {
                setComments({ ...comments, [id]: e.target.value });
              }}
            />
            {problem?.id === id ? (
              <p className="field-error" role="alert">
                {problem.text}
              </p>
            ) : null}
            <Button
              variant="primary"
              icon={Check}
              onClick={() => {
                act(entry, 'approve');
              }}
            >
              {t('wf.approve')}
            </Button>
            <Button
              icon={Undo2}
              onClick={() => {
                act(entry, 'send-back');
              }}
            >
              {t('wf.sendBack')}
            </Button>
            <Button
              dangerText
              icon={X}
              onClick={() => {
                act(entry, 'reject');
              }}
            >
              {t('wf.reject')}
            </Button>
            <Button
              variant="link"
              icon={MessageSquare}
              onClick={() => {
                act(entry, 'comment');
              }}
            >
              {t('wf.addComment')}
            </Button>
            {entry.task.assigneeUserId === null ? null : (
              <Button
                variant="link"
                icon={UserRoundPlus}
                onClick={() => {
                  togglePass(entry);
                }}
              >
                {t('wf.delegate')}
              </Button>
            )}
            <Button
              variant="link"
              icon={History}
              onClick={() => {
                setOpen(open === id ? null : id);
              }}
            >
              {t('wf.timeline')}
            </Button>
            {passing === id ? (
              <div role="region" aria-label={t('wf.delegate')}>
                <Select
                  label={t('wf.delegateTo')}
                  placeholder={t('wf.choosePerson')}
                  value={target}
                  options={people.map((p) => ({ value: p.id, label: p.displayName }))}
                  onChange={(e) => {
                    setTarget(e.target.value);
                  }}
                />
                <Button
                  variant="primary"
                  disabled={target === ''}
                  onClick={() => {
                    pass(entry);
                  }}
                >
                  {t('wf.delegateConfirm')}
                </Button>
              </div>
            ) : null}
            {open === id ? <InstanceTimeline instanceId={entry.task.instanceId} /> : null}
          </section>
        );
      })}
    </>
  );
}
