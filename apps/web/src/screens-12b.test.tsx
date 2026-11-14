// Tests for commit 12b: user memberships tab, recycle bin, audit verify.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MembershipsTab } from './admin/MembershipsTab';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { AuditPage } from './audit/AuditPage';
import { RecycleBinPage } from './audit/RecycleBinPage';
import { I18nProvider } from './i18n';
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

beforeEach(() => {
  setAccessToken(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MembershipsTab', () => {
  it('adds a company with a role and saves the whole list', async () => {
    const calls = stub({
      ...signedIn(['iam.user.manage_access']),
      'GET /users/u9/memberships': () => json(200, { memberships: [] }),
      'GET /me/companies': () =>
        json(200, { items: [{ id: 'c1', name: 'Acme', isDefault: true, current: true }] }),
      'GET /roles': () => json(200, { items: [{ id: 'r1', name: 'Viewer' }], total: 1 }),
      'PUT /users/u9/memberships': () => json(200, { memberships: [] }),
    });
    render(wrap(<MembershipsTab userId="u9" />));
    const people = userEvent.setup();
    expect(await screen.findByText(/cannot sign in/)).toBeInTheDocument();
    await people.click(await screen.findByRole('button', { name: 'Add company' }));
    await people.click(await screen.findByRole('checkbox', { name: 'Viewer' }));
    await people.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PUT')).toBe(true);
    });
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      memberships: [{ companyId: 'c1', roleIds: ['r1'], isDefault: true, status: 'active' }],
    });
  });
});

describe('RecycleBinPage', () => {
  it('lists a type, then restores a record', async () => {
    const calls = stub({
      ...signedIn(['recycle_bin.view', 'recycle_bin.restore']),
      'GET /recycle-bin': () =>
        json(200, {
          types: [{ entityType: 'party.party', moduleKey: 'party', label: 'Party', count: 1 }],
          items: [{ id: 'p1', description: 'Old Co', deletedAt: null, deleteReason: 'duplicate' }],
          total: 1,
        }),
      'POST /recycle-bin/party.party/p1/restore': () => json(200, {}),
    });
    render(wrap(<RecycleBinPage />));
    const people = userEvent.setup();
    await people.selectOptions(await screen.findByLabelText('Record type'), 'party.party');
    await people.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/restore'))).toBe(true);
    });
  });
});

describe('AuditPage', () => {
  it('shows the verification result', async () => {
    stub({
      ...signedIn(['audit.log.read', 'audit.log.verify']),
      'GET /audit-log/verify': () => json(200, { ok: true, sealsChecked: 2, rowsChecked: 10 }),
      'GET /audit-log': () => json(200, { items: [], total: 0, page: 1, pageSize: 50 }),
    });
    render(wrap(<AuditPage />));
    const people = userEvent.setup();
    await people.click(await screen.findByRole('button', { name: 'Verify integrity' }));
    expect(await screen.findByText(/Audit log is intact/)).toBeInTheDocument();
  });
});
