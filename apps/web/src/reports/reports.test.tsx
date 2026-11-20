// Tests for phase 2 row 2.13: the generic report page.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from '../api/client';
import { AuthProvider } from '../auth/AuthContext';
import { I18nProvider } from '../i18n';
import { urlOf } from '../test/helpers';
import { ThemeProvider } from '../theme/theme';
import { ToastProvider } from '../ui/toast';
import { ReportsPage } from './ReportsPage';

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

const wrap = (entry: string) => (
  <ThemeProvider>
    <I18nProvider>
      <ToastProvider>
        <AuthProvider>
          <MemoryRouter initialEntries={[entry]}>
            <ReportsPage />
          </MemoryRouter>
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

const meta = {
  key: 'integration.export_log',
  label: 'Export log',
  description: 'Bulk exports.',
  columns: [
    { key: 'entityKey', label: 'Record type', type: 'text', sortable: true },
    { key: 'rowCount', label: 'Rows', type: 'number', sortable: true },
  ],
  filters: [
    { key: 'entityKey', label: 'Record type', type: 'text' },
    { key: 'from', label: 'From date', type: 'date' },
  ],
};
const list = { items: [{ key: meta.key, label: 'Export log', description: 'Bulk exports.' }] };
const rows = {
  rows: [
    { entityKey: 'vehicle', rowCount: 10 },
    { entityKey: 'driver', rowCount: 20 },
  ],
  total: 2,
  page: 1,
  pageSize: 25,
};

beforeEach(() => {
  setAccessToken(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ReportsPage', () => {
  it('says so when there are no reports', async () => {
    stub({ ...signedIn([]), 'GET /reports': () => json(200, { items: [] }) });
    render(wrap('/reports'));
    expect(await screen.findByText(/no reports yet/i)).toBeInTheDocument();
  });

  it('shows a lookup filter as a dropdown of names and sends the id', async () => {
    const calls = stub({
      ...signedIn([]),
      'GET /reports': () => json(200, list),
      'GET /reports/integration.export_log/meta': () =>
        json(200, {
          ...meta,
          filters: [
            {
              key: 'documentTypeId',
              label: 'Document type',
              type: 'select',
              lookup: '/document-types',
            },
          ],
        }),
      'GET /document-types': () =>
        json(200, {
          items: [
            { id: '11111111-1111-4111-8111-111111111111', code: 'QID', name: { en: 'Qatar ID' } },
            { id: '22222222-2222-4222-8222-222222222222', code: 'PP', name: { en: 'Passport' } },
          ],
        }),
      'POST /reports/integration.export_log/run': () => json(200, rows),
    });
    render(wrap('/reports?report=integration.export_log'));
    const select = await screen.findByLabelText('Document type');
    expect(await screen.findByRole('option', { name: 'Passport' })).toBeInTheDocument();
    await userEvent.selectOptions(select, 'Passport');
    await userEvent.click(screen.getByRole('button', { name: /run report/i }));
    await waitFor(() => {
      expect(calls.find((c) => c.path.endsWith('/run'))?.body).toMatchObject({
        filters: { documentTypeId: '22222222-2222-4222-8222-222222222222' },
      });
    });
  });

  it('runs a report with checked filters, sorts it and shows the rows', async () => {
    const calls = stub({
      ...signedIn([]),
      'GET /reports': () => json(200, list),
      'GET /reports/integration.export_log/meta': () => json(200, meta),
      'POST /reports/integration.export_log/run': () => json(200, rows),
    });
    render(wrap('/reports?report=integration.export_log'));
    await userEvent.type(await screen.findByLabelText('Record type'), 'vehicle');
    await userEvent.click(screen.getByRole('button', { name: /run report/i }));
    expect(await screen.findByText('driver')).toBeInTheDocument();
    expect(screen.getByText('2 rows')).toBeInTheDocument();
    expect(calls.find((c) => c.path.endsWith('/run'))?.body).toEqual({
      filters: { entityKey: 'vehicle' },
      page: 1,
      pageSize: 25,
    });

    await userEvent.click(screen.getByRole('button', { name: /sort by rows/i }));
    await waitFor(() => {
      expect(calls.filter((c) => c.path.endsWith('/run'))).toHaveLength(2);
    });
    expect(calls.filter((c) => c.path.endsWith('/run'))[1]?.body).toMatchObject({
      sort: { key: 'rowCount', direction: 'asc' },
    });
  });

  it("shows the server's refusal instead of rows", async () => {
    stub({
      ...signedIn([]),
      'GET /reports': () => json(200, list),
      'GET /reports/integration.export_log/meta': () => json(200, meta),
      'POST /reports/integration.export_log/run': () =>
        json(400, {
          type: 'about:blank',
          title: 'Validation failed',
          status: 400,
          code: 'validation_failed',
          detail: 'The request contains invalid fields',
        }),
    });
    render(wrap('/reports?report=integration.export_log'));
    await userEvent.click(await screen.findByRole('button', { name: /run report/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('2 rows')).toBeNull();
  });

  it('offers export and save only to people who hold the permissions', async () => {
    stub({
      ...signedIn([]),
      'GET /reports': () => json(200, list),
      'GET /reports/integration.export_log/meta': () => json(200, meta),
    });
    render(wrap('/reports?report=integration.export_log'));
    await screen.findByRole('button', { name: /run report/i });
    expect(screen.queryByRole('button', { name: /export as csv/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /save this view/i })).toBeNull();
  });

  it('exports and downloads through the files endpoint', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    const calls = stub({
      ...signedIn(['platform.report.export']),
      'GET /reports': () => json(200, list),
      'GET /reports/integration.export_log/meta': () => json(200, meta),
      'POST /reports/integration.export_log/export': () =>
        json(201, { fileId: 'f1', fileName: 'x.csv', format: 'csv', rowCount: 2 }),
      'GET /files/f1/download-url': () =>
        json(200, { url: 'https://storage.test/x', expiresAt: '2026-11-18T10:05:00.000Z' }),
    });
    render(wrap('/reports?report=integration.export_log'));
    await userEvent.click(await screen.findByRole('button', { name: /export as csv/i }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('https://storage.test/x');
    });
    expect(calls.find((c) => c.path.endsWith('/export'))?.body).toEqual({
      format: 'csv',
      filters: {},
    });
  });

  it('saves the current filters under a name', async () => {
    const calls = stub({
      ...signedIn(['platform.saved_report.create']),
      'GET /reports': () => json(200, list),
      'GET /reports/integration.export_log/meta': () => json(200, meta),
      'POST /saved-reports': () =>
        json(201, {
          id: 's1',
          name: 'Vehicles',
          filters: { entityKey: 'vehicle' },
          ownerUserId: 'u1',
        }),
    });
    render(wrap('/reports?report=integration.export_log'));
    await userEvent.type(await screen.findByLabelText('Record type'), 'vehicle');
    await userEvent.type(screen.getByLabelText(/name for this view/i), 'Vehicles');
    await userEvent.click(screen.getByRole('button', { name: /save this view/i }));
    await waitFor(() => {
      expect(calls.find((c) => c.path === '/saved-reports')?.body).toEqual({
        reportKey: 'integration.export_log',
        name: 'Vehicles',
        filters: { entityKey: 'vehicle' },
      });
    });
  });
});
