// Tests for phase 2 row 2.10: the state machines screen. All data is invented.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { I18nProvider } from './i18n';
import { splitFields, stateBody, StateMachinesPage, transitionBody } from './org/StateMachinesPage';
import { urlOf } from './test/helpers';
import { ThemeProvider } from './theme/theme';
import { ToastProvider } from './ui/toast';

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

const machine = { id: 'm1', entityKey: 'vehicle_request', name: 'Vehicle requests', version: 1 };
const state = (code: string, label: string, extra: object = {}) => ({
  id: `s-${code}`,
  code,
  labels: { en: label, bn: 'x' },
  category: 'open',
  isInitial: false,
  isFinal: false,
  colour: null,
  sortOrder: 0,
  version: 1,
  ...extra,
});
const states = [
  state('draft', 'Draft', { isInitial: true, sortOrder: 1 }),
  state('submitted', 'Submitted', { sortOrder: 2 }),
  state('approved', 'Approved', { isFinal: true, sortOrder: 3 }),
];
const transition = {
  id: 't1',
  fromCode: 'draft',
  toCode: 'submitted',
  permissionKey: null,
  requiredFields: ['plate'],
  reasonRequired: false,
  reasonLookupTypeId: null,
  version: 1,
};
const lists = () => ({
  'GET /state-machines': () => json(200, { items: [machine], total: 1 }),
  'GET /states': () => json(200, { items: states, total: 3 }),
  'GET /state-transitions': () => json(200, { items: [transition], total: 1 }),
});

describe('state machines screen', () => {
  it('helpers: field lists and request bodies', () => {
    expect(splitFields(' plate, seats ,')).toEqual(['plate', 'seats']);
    expect(
      stateBody(
        {
          code: ' done ',
          label: ' Done ',
          category: 'closed',
          isInitial: false,
          isFinal: true,
          colour: '',
        },
        { bn: 'x' },
      ),
    ).toEqual({
      code: 'done',
      labels: { bn: 'x', en: 'Done' },
      category: 'closed',
      isInitial: false,
      isFinal: true,
      colour: null,
    });
    expect(
      transitionBody({
        fromCode: 'a',
        toCode: 'b',
        permissionKey: ' ',
        requiredFields: 'plate',
        reasonRequired: true,
        reasonLookupTypeId: '',
      }),
    ).toEqual({
      fromCode: 'a',
      toCode: 'b',
      permissionKey: null,
      requiredFields: ['plate'],
      reasonRequired: true,
      reasonLookupTypeId: null,
    });
  });

  it('shows states and transitions and adds a transition', async () => {
    const calls = stub({
      ...signedIn(['platform.state_machine.read', 'platform.state_transition.create']),
      ...lists(),
      'POST /state-transitions': () => json(201, { ...transition, id: 't2' }),
    });
    render(wrap(<StateMachinesPage />));
    await userEvent.click(await screen.findByRole('button', { name: /^states$/i }));
    expect(await screen.findByText('First state')).toBeTruthy();
    expect(screen.getByText('Final state')).toBeTruthy();
    expect(screen.getByText('Change the record')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /add transition/i }));
    const form = screen.getByRole('region', { name: /add transition/i });
    const from = within(form).getByLabelText('From');
    // Nothing leaves a final state, so it is not offered as a start.
    expect(within(from).queryByRole('option', { name: 'Approved' })).toBeNull();
    await userEvent.selectOptions(from, 'submitted');
    await userEvent.selectOptions(within(form).getByLabelText('To'), 'approved');
    await userEvent.type(within(form).getByLabelText('Required fields'), 'seats, plate');
    await userEvent.click(within(form).getByLabelText('A reason is required'));
    await userEvent.click(within(form).getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path === '/state-transitions')).toBe(true);
    });
    expect(calls.find((c) => c.method === 'POST' && c.path === '/state-transitions')?.body).toEqual(
      {
        stateMachineId: 'm1',
        fromCode: 'submitted',
        toCode: 'approved',
        permissionKey: null,
        requiredFields: ['seats', 'plate'],
        reasonRequired: true,
        reasonLookupTypeId: null,
      },
    );
  });

  it('edits a state without sending its code and refuses first-and-final', async () => {
    const calls = stub({
      ...signedIn(['platform.state_machine.read', 'platform.state.update']),
      ...lists(),
      'PATCH /states/s-submitted': () => json(200, states[1]),
    });
    render(wrap(<StateMachinesPage />));
    await userEvent.click(await screen.findByRole('button', { name: /^states$/i }));
    const edits = await screen.findAllByRole('button', { name: /^edit$/i });
    const edit = edits[1];
    if (edit === undefined) throw new Error('no edit button for the second state');
    await userEvent.click(edit);
    const form = screen.getByRole('region', { name: /edit state/i });
    expect(within(form).getByLabelText<HTMLInputElement>('Code').readOnly).toBe(true);

    await userEvent.click(within(form).getByLabelText('New records start here'));
    await userEvent.click(within(form).getByLabelText('Final: nothing moves on from here'));
    await userEvent.click(within(form).getByRole('button', { name: /^save$/i }));
    expect(await within(form).findByRole('alert')).toBeTruthy();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);

    await userEvent.click(within(form).getByLabelText('New records start here'));
    await userEvent.click(within(form).getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
        labels: { en: 'Submitted', bn: 'x' },
        category: 'open',
        isInitial: false,
        isFinal: true,
        colour: null,
      });
    });
  });
});
