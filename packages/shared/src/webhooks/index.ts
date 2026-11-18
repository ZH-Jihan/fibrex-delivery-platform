/**
 * Webhook subscription shapes (phase 2 row 2.12), shared by the API and the web form so
 * both accept exactly the same input.
 *
 * Event types are registered keys ("workflow.task_assigned") or "*" for every event. The
 * URL check here is only the shape (http or https, no user or password); the API adds the
 * rule that production URLs must be https to a public host.
 *
 * Depends on: zod. Used by: apps/api kernel/events/event-router.ts, apps/web
 * integration/WebhooksPage.tsx.
 */
import { z } from 'zod';

export const EVENT_TYPE_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export const webhookEventTypesSchema = z
  .array(z.string().refine((k) => k === '*' || EVENT_TYPE_KEY.test(k), 'Unknown event type form'))
  .min(1, 'Choose at least one event type')
  .max(100)
  .transform((keys) => (keys.includes('*') ? ['*'] : [...new Set(keys)].sort()));

export const webhookUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .refine((raw) => {
    try {
      const url = new URL(raw);
      return (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        url.username === '' &&
        url.password === ''
      );
    } catch {
      return false;
    }
  }, 'Enter an http(s) address without a user or password');

export const webhookSubscriptionFormSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  url: webhookUrlSchema,
  eventTypeKeys: webhookEventTypesSchema,
  active: z.boolean().default(true),
});
export type WebhookSubscriptionForm = z.input<typeof webhookSubscriptionFormSchema>;

export const WEBHOOK_DELIVERY_STATUSES = ['succeeded', 'failed'] as const;
