// Tests for phase 4 row 4.5a: mapping editor, sync runs list and actions.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { I18nProvider } from './i18n';
import { SNOONU_DEFAULT_MAPPING } from '@fibrex/shared';
import { MappingEditorPage } from './performance/MappingEditor';
import { SyncRunsPage } from './performance/SyncRunsPage';
import { urlOf } from './test/helpers';
import { ThemeProvider } from './theme/theme';
import { ToastProvider } from './ui/toast';

const SOURCE = '11111111-2222-4333-8444-555555555555';

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
        'performance.sync_run.read',
        'performance.sync_run.run',
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

const source = {
  id: SOURCE,
  name: 'Snoonu daily report',
  platformName: 'Snoonu',
  adapterKind: 'sheet',
  clientPlatformId: 'p1',
  spreadsheetId: 'x',
  authMode: 'service_account',
  tab: 'Daily Report',
  scheduleCron: '0 4 * * *',
  timeZone: 'Asia/Qatar',
  active: true,
  version: 1,
};

describe('Column mapping editor (row 4.5a)', () => {
  const routes = (extra: Record<string, () => Response> = {}) =>
    base({
      [`GET /sync-sources/${SOURCE}`]: () => json(200, source),
      [`GET /sync-sources/${SOURCE}/column-mappings`]: () =>
        json(200, { versions: [], effective: SNOONU_DEFAULT_MAPPING, effectiveVersion: 0 }),
      ...extra,
    });
  const open = () =>
    render(
      wrap(
        <Routes>
          <Route path="/performance/sync-sources/:id/mapping" element={<MappingEditorPage />} />
        </Routes>,
        `/performance/sync-sources/${SOURCE}/mapping`,
      ),
    );

  it('tests headers and says which mapped columns were found and which were not', async () => {
    const calls = stub(
      routes({
        [`POST /sync-sources/${SOURCE}/test-headers`]: () =>
          json(200, {
            ok: true,
            headers: ['public id', 'Name', 'Mystery column'],
            labels: ['Assigned', 'Working Hours'],
            message: null,
          }),
      }),
    );
    open();
    expect(await screen.findByText('No version saved yet', { exact: false })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Test headers' }));
    // Case does not matter: "public id" is found; "Delivered" (required) is not in the sheet.
    expect(await screen.findByText('Found: Public ID')).toBeInTheDocument();
    expect(screen.getAllByText('Not found').length).toBeGreaterThan(0);
    expect(screen.getByText('Mystery column')).toBeInTheDocument();
    const sent = calls.find((c) => c.path.endsWith('/test-headers'))?.body;
    expect(sent).toEqual({ tab: 'Daily Report', headerRow: 3, blockLabelRow: 2 });
  });

  it('saves a new version with an added alias', async () => {
    const calls = stub(
      routes({
        [`POST /sync-sources/${SOURCE}/column-mappings`]: () => json(201, { mappingVersion: 1 }),
      }),
    );
    open();
    await screen.findAllByLabelText('Header names');
    // The Name row holds exactly "Name": add "Rider name" to it.
    await userEvent.type(screen.getByDisplayValue('Name'), ', Rider name');
    await userEvent.click(screen.getByRole('button', { name: 'Save new version' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/column-mappings'))).toBe(
        true,
      );
    });
    const body = calls.find((c) => c.method === 'POST' && c.path.endsWith('/column-mappings'))
      ?.body as { mapping: { fields: { name: { aliases: string[] } } } };
    expect(body.mapping.fields.name.aliases).toEqual(['Name', 'Rider name']);
  });
});

describe('Sync runs (row 4.5a)', () => {
  const run = {
    id: '99999999-2222-4333-8444-555555555555',
    syncSourceId: SOURCE,
    businessDate: '2026-11-20',
    trigger: 'scheduled',
    status: 'partial',
    rangeFrom: null,
    rangeTo: null,
    rowsRead: 42,
    matched: 40,
    unmatched: 2,
    errorsCount: 1,
    rawInputId: null,
    snapshotReused: false,
    layoutChanged: false,
    startedAt: '2026-11-20T01:00:00.000Z',
    finishedAt: '2026-11-20T01:00:05.000Z',
  };
  it('lists runs and queues Run now for the chosen source', async () => {
    const calls = stub(
      base({
        'GET /sync-runs': () => json(200, { items: [run], total: 1, page: 1, pageSize: 25 }),
        'GET /sync-sources': () => json(200, { items: [source] }),
        [`POST /sync-sources/${SOURCE}/run`]: () =>
          json(202, { queued: true, jobId: 'j', syncSourceId: SOURCE }),
      }),
    );
    render(wrap(<SyncRunsPage />));
    expect(await screen.findByText('Partly')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    // One source only, so the buttons act on it without choosing.
    const button = screen.getByRole('button', { name: 'Run now' });
    await waitFor(() => {
      expect(button).toBeEnabled();
    });
    await userEvent.click(button);
    expect(await screen.findByText(/Queued/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/run'))).toBe(true);
  });
});
