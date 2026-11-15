// Tests for phase 2 row 2.2: the numbering sequences settings screen.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { I18nProvider } from './i18n';
import { liveSample, NumberSequencesPage } from './org/NumberSequencesPage';
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
      const path = (url.split('?')[0] ?? url).replace('/api/v1', '');
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
  'GET /me/permissions': () =>
    json(200, { userId: 'u1', partyId: null, companyId: 'c1', roles: [], permissions, scopes: [] }),
});

const loan = {
  id: 's1',
  key: 'loan',
  prefix: '',
  format: 'L{0000}',
  padding: 4,
  resetPolicy: 'never',
  nextValue: 7,
  sample: 'L0007',
  version: 3,
};

beforeEach(() => {
  setAccessToken(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('numbering sequences screen', () => {
  it('lists sequences with the next number and creates one with the shared rules', async () => {
    const calls = stub({
      ...signedIn(['platform.number_sequence.read', 'platform.number_sequence.create']),
      'GET /number-sequences': () => json(200, { items: [loan], total: 1 }),
      'POST /number-sequences': () => json(201, { ...loan, id: 's2', key: 'invoice' }),
    });
    render(wrap(<NumberSequencesPage />));
    expect(await screen.findByText('L0007')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /new sequence/i }));
    await user.type(screen.getByLabelText('Key'), 'invoice');
    const format = screen.getByLabelText('Pattern');
    await user.clear(format);
    await user.type(format, 'INV-{{0000}');
    await user.selectOptions(screen.getByLabelText('Restarts'), 'yearly');
    await user.click(screen.getByRole('button', { name: /save/i }));
    // Refused by the shared schema before any request: yearly needs a year token.
    expect(await screen.findByText(/needs \{YYYY\} or \{YY\}/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/number-sequences')).toHaveLength(0);
    await user.clear(format);
    await user.type(format, 'INV-{{YYYY}-{{00000}');
    await user.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(calls.filter((c) => c.method === 'POST' && c.path === '/number-sequences')).toHaveLength(
        1,
      );
    });
    expect(calls.find((c) => c.method === 'POST' && c.path === '/number-sequences')?.body).toEqual({
      key: 'invoice',
      prefix: '',
      format: 'INV-{YYYY}-{00000}',
      padding: 4,
      resetPolicy: 'yearly',
      nextValue: 1,
    });
  });

  it('hides the create button without the permission', async () => {
    stub({
      ...signedIn(['platform.number_sequence.read']),
      'GET /number-sequences': () => json(200, { items: [loan], total: 1 }),
    });
    render(wrap(<NumberSequencesPage />));
    expect(await screen.findByText('L0007')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new sequence/i })).not.toBeInTheDocument();
  });

  it('renders a live sample from the form values', () => {
    const year = String(new Date().getUTCFullYear());
    expect(
      liveSample({ prefix: '', format: 'INV-{YYYY}-{00000}', padding: 4, resetPolicy: 'yearly', nextValue: 12 }),
    ).toEqual({ sample: `INV-${year}-00012` });
    expect(
      liveSample({ prefix: 'L', format: '{prefix}{number}', padding: 3, resetPolicy: 'yearly', nextValue: 1 }),
    ).toHaveProperty('problem');
  });
});
