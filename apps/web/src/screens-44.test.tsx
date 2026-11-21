// Tests for phase 4 row 4.4: Google connection settings, the consent callback, sync sources.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { I18nProvider } from './i18n';
import { GoogleCallbackPage, GoogleConnectionPage } from './performance/GoogleConnectionPage';
import { SyncSourcesPage } from './performance/SyncSourcesPage';
import { urlOf } from './test/helpers';
import { ThemeProvider } from './theme/theme';
import { ToastProvider } from './ui/toast';

const PLATFORM = '0b8f0c8e-5f3a-4d6e-9c1a-2f7d8e9a0b1c';
const SHEET_ID = 'FakeSpreadsheetId_0123456789abcdefABCDEF';

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
      const hit = Object.keys(routes).find((k) => `${method} ${path}` === k);
      if (hit === undefined) return Promise.reject(new Error(`unexpected ${method} ${url}`));
      return Promise.resolve((routes[hit] as () => Response)());
    }),
  );
  return calls;
}

const status = (state: string, extra: Record<string, unknown> = {}) => ({
  state,
  configured: state !== 'not_configured',
  redirectUri: 'http://localhost:5173/settings/google-connection/callback',
  scope: null,
  connectedAt: null,
  connectedBy: null,
  connectedByName: null,
  problem: null,
  ...extra,
});

const base = (extra: Record<string, () => Response>) => ({
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
    json(200, {
      permissions: [
        'performance.google_connection.manage',
        'performance.sync_source.read',
        'performance.sync_source.create',
        'performance.sync_source.update',
      ],
    }),
  ...extra,
});

const wrap = (children: ReactNode, path = '/') => (
  <ThemeProvider>
    <I18nProvider>
      <ToastProvider>
        <AuthProvider>
          <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
        </AuthProvider>
      </ToastProvider>
    </I18nProvider>
  </ThemeProvider>
);

beforeEach(() => {
  setAccessToken(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Google connection (row 4.4)', () => {
  it('connects by sending the browser to the consent URL from the API', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { href: window.location.href, assign });
    const calls = stub(
      base({
        'GET /google-connection': () => json(200, status('not_connected')),
        'POST /google-connection/start': () =>
          json(200, { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' }),
      }),
    );
    render(wrap(<GoogleConnectionPage />));
    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect Google' }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?state=s');
    });
    expect(calls.some((c) => c.method === 'POST' && c.path === '/google-connection/start')).toBe(
      true,
    );
  });

  it('shows reconnect needed with the Excel fallback, and tests headers', async () => {
    const calls = stub(
      base({
        'GET /google-connection': () =>
          json(
            200,
            status('connected', { connectedAt: '2026-11-21T05:00:00Z', connectedByName: 'Owner' }),
          ),
        'POST /google-connection/test': () =>
          json(200, { ok: true, headers: ['Public ID', 'Name', ''], message: null }),
      }),
    );
    render(wrap(<GoogleConnectionPage />));
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Spreadsheet URL or id'), SHEET_ID);
    await userEvent.click(screen.getByRole('button', { name: 'Test headers' }));
    expect(await screen.findByText('2 column headers read.')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/google-connection/test')?.body).toEqual({
      spreadsheet: SHEET_ID,
      tab: 'Daily Report',
    });
  });

  it('says reconnect is needed and that the Excel upload still works', async () => {
    stub(
      base({
        'GET /google-connection': () =>
          json(200, status('reconnect_needed', { connectedAt: '2026-11-21T05:00:00Z' })),
      }),
    );
    render(wrap(<GoogleConnectionPage />));
    expect(await screen.findByText('Reconnect needed')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/Excel file/);
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('the callback posts code and state once', async () => {
    const calls = stub(
      base({
        'POST /google-connection/callback': () => json(200, status('connected')),
        'GET /google-connection': () => json(200, status('connected')),
      }),
    );
    render(
      wrap(
        <Routes>
          <Route path="/settings/google-connection/callback" element={<GoogleCallbackPage />} />
          <Route path="/settings/google-connection" element={<GoogleConnectionPage />} />
        </Routes>,
        '/settings/google-connection/callback?code=c1&state=s1',
      ),
    );
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    const posts = calls.filter((c) => c.path === '/google-connection/callback');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({ code: 'c1', state: 's1' });
  });
});

describe('Sync sources (row 4.4)', () => {
  it('checks the spreadsheet before saving, then creates the source', async () => {
    const calls = stub(
      base({
        'GET /sync-sources': () => json(200, { items: [] }),
        'GET /client-platforms': () => json(200, { items: [{ id: PLATFORM, name: 'Snoonu' }] }),
        'POST /sync-sources': () => json(201, {}),
      }),
    );
    render(wrap(<SyncSourcesPage />));
    expect(await screen.findByText('No sync sources yet.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add source' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Snoonu daily report');
    await userEvent.type(screen.getByLabelText('Spreadsheet URL or id'), 'not a sheet');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Paste the spreadsheet URL/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/sync-sources')).toBe(false);

    await userEvent.clear(screen.getByLabelText('Spreadsheet URL or id'));
    await userEvent.type(
      screen.getByLabelText('Spreadsheet URL or id'),
      `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path === '/sync-sources')).toBe(true);
    });
    expect(
      calls.find((c) => c.method === 'POST' && c.path === '/sync-sources')?.body,
    ).toMatchObject({
      clientPlatformId: PLATFORM,
      adapterKind: 'sheet',
      tab: 'Daily Report',
      scheduleCron: '0 4 * * *',
      timeZone: 'Asia/Qatar',
    });
  });
});
