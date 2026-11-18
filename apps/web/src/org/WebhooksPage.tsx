/**
 * Webhooks (phase 2 row 2.12; PLAN 5.10 "/webhook-subscriptions", "/webhook-deliveries").
 *
 * Purpose: let an administrator send Fibrex events to an outside system. A subscription
 * names an address and the event types it wants ("all events" or a chosen list). The
 * signing secret is shown once, right after create or rotate; after that only the
 * receiver knows it. Opening a subscription's log lists every delivery attempt with its
 * answer, and a failed attempt can be sent again.
 *
 * Depends on: api client, auth, i18n, ui components, @fibrex/shared (subscription schema).
 * Used by: App.tsx route /organisation/webhooks.
 */
import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Plus, RotateCw, Save, Webhook } from 'lucide-react';
import { webhookSubscriptionFormSchema } from '@fibrex/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Button, Checkbox, ErrorAlert, Field, PageHeader, Pill } from '../ui/components';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DataTable } from '../ui/DataTable';

interface Subscription {
  id: string;
  name: string;
  url: string;
  eventTypeKeys: string[];
  active: boolean;
  version: number;
  secret?: string;
}
interface EventType {
  key: string;
  label: string;
}
interface Delivery {
  id: string;
  eventId: string;
  eventType: string;
  attempt: number;
  status: 'succeeded' | 'failed';
  statusCode: number | null;
  responseMs: number | null;
  error: string | null;
  nextRetryAt: string | null;
  manual: boolean;
  createdAt: string;
}

const ifMatch = (version: number) => ({ 'If-Match': `"${String(version)}"` });

/**
 * The create body from the form, checked by the shared schema. "All events" wins over a
 * list. Returns the first problem's message instead when the form is not acceptable.
 */
export function subscriptionBody(form: {
  name: string;
  url: string;
  allEvents: boolean;
  eventTypeKeys: string[];
}): { body: Record<string, unknown> } | { problem: string } {
  const parsed = webhookSubscriptionFormSchema.safeParse({
    name: form.name,
    url: form.url,
    eventTypeKeys: form.allEvents ? ['*'] : form.eventTypeKeys,
    active: true,
  });
  if (!parsed.success) return { problem: parsed.error.issues[0]?.message ?? 'Invalid' };
  return { body: parsed.data };
}

const emptyForm = { name: '', url: '', allEvents: false, eventTypeKeys: [] as string[] };

export function WebhooksPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const [rows, setRows] = useState<Subscription[]>([]);
  const [types, setTypes] = useState<EventType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [problem, setProblem] = useState<string | null>(null);
  const [shownSecret, setShownSecret] = useState<{ name: string; secret: string } | null>(null);
  const [rotating, setRotating] = useState<Subscription | null>(null);
  const [removing, setRemoving] = useState<Subscription | null>(null);
  const [reason, setReason] = useState('');
  const [logOf, setLogOf] = useState<Subscription | null>(null);
  const [log, setLog] = useState<Delivery[]>([]);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api<{ items: Subscription[] }>('/webhook-subscriptions', {
        query: { page: 1, pageSize: 200 },
      }),
      api<{ items: EventType[] }>('/event-types'),
    ])
      .then(([s, e]) => {
        setRows(s.items);
        setTypes(e.items);
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

  const loadLog = useCallback((sub: Subscription) => {
    api<{ items: Delivery[] }>('/webhook-deliveries', {
      query: { subscriptionId: sub.id, page: 1, pageSize: 100 },
    })
      .then((page) => {
        setLog(page.items);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e);
      });
  }, []);

  const run = <T,>(job: Promise<T>, after: (value: T) => void) => {
    job
      .then((value) => {
        setError(null);
        after(value);
      })
      .catch((e: unknown) => {
        setError(e);
      });
  };
  const labelOf = (key: string) =>
    key === '*' ? t('wh.allEvents') : (types.find((x) => x.key === key)?.label ?? key);
  const canEdit = auth.can('integration.webhook_subscription.update');

  const save = () => {
    const result = subscriptionBody(form);
    if ('problem' in result) {
      setProblem(result.problem);
      return;
    }
    setProblem(null);
    run(api<Subscription>('/webhook-subscriptions', { method: 'POST', body: result.body }), (s) => {
      setCreating(false);
      setForm(emptyForm);
      setShownSecret({ name: s.name, secret: s.secret ?? '' });
      load();
    });
  };

  return (
    <>
      <PageHeader
        title={t('wh.title')}
        icon={Webhook}
        description={t('wh.intro')}
        actions={
          auth.can('integration.webhook_subscription.create') ? (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setCreating(true);
              }}
            >
              {t('wh.new')}
            </Button>
          ) : null
        }
      />
      {error !== null && !loading ? <ErrorAlert error={error} /> : null}
      {shownSecret !== null ? (
        <section className="card" role="status" aria-label={t('wh.secretTitle')}>
          <h2>
            <KeyRound aria-hidden /> {t('wh.secretTitle')}: {shownSecret.name}
          </h2>
          <p>{t('wh.secretOnce')}</p>
          <code className="secret">{shownSecret.secret}</code>
          <Button
            onClick={() => {
              setShownSecret(null);
            }}
          >
            {t('wh.secretSaved')}
          </Button>
        </section>
      ) : null}
      {creating ? (
        <section className="card" aria-label={t('wh.new')}>
          <Field
            label={t('wh.name')}
            value={form.name}
            onChange={(e) => {
              setForm({ ...form, name: e.target.value });
            }}
          />
          <Field
            label={t('wh.url')}
            hint={t('wh.urlHint')}
            value={form.url}
            error={problem ?? undefined}
            onChange={(e) => {
              setForm({ ...form, url: e.target.value });
            }}
          />
          <fieldset>
            <legend>{t('wh.eventTypes')}</legend>
            <Checkbox
              label={t('wh.allEvents')}
              checked={form.allEvents}
              onChange={(e) => {
                setForm({ ...form, allEvents: e.target.checked });
              }}
            />
            {form.allEvents
              ? null
              : types.map((type) => (
                  <Checkbox
                    key={type.key}
                    label={`${type.label} (${type.key})`}
                    checked={form.eventTypeKeys.includes(type.key)}
                    onChange={(e) => {
                      setForm({
                        ...form,
                        eventTypeKeys: e.target.checked
                          ? [...form.eventTypeKeys, type.key]
                          : form.eventTypeKeys.filter((k) => k !== type.key),
                      });
                    }}
                  />
                ))}
          </fieldset>
          <Button variant="primary" icon={Save} onClick={save}>
            {t('common.save')}
          </Button>
          <Button
            onClick={() => {
              setCreating(false);
              setProblem(null);
            }}
          >
            {t('common.cancel')}
          </Button>
        </section>
      ) : null}
      <DataTable
        columns={[
          { key: 'name', header: t('wh.name'), value: (r: Subscription) => r.name },
          { key: 'url', header: t('wh.url'), value: (r: Subscription) => r.url },
          {
            key: 'types',
            header: t('wh.eventTypes'),
            value: (r: Subscription) => r.eventTypeKeys.map(labelOf).join(', '),
          },
          {
            key: 'active',
            header: t('wh.active'),
            value: (r: Subscription) => (r.active ? t('common.yes') : t('common.no')),
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
        exportName="webhooks"
        actions={(r) => (
          <>
            {auth.can('integration.webhook_delivery.read') ? (
              <Button
                variant="link"
                onClick={() => {
                  setLogOf(r);
                  loadLog(r);
                }}
              >
                {t('wh.log')}
              </Button>
            ) : null}
            {canEdit ? (
              <Button
                variant="link"
                onClick={() => {
                  run(
                    api(`/webhook-subscriptions/${r.id}`, {
                      method: 'PATCH',
                      headers: ifMatch(r.version),
                      body: { active: !r.active },
                    }),
                    load,
                  );
                }}
              >
                {r.active ? t('wh.deactivate') : t('wh.activate')}
              </Button>
            ) : null}
            {auth.can('integration.webhook_subscription.rotate_secret') ? (
              <Button
                variant="link"
                onClick={() => {
                  setRotating(r);
                }}
              >
                {t('wh.rotate')}
              </Button>
            ) : null}
            {auth.can('integration.webhook_subscription.delete') ? (
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
      {logOf !== null ? (
        <section aria-label={t('wh.log')}>
          <h2>
            {t('wh.log')}: {logOf.name}
          </h2>
          <DataTable
            columns={[
              {
                key: 'when',
                header: t('wh.when'),
                value: (d: Delivery) => new Date(d.createdAt).toLocaleString(),
              },
              { key: 'type', header: t('wh.eventType'), value: (d: Delivery) => d.eventType },
              { key: 'attempt', header: t('wh.attempt'), value: (d: Delivery) => d.attempt },
              {
                key: 'status',
                header: t('wh.status'),
                value: (d: Delivery) => d.status,
                render: (d: Delivery) => (
                  <Pill tone={d.status === 'succeeded' ? 'success' : 'danger'}>
                    {d.status === 'succeeded' ? t('wh.succeeded') : t('wh.failed')}
                    {d.statusCode === null ? '' : ` ${String(d.statusCode)}`}
                  </Pill>
                ),
              },
              {
                key: 'ms',
                header: t('wh.responseMs'),
                value: (d: Delivery) => d.responseMs,
              },
              { key: 'error', header: t('wh.error'), value: (d: Delivery) => d.error },
              {
                key: 'next',
                header: t('wh.nextRetry'),
                value: (d: Delivery) =>
                  d.nextRetryAt === null ? '' : new Date(d.nextRetryAt).toLocaleString(),
              },
            ]}
            rows={log}
            rowKey={(d) => d.id}
            total={log.length}
            page={1}
            pageSize={100}
            onPageChange={() => undefined}
            loading={false}
            error={null}
            exportName="webhook-deliveries"
            actions={(d) =>
              d.status === 'failed' && auth.can('integration.webhook_delivery.retry') ? (
                <Button
                  variant="link"
                  icon={RotateCw}
                  onClick={() => {
                    run(api(`/webhook-deliveries/${d.id}/retry`, { method: 'POST' }), () => {
                      loadLog(logOf);
                    });
                  }}
                >
                  {t('wh.sendAgain')}
                </Button>
              ) : null
            }
          />
        </section>
      ) : null}
      <ConfirmDialog
        open={rotating !== null}
        confirmLabel={t('wh.rotate')}
        onConfirm={() => {
          const target = rotating;
          if (target === null) return;
          run(
            api<{ secret: string }>(`/webhook-subscriptions/${target.id}/rotate-secret`, {
              method: 'POST',
            }),
            (answer) => {
              setRotating(null);
              setShownSecret({ name: target.name, secret: answer.secret });
            },
          );
        }}
        onCancel={() => {
          setRotating(null);
        }}
      >
        <p>{t('wh.rotateWarning')}</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={removing !== null}
        danger
        confirmLabel={t('common.delete')}
        onConfirm={() => {
          if (removing === null || reason.trim() === '') return;
          run(
            api(`/webhook-subscriptions/${removing.id}`, {
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
          label={t('wh.deleteReason')}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
          }}
        />
      </ConfirmDialog>
    </>
  );
}
