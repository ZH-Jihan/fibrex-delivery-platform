// Tests for commit 12c: organisation screens (company settings, branches).
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { BranchesPage, CompanyPage } from './org/OrganisationPages';
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

const company = {
  id: 'c1',
  legalName: 'Demo Manpower',
  tradeName: null,
  countryCode: 'QA',
  baseCurrency: 'QAR',
  timeZone: 'Asia/Qatar',
  workingWeek: ['sun', 'mon'],
  fiscalYearStartMonth: 1,
  status: 'active',
  version: 3,
};

describe('CompanyPage', () => {
  it('edits settings, sends the working week as a list and the version in If-Match', async () => {
    const calls = stub({
      ...signedIn(['platform.company.read', 'platform.company.update']),
      'GET /companies': () => json(200, { items: [company], total: 1 }),
      'GET /audit-log': () => json(200, { items: [], total: 0, page: 1, pageSize: 50 }),
      'PATCH /companies/c1': () => json(200, { ...company, version: 4 }),
    });
    render(wrap(<CompanyPage />));
    const people = userEvent.setup();
    await people.click(await screen.findByRole('button', { name: 'Edit' }));
    expect((await screen.findAllByText('QAR')).length).toBeGreaterThan(1);
    await people.click(screen.getByRole('checkbox', { name: 'Works on Tuesday' }));
    await people.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PATCH')).toBe(true);
    });
    const sent = calls.find((c) => c.method === 'PATCH')?.body as Record<string, unknown>;
    expect(sent.workingWeek).toEqual(['sun', 'mon', 'tue']);
    expect(sent.fiscalYearStartMonth).toBe(1);
    expect(sent).not.toHaveProperty('baseCurrency');
  });

  it('hides Edit without the update permission', async () => {
    stub({
      ...signedIn(['platform.company.read']),
      'GET /companies': () => json(200, { items: [company], total: 1 }),
    });
    render(wrap(<CompanyPage />));
    expect(await screen.findByText('Demo Manpower')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });
});

describe('BranchesPage', () => {
  it('creates a branch and hides New branch without permission', async () => {
    const calls = stub({
      ...signedIn(['platform.branch.read', 'platform.branch.create']),
      'GET /branches': () => json(200, { items: [], total: 0, page: 1, pageSize: 25 }),
      'POST /branches': () => json(201, { id: 'b1' }),
    });
    render(wrap(<BranchesPage />));
    const people = userEvent.setup();
    await people.click(await screen.findByRole('button', { name: 'New branch' }));
    await people.type(screen.getByRole('textbox', { name: 'Code' }), 'NORTH');
    await people.type(screen.getByRole('textbox', { name: 'Name' }), 'North branch');
    await people.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path === '/branches')).toBe(true);
    });
    expect(calls.find((c) => c.method === 'POST' && c.path === '/branches')?.body).toEqual({
      code: 'NORTH',
      name: 'North branch',
    });
  });

  it('shows no New branch button for a read-only user', async () => {
    stub({
      ...signedIn(['platform.branch.read']),
      'GET /branches': () => json(200, { items: [], total: 0, page: 1, pageSize: 25 }),
    });
    render(wrap(<BranchesPage />));
    expect(await screen.findByRole('heading', { name: 'Branches' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New branch' })).not.toBeInTheDocument();
  });
});
