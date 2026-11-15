// Tests for phase 2 row 2.8b: the import and export wizard.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { autoMap, cleanUpToTransform, DataExchangePage } from './data/DataExchangePage';
import { I18nProvider } from './i18n';
import { urlOf } from './test/helpers';
import { ThemeProvider } from './theme/theme';
import { ToastProvider } from './ui/toast';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Call {
  method: string;
  path: string;
  query: string;
  body: unknown;
}
function stub(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>((input, init) => {
      const url = urlOf(input);
      const method = init?.method ?? 'GET';
      const [rawPath = url, query = ''] = url.split('?');
      const path = rawPath.replace('/api/v1', '');
      calls.push({
        method,
        path,
        query,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const hit = Object.keys(routes).find((k) => `${method} ${path}`.endsWith(k));
      if (hit === undefined) return Promise.reject(new Error(`unexpected ${method} ${url}`));
      return Promise.resolve((routes[hit] as () => Response)());
    }),
  );
  return calls;
}

const wrap = (ui: React.ReactNode, entry: string) => (
  <ThemeProvider>
    <I18nProvider>
      <ToastProvider>
        <AuthProvider>
          <MemoryRouter initialEntries={[entry]}>{ui}</MemoryRouter>
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
  'GET /entity-definitions': () =>
    json(200, { items: [{ key: 'vehicle', name: { en: 'Vehicle' }, status: 'published' }] }),
});

const target = {
  key: 'vehicle',
  label: 'Vehicle',
  fields: [
    { key: 'code', label: 'Code', required: true },
    { key: 'name', label: 'Name', required: true },
  ],
};
const job = (status: string, stats: Record<string, unknown> = {}) => ({
  id: 'j1',
  status,
  stats: { columns: ['Code', 'Name'], rowCount: 3, ...stats },
});

beforeEach(() => {
  setAccessToken(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('wizard helpers', () => {
  it('matches columns to fields by label or key, ignoring case and spacing', () => {
    expect(
      autoMap(
        [
          { key: 'plate_no', label: 'Plate number', required: true },
          { key: 'name', label: 'Name', required: false },
        ],
        ['PLATE NO', ' name ', 'Other'],
      ),
    ).toEqual({ plate_no: 'PLATE NO', name: ' name ' });
  });

  it('turns a chosen clean-up into a mapping transform', () => {
    expect(cleanUpToTransform('')).toBeUndefined();
    expect(cleanUpToTransform('upper')).toBe('upper');
    expect(cleanUpToTransform('date:DMY')).toEqual({ op: 'date', format: 'DMY' });
  });
});

describe('import wizard', () => {
  const importRoutes = (extra: Record<string, () => Response> = {}) => ({
    ...signedIn([
      'integration.import_job.create',
      'integration.import_job.rollback',
      'integration.export_job.create',
    ]),
    'GET /import-targets/vehicle': () => json(200, target),
    'GET /import-mappings': () => json(200, { items: [] }),
    'POST /files/upload-url': () =>
      json(200, { uploadToken: 'tkn', url: 'https://storage.test/up', method: 'PUT', headers: {} }),
    'PUT https://storage.test/up': () => new Response(null, { status: 200 }),
    'POST /files/complete': () => json(201, { id: 'f1' }),
    'POST /imports': () => json(201, job('uploaded')),
    ...extra,
  });

  async function uploadSheet(name: string, type: string) {
    const file = new File(['x'], name, { type });
    // jsdom's File has no arrayBuffer(); the page only needs bytes to hash.
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => Promise.resolve(new ArrayBuffer(4)),
    });
    await userEvent.upload(await screen.findByLabelText(/choose file/i), file);
  }

  it('uploads an Excel file, maps columns by heading, previews, and commits the good rows', async () => {
    const calls = stub(
      importRoutes({
        'POST /imports/j1/preview': () => json(200, job('previewed', { valid: 2, invalid: 1 })),
        'GET /imports/j1/rows': () =>
          json(200, { items: [{ rowNo: 3, errors: [{ path: 'code', message: 'Already used' }] }] }),
        'POST /imports/j1/commit': () => json(202, job('queued')),
        'GET /imports/j1': () => json(200, job('committed', { created: 2 })),
      }),
    );
    render(wrap(<DataExchangePage />, '/data?type=vehicle'));
    await uploadSheet(
      'cars.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );

    // The upload asks for the file's real type, name and size.
    const request = calls.find((c) => c.path === '/files/upload-url');
    expect(request?.body).toMatchObject({
      originalName: 'cars.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      sizeBytes: 1,
    });
    expect((request?.body as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(calls.find((c) => c.path === '/imports')?.body).toEqual({
      entityKey: 'vehicle',
      fileObjectId: 'f1',
    });

    await userEvent.click(await screen.findByRole('button', { name: /check the rows/i }));
    expect(calls.find((c) => c.path === '/imports/j1/preview')?.body).toEqual({
      mapping: { columnMap: { code: 'Code', name: 'Name' }, transforms: {} },
    });
    expect(await screen.findByText(/code: Already used/)).toBeTruthy();

    // A row has problems, so importing needs the "skip the others" choice.
    const commit = screen.getByRole('button', { name: /import now/i });
    expect((commit as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByLabelText(/only the good rows/i));
    await userEvent.click(commit);
    expect(calls.find((c) => c.path === '/imports/j1/commit')?.body).toEqual({ skipInvalid: true });
    expect(await screen.findByText(/records created/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /undo this import/i })).toBeTruthy();
  });

  it('shows the reason when the commit failed and nothing was imported', async () => {
    stub(
      importRoutes({
        'POST /imports/j1/preview': () => json(200, job('previewed', { valid: 3, invalid: 0 })),
        'GET /imports/j1/rows': () => json(200, { items: [] }),
        'POST /imports/j1/commit': () => json(202, job('queued')),
        'GET /imports/j1': () => json(200, job('failed', { error: 'Row 2: duplicate code' })),
      }),
    );
    render(wrap(<DataExchangePage />, '/data?type=vehicle'));
    await uploadSheet('cars.csv', 'text/csv');
    await userEvent.click(await screen.findByRole('button', { name: /check the rows/i }));
    await userEvent.click(await screen.findByRole('button', { name: /import now/i }));
    expect(await screen.findByText(/Row 2: duplicate code/)).toBeTruthy();
    expect(screen.getByText(/nothing was imported/i)).toBeTruthy();
  });
});

describe('export panel', () => {
  it('exports with a filter and downloads the file through the files endpoint', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    const calls = stub({
      ...signedIn(['integration.export_job.create']),
      'GET /import-targets/vehicle': () => json(200, target),
      'GET /exports': () => json(200, { items: [] }),
      'POST /exports': () =>
        json(201, {
          id: 'e1',
          entityKey: 'vehicle',
          format: 'csv',
          rowCount: 4,
          fileObjectId: 'f9',
          createdAt: '2026-11-16T10:00:00.000Z',
        }),
      'GET /files/f9/download-url': () =>
        json(200, { url: 'https://storage.test/down', expiresAt: '2026-11-16T10:05:00.000Z' }),
    });
    render(wrap(<DataExchangePage />, '/data?type=vehicle&tab=export'));
    await userEvent.click(await screen.findByRole('button', { name: /add a filter/i }));
    await userEvent.selectOptions(screen.getByLabelText('Field'), 'code');
    await userEvent.type(screen.getByLabelText(/equals/i), 'A1');
    await userEvent.selectOptions(screen.getByLabelText(/file type/i), 'csv');
    await userEvent.click(screen.getByRole('button', { name: /export and download/i }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('https://storage.test/down');
    });
    expect(calls.find((c) => c.method === 'POST' && c.path === '/exports')?.body).toEqual({
      entityKey: 'vehicle',
      format: 'csv',
      filters: { code: 'A1' },
    });
  });

  it('hides the import tab from someone who may only export', async () => {
    stub({
      ...signedIn(['integration.export_job.create']),
      'GET /import-targets/vehicle': () => json(200, target),
      'GET /exports': () => json(200, { items: [] }),
    });
    render(wrap(<DataExchangePage />, '/data?type=vehicle'));
    await screen.findByRole('button', { name: /export and download/i });
    expect(screen.queryByRole('tab', { name: /^import$/i })).toBeNull();
  });
});
