// Tests for phase 2 row 2.11b (first part): task inbox, timeline, workflow builder.
// All data is invented.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { I18nProvider } from './i18n';
import {
  graphProblem,
  stepFromForm,
  emptyStep,
  WorkflowBuilderPage,
} from './org/WorkflowBuilderPage';
import { urlOf } from './test/helpers';
import { ThemeProvider } from './theme/theme';
import { ToastProvider } from './ui/toast';
import { actionBody, InboxPage } from './workflow/InboxPage';
import { WorkflowTimeline } from './workflow/WorkflowTimeline';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Call {
  method: string;
  path: string;
  body: unknown;
}
function stub(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>((input, init) => {
      const url = urlOf(input);
      const method = init?.method ?? 'GET';
      const [rawPath = url] = url.split('?');
      const path = rawPath.replace('/api/v1', '');
      calls.push({
        method,
        path,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const hit = Object.keys(routes).find((k) => `${method} ${path}`.endsWith(k));
      if (hit === undefined) return Promise.reject(new Error(`unexpected ${method} ${url}`));
      return Promise.resolve((routes[hit] as () => Response)());
    }),
  );
  return calls;
}

const wrap = (ui: React.ReactNode) => (
  <ThemeProvider>
    <I18nProvider>
      <ToastProvider>
        <AuthProvider>
          <MemoryRouter>{ui}</MemoryRouter>
        </AuthProvider>
      </ToastProvider>
    </I18nProvider>
  </ThemeProvider>
);

const signedIn = (permissions: string[]) => ({
  'POST /auth/refresh': () =>
    json(200, {
      accessToken: 'tok',
      expiresIn: 900,
      user: {
        id: 'u1',
        username: 'a',
        displayName: 'A',
        preferredLanguage: 'en',
        mustChangePassword: false,
      },
      companyId: 'c1',
      roles: [],
      mfaEnrolmentRequired: false,
    }),
  'GET /me/permissions': () => json(200, { permissions }),
});

beforeEach(() => {
  setAccessToken(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const entry = {
  task: { id: 'k1', instanceId: 'i1', dueAt: null, escalatedFromTaskId: null },
  instance: { entityType: 'vehicle_request', entityId: 'r1' },
  definition: { name: 'Vehicle approval' },
  stepName: 'Manager check',
};
const view = {
  instance: { id: 'i1', status: 'running', createdAt: '2026-01-01T00:00:00Z', completedAt: null },
  definition: { name: 'Vehicle approval' },
  events: [
    {
      id: 'e1',
      kind: 'started',
      stepKey: null,
      actorId: 'u1',
      detail: {},
      createdAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'e2',
      kind: 'commented',
      stepKey: 'manager',
      actorId: 'u2',
      detail: { comment: 'Looks fine' },
      createdAt: '2026-01-01T01:00:00Z',
    },
  ],
};

describe('task inbox', () => {
  it('helper: reject needs a comment, approve does not', () => {
    expect(actionBody('approve', ' ')).toEqual({ ok: true, body: {} });
    expect(actionBody('reject', ' ').ok).toBe(false);
    expect(actionBody('reject', ' too costly ')).toEqual({
      ok: true,
      body: { comment: 'too costly' },
    });
  });

  it('approves, and refuses a reject without a comment', async () => {
    const calls = stub({
      ...signedIn([]),
      'GET /tasks': () => json(200, { items: [entry] }),
      'POST /tasks/k1/approve': () => json(200, {}),
    });
    render(wrap(<InboxPage />));
    const card = await screen.findByRole('region', { name: /vehicle approval/i });
    await userEvent.click(within(card).getByRole('button', { name: /^reject$/i }));
    expect(await within(card).findByRole('alert')).toBeTruthy();
    expect(calls.some((c) => c.path.startsWith('/tasks/'))).toBe(false);

    await userEvent.type(within(card).getByLabelText('Comment'), 'ok');
    await userEvent.click(within(card).getByRole('button', { name: /^approve$/i }));
    await waitFor(() => {
      expect(calls.find((c) => c.path === '/tasks/k1/approve')?.body).toEqual({ comment: 'ok' });
    });
  });

  it('shows an empty inbox', async () => {
    stub({ ...signedIn([]), 'GET /tasks': () => json(200, { items: [] }) });
    render(wrap(<InboxPage />));
    expect(await screen.findByText('Nothing is waiting for you.')).toBeTruthy();
  });
});

describe('workflow timeline', () => {
  it('lists the events of a record workflow', async () => {
    stub({
      ...signedIn([]),
      'GET /workflow-instances': () => json(200, { items: [view.instance] }),
      'GET /workflow-instances/i1': () => json(200, view),
    });
    render(wrap(<WorkflowTimeline entityType="vehicle_request" entityId="r1" />));
    expect(await screen.findByText('Looks fine')).toBeTruthy();
    expect(screen.getByText('Started')).toBeTruthy();
  });
});

describe('workflow builder', () => {
  it('helpers: step bodies and graph problems', () => {
    const form = {
      ...emptyStep(),
      key: 'mgr',
      name: 'Manager',
      roles: 'manager, admin',
      slaHours: '48',
    };
    expect(stepFromForm(form)).toMatchObject({
      kind: 'approval',
      assignee: { roles: ['manager', 'admin'] },
      slaHours: 48,
    });
    expect(graphProblem({ steps: [stepFromForm(form)] })).toBeNull();
    // No approval at all is a mistake.
    expect(
      graphProblem({
        steps: [{ key: 'n', kind: 'notify', name: 'Tell', eventType: 'workflow.notify' }],
      }),
    ).toMatch(/approval/i);
  });

  it('adds an approval step and saves a new draft', async () => {
    const calls = stub({
      ...signedIn(['platform.workflow_definition.read', 'platform.workflow_version.create']),
      'GET /workflow-definitions': () =>
        json(200, {
          items: [
            { id: 'd1', key: 'vehicle', name: 'Vehicle approval', entityKey: 'vehicle_request' },
          ],
        }),
      'GET /workflow-versions': () => json(200, { items: [] }),
      'POST /workflow-versions': () => json(201, {}),
    });
    render(wrap(<WorkflowBuilderPage />));
    await userEvent.click(await screen.findByRole('button', { name: /^steps$/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^add step$/i }));
    const form = screen.getByRole('region', { name: /add step/i });
    await userEvent.type(within(form).getByLabelText('Step key'), 'mgr');
    await userEvent.type(within(form).getByLabelText('Name'), 'Manager');
    await userEvent.type(within(form).getByLabelText('Roles'), 'manager');
    await userEvent.click(within(form).getByRole('button', { name: /^add step$/i }));
    await userEvent.click(await screen.findByRole('button', { name: /save draft/i }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path === '/workflow-versions')).toBe(true);
    });
    expect(
      calls.find((c) => c.path === '/workflow-versions' && c.method === 'POST')?.body,
    ).toMatchObject({
      workflowDefinitionId: 'd1',
      graph: { steps: [{ key: 'mgr', kind: 'approval', assignee: { roles: ['manager'] } }] },
    });
  });
});
