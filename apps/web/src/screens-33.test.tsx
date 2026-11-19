// Tests for phase 3 row 3.3a: the Employees list, create form and edit form.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { I18nProvider } from './i18n';
import { EmployeesPage, employeeEditInitial } from './people/EmployeesPage';
import { urlOf } from './test/helpers';
import { ThemeProvider } from './theme/theme';
import { ToastProvider } from './ui/toast';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
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
        headers: (init?.headers ?? {}) as Record<string, string>,
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
  'GET /parties': () => json(200, { items: [], total: 0 }),
  'GET /lookups/profession': () =>
    json(200, { items: [{ code: 'rider', label: { en: 'Rider' } }] }),
});

const employee = {
  id: 'e1',
  employeeCode: 'E0001',
  displayName: 'Rahim',
  statusCode: 'active',
  sponsorship: 'company',
  sponsorPartyId: null,
  recruitingAgentPartyId: null,
  joiningDate: '2026-01-05',
  version: 3,
};

beforeEach(() => {
  setAccessToken(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('employees screen', () => {
  it('builds edit starting values from a row', () => {
    expect(employeeEditInitial(employee).sponsorship).toBe('company');
    expect(employeeEditInitial(employee).sponsorPartyId).toBe('');
  });

  it('lists employees and hides buttons without permission', async () => {
    stub({
      ...signedIn(['people.employee.read']),
      'GET /employees': () => json(200, { items: [employee], total: 1 }),
    });
    render(wrap(<EmployeesPage />));
    await screen.findByText('E0001');
    expect(screen.queryByRole('button', { name: /new employee/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
  });

  it('creates an employee with a nested body', async () => {
    const calls = stub({
      ...signedIn(['people.employee.read', 'people.employee.create']),
      'GET /employees': () => json(200, { items: [], total: 0 }),
      'POST /employees': () => json(201, employee),
    });
    render(wrap(<EmployeesPage />));
    await userEvent.click(await screen.findByRole('button', { name: /new employee/i }));
    await userEvent.type(await screen.findByLabelText('Name (English)'), 'Rahim');
    await userEvent.type(screen.getByLabelText('Phones'), '+974 5555 1234');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path === '/employees')).toBe(true);
    });
    const post = calls.find((c) => c.method === 'POST' && c.path === '/employees');
    expect(post?.body).toMatchObject({
      person: { displayName: 'Rahim', phones: ['+97455551234'] },
      sponsorship: 'company',
    });
  });

  it('shows a form error for a phone in the wrong form and sends nothing', async () => {
    const calls = stub({
      ...signedIn(['people.employee.read', 'people.employee.create']),
      'GET /employees': () => json(200, { items: [], total: 0 }),
    });
    render(wrap(<EmployeesPage />));
    await userEvent.click(await screen.findByRole('button', { name: /new employee/i }));
    await userEvent.type(await screen.findByLabelText('Name (English)'), 'Rahim');
    await userEvent.type(screen.getByLabelText('Phones'), '55551234');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await screen.findByText(/use international form/i);
    expect(calls.some((c) => c.method === 'POST' && c.path === '/employees')).toBe(false);
  });

  it('edits with If-Match and the row version', async () => {
    const calls = stub({
      ...signedIn(['people.employee.read', 'people.employee.update']),
      'GET /employees': () => json(200, { items: [employee], total: 1 }),
      'PATCH /employees/e1': () => json(200, employee),
    });
    render(wrap(<EmployeesPage />));
    await userEvent.click(await screen.findByRole('button', { name: /edit/i }));
    await userEvent.click(await screen.findByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PATCH')).toBe(true);
    });
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.headers['If-Match']).toBe('"3"');
    expect(patch?.body).toMatchObject({ sponsorship: 'company', sponsorPartyId: null });
  });
});
