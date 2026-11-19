// Tests for phase 3 row 3.5: expiry list colours, calendar view and alert settings.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { I18nProvider } from './i18n';
import { ExpiringPage, ExpirySettingsPage, statusTone } from './people/ExpiryPages';
import { urlOf } from './test/helpers';
import { ThemeProvider } from './theme/theme';
import { ToastProvider } from './ui/toast';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function stub(routes: Record<string, () => Response>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
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

const item = (over: Record<string, unknown>) => ({
  documentId: 'd1',
  ownerType: 'party',
  ownerId: 'p1',
  ownerName: 'Rahim Example',
  employeeCode: 'E0001',
  documentName: 'Passport',
  expiryDate: '2026-12-01',
  daysLeft: 12,
  status: 'expiring',
  ...over,
});

const wrap = (page: React.ReactNode) => (
  <ThemeProvider>
    <I18nProvider>
      <ToastProvider>
        <AuthProvider>
          <MemoryRouter>{page}</MemoryRouter>
        </AuthProvider>
      </ToastProvider>
    </I18nProvider>
  </ThemeProvider>
);

afterEach(() => {
  vi.unstubAllGlobals();
  setAccessToken(null);
});

describe('expiry screens', () => {
  it('colours: expired red, expiring amber, valid green', () => {
    expect(statusTone('expired')).toBe('danger');
    expect(statusTone('expiring')).toBe('warning');
    expect(statusTone('valid')).toBe('success');
  });

  it('shows the list with days left and switches to the calendar', async () => {
    stub({
      ...signedIn(['people.document.read']),
      'GET /documents/expiring': () =>
        json(200, {
          today: '2026-11-19',
          withinDays: 30,
          items: [item({}), item({ documentId: 'd2', daysLeft: -3, status: 'expired' })],
        }),
      'GET /documents/expiry-calendar': () =>
        json(200, { month: '2026-11', days: [{ date: '2026-12-01', items: [item({})] }] }),
    });
    render(wrap(<ExpiringPage />));
    expect(await screen.findByText('12 days left')).toBeInTheDocument();
    expect(screen.getByText('Expired 3 days ago')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Calendar' }));
    expect(await screen.findByRole('heading', { name: '2026-12-01' })).toBeInTheDocument();
  });

  it('saves the settings after checking them, and refuses a bad email', async () => {
    const calls = stub({
      ...signedIn(['people.expiry_settings.read', 'people.expiry_settings.update']),
      'GET /documents/expiry-settings': () =>
        json(200, { companyId: 'c1', emails: ['a@example.test'], windows: [14, 7], version: 1 }),
      'PUT /documents/expiry-settings': () =>
        json(200, {
          companyId: 'c1',
          emails: ['a@example.test', 'b@example.test'],
          windows: [14, 7],
          version: 2,
        }),
    });
    render(wrap(<ExpirySettingsPage />));
    const emails = await screen.findByLabelText('Email list');
    await userEvent.clear(emails);
    await userEvent.type(emails, 'not-an-email');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);

    await userEvent.clear(emails);
    await userEvent.type(emails, 'a@example.test{enter}b@example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        emails: ['a@example.test', 'b@example.test'],
        windows: [14, 7],
      });
    });
  });
});
