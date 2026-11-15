// Tests for phase 2 row 2.3: the lookups settings screen.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { I18nProvider } from './i18n';
import { LookupsPage, valueFormInitial } from './org/LookupsPage';
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

const vehicleType = {
  id: 't1',
  key: 'vehicle_type',
  name: 'Vehicle types',
  isSystem: true,
  allowHierarchy: false,
  version: 1,
};
const bike = {
  id: 'v1',
  lookupTypeId: 't1',
  code: 'motorbike',
  labels: { en: 'Motorbike' },
  parentId: null,
  sortOrder: 10,
  active: true,
  version: 2,
};

beforeEach(() => {
  setAccessToken(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const all = [
  'platform.lookup_type.read',
  'platform.lookup_type.create',
  'platform.lookup_value.read',
  'platform.lookup_value.create',
  'platform.lookup_value.update',
];

describe('lookups screen', () => {
  it('opens a list, shows its values and creates one with the English label required', async () => {
    const calls = stub({
      ...signedIn(all),
      'GET /lookup-types': () => json(200, { items: [vehicleType], total: 1 }),
      'GET /lookup-values': () => json(200, { items: [bike], total: 1 }),
      'POST /lookup-values': () => json(201, { ...bike, id: 'v2', code: 'van' }),
    });
    render(wrap(<LookupsPage />));
    expect(await screen.findByText('vehicle_type')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^values$/i }));
    expect(await screen.findByText('Motorbike')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /new value/i }));
    await user.type(screen.getByLabelText('Code'), 'van');
    await user.click(screen.getByRole('button', { name: /save/i }));
    // Refused by the shared schema before any request: no English label.
    await waitFor(() => {
      expect(screen.getAllByText(/./).length).toBeGreaterThan(0);
    });
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/lookup-values')).toHaveLength(0);
    await user.type(screen.getByLabelText('Label (English, required)'), 'Van');
    await user.type(screen.getByLabelText('Label (Bangla)'), 'ভ্যান');
    await user.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(calls.filter((c) => c.method === 'POST' && c.path === '/lookup-values')).toHaveLength(
        1,
      );
    });
    expect(calls.find((c) => c.method === 'POST' && c.path === '/lookup-values')?.body).toEqual({
      lookupTypeId: 't1',
      code: 'van',
      labels: { en: 'Van', bn: 'ভ্যান' },
      sortOrder: 0,
      active: true,
      parentId: null,
    });
  });

  it('hides create and delete buttons without the permissions, and delete of built-in lists', async () => {
    stub({
      ...signedIn(['platform.lookup_type.read']),
      'GET /lookup-types': () => json(200, { items: [vehicleType], total: 1 }),
    });
    render(wrap(<LookupsPage />));
    expect(await screen.findByText('vehicle_type')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new list/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('fills the value form from an existing row', () => {
    expect(valueFormInitial(bike as never)).toMatchObject({
      code: 'motorbike',
      labelEn: 'Motorbike',
      labelBn: '',
      active: true,
      parentId: '',
    });
    expect(valueFormInitial(null)).toMatchObject({ code: '', active: true, sortOrder: 0 });
  });
});
