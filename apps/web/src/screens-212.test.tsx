/**
 * Row 2.12 screens: pure helpers of the webhook and event screens (the request body built
 * from the subscription form, and the "handled by" summary of the event browser).
 */
import { describe, expect, it } from 'vitest';
import { handledSummary } from './org/EventsPage';
import { subscriptionBody } from './org/WebhooksPage';

describe('webhook subscription form', () => {
  it('builds the body from chosen event types, sorted and without repeats', () => {
    expect(
      subscriptionBody({
        name: ' Payroll system ',
        url: 'https://hooks.example.com/fibrex',
        allEvents: false,
        eventTypeKeys: ['workflow.completed', 'system.test', 'workflow.completed'],
      }),
    ).toEqual({
      body: {
        name: 'Payroll system',
        url: 'https://hooks.example.com/fibrex',
        eventTypeKeys: ['system.test', 'workflow.completed'],
        active: true,
      },
    });
  });

  it('sends "*" when all events are chosen', () => {
    const result = subscriptionBody({
      name: 'All',
      url: 'https://hooks.example.com/',
      allEvents: true,
      eventTypeKeys: ['system.test'],
    });
    expect(result).toMatchObject({ body: { eventTypeKeys: ['*'] } });
  });

  it('reports a bad address or an empty event list instead of sending', () => {
    expect(
      subscriptionBody({ name: 'X', url: 'ftp://x', allEvents: true, eventTypeKeys: [] }),
    ).toHaveProperty('problem');
    expect(
      subscriptionBody({
        name: 'X',
        url: 'https://a:b@hooks.example.com/',
        allEvents: true,
        eventTypeKeys: [],
      }),
    ).toHaveProperty('problem');
    expect(
      subscriptionBody({
        name: 'X',
        url: 'https://hooks.example.com/',
        allEvents: false,
        eventTypeKeys: [],
      }),
    ).toHaveProperty('problem');
  });
});

describe('event browser', () => {
  const at = '2026-11-18T10:00:00.000Z';
  it('shows waiting until the relay has handed the event on', () => {
    expect(handledSummary({ handledBy: [] })).toBeNull();
    expect(
      handledSummary({ handledBy: [{ consumer: 'notify.rules', processedAt: at }] }),
    ).toBeNull();
  });

  it('lists the consumers that handled it, without the relay', () => {
    expect(
      handledSummary({
        handledBy: [
          { consumer: 'outbox.relay', processedAt: at },
          { consumer: 'notify.rules', processedAt: at },
          { consumer: 'integration.webhooks', processedAt: at },
        ],
      }),
    ).toEqual(['notify.rules', 'integration.webhooks']);
    expect(handledSummary({ handledBy: [{ consumer: 'outbox.relay', processedAt: at }] })).toEqual(
      [],
    );
  });
});
