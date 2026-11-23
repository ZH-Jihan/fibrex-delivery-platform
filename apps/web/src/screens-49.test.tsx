// Tests for phase 4 row 4.9: the Snoonu FDB report check screen.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { I18nProvider } from './i18n';
import { FdbCheckPage } from './performance/FdbCheckPage';
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
      const [rawPath, query = ''] = url.split('?');
      const path = (rawPath ?? url).replace('/api/v1', '');
      calls.push({
        method,
        path,
        query,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const hit = Object.keys(routes).find((k) => `${method} ${path}` === k);
      if (hit === undefined) return Promise.reject(new Error(`unexpected ${method} ${url}`));
      return Promise.resolve((routes[hit] as () => Response)());
    }),
  );
  return calls;
}

const base = (permissions: string[], extra: Record<string, () => Response>) => ({
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
  ...extra,
});

const wrap = (children: ReactNode) => (
  <ThemeProvider>
    <I18nProvider>
      <ToastProvider>
        <AuthProvider>
          <MemoryRouter initialEntries={['/performance/fdb-check']}>{children}</MemoryRouter>
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

const check = {
  id: 'k1',
  businessDate: '2026-11-20',
  source: 'sheet',
  syncSourceId: 's1',
  rowsRead: 43,
  matched: 41,
  unmatched: 2,
  differences: 3,
  createdAt: '2026-11-20T06:00:00.000Z',
  createdBy: null,
};
const diff = (over: Record<string, unknown>) => ({
  id: 'd1',
  kind: 'expiry_differs',
  field: 'qid',
  partyId: 'p1',
  employeeId: 'e1',
  externalId: '9001',
  displayName: 'Amina Test',
  oursValue: '2027-01-15',
  theirsValue: '2027-02-15',
  reviewStatus: 'open',
  reviewNote: null,
  reviewedAt: null,
  ...over,
});
const listing = {
  check,
  items: [
    diff({}),
    diff({
      id: 'd2',
      kind: 'status_differs',
      field: null,
      displayName: 'Bilal Test',
      externalId: '9002',
      oursValue: 'active',
      theirsValue: 'blocked',
    }),
  ],
  openByKind: { expiry_differs: 1, status_differs: 1 },
  total: 3,
  truncated: false,
};

describe('FDB report check (row 4.9)', () => {
  it('shows the last run, the open count per kind and each difference with both values', async () => {
    stub(
      base(['performance.fdb_check.read'], {
        'GET /performance/fdb-check': () => json(200, listing),
      }),
    );
    render(wrap(<FdbCheckPage />));
    expect(await screen.findByText('Amina Test')).toBeInTheDocument();
    expect(screen.getByText(/Last check for 2026-11-20/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expiry date differs: 1' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Falcon ID not in our system: 0' }),
    ).toBeInTheDocument();
    const row = screen.getByText('Amina Test').closest('tr');
    if (row === null) throw new Error('no row');
    expect(within(row).getByText('2027-01-15')).toBeInTheDocument();
    expect(within(row).getByText('2027-02-15')).toBeInTheDocument();
    expect(within(row).getByText('QID')).toBeInTheDocument();
    // Read-only person: no run button, no review buttons.
    expect(screen.queryByRole('button', { name: 'Run check' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).not.toBeInTheDocument();
  });

  it('marks a difference reviewed and reloads', async () => {
    const calls = stub(
      base(['performance.fdb_check.read', 'performance.fdb_check.review', 'people.employee.read'], {
        'GET /performance/fdb-check': () => json(200, listing),
        'POST /performance/fdb-check/differences/d1/review': () =>
          json(200, {
            id: 'd1',
            reviewStatus: 'reviewed',
            reviewNote: null,
            reviewedAt: null,
            version: 2,
          }),
      }),
    );
    render(wrap(<FdbCheckPage />));
    await screen.findByText('Amina Test');
    expect(screen.getAllByRole('link', { name: /Open profile/ })[0]).toHaveAttribute(
      'href',
      '/employees/e1',
    );
    const [markFirst] = screen.getAllByRole('button', { name: 'Mark reviewed' });
    if (markFirst === undefined) throw new Error('no button');
    await userEvent.click(markFirst);
    await waitFor(() => {
      const post = calls.find((c) => c.path.endsWith('/review'));
      expect(post?.body).toEqual({ status: 'reviewed' });
    });
    await waitFor(() => {
      expect(
        calls.filter((c) => c.method === 'GET' && c.path === '/performance/fdb-check').length,
      ).toBe(2);
    });
  });

  it('runs the check from the chosen source and says what it found', async () => {
    const calls = stub(
      base(['performance.fdb_check.read', 'performance.fdb_check.run'], {
        'GET /performance/fdb-check': () => json(200, listing),
        'GET /sync-sources': () =>
          json(200, {
            items: [{ id: 's1', name: 'Snoonu daily report', adapterKind: 'sheet', active: true }],
          }),
        'POST /performance/fdb-check/run': () =>
          json(200, {
            checkId: 'k2',
            businessDate: '2026-11-20',
            rowsRead: 43,
            matched: 41,
            unmatched: 2,
            differences: 5,
            carriedOver: 2,
            positionalColumns: [],
          }),
      }),
    );
    render(wrap(<FdbCheckPage />));
    await screen.findByText('Amina Test');
    await userEvent.click(screen.getByRole('button', { name: 'Run check' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('option', { name: 'Snoonu daily report' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start check' }));
    await waitFor(() => {
      const post = calls.find((c) => c.path === '/performance/fdb-check/run');
      expect(post?.body).toEqual({ syncSourceId: 's1' });
    });
    expect(await screen.findByText(/Checked 43 rows: 5 differences \(2 kept/)).toBeInTheDocument();
  });

  it('says so when no check has been run', async () => {
    stub(
      base(['performance.fdb_check.read'], {
        'GET /performance/fdb-check': () =>
          json(200, { check: null, items: [], openByKind: {}, total: 0, truncated: false }),
      }),
    );
    render(wrap(<FdbCheckPage />));
    expect(await screen.findByText('No check has been run yet.')).toBeInTheDocument();
  });
});

describe('FDB check: taking dates into our records (row 4.9b)', () => {
  const missing = diff({
    id: 'd3',
    kind: 'missing_ours',
    displayName: 'Chandra Test',
    externalId: '9003',
    oursValue: null,
    theirsValue: '2027-04-01',
  });
  const withMissing = {
    ...listing,
    items: [...listing.items, missing],
    openByKind: { ...listing.openByKind, missing_ours: 1 },
  };
  const preview = {
    checkId: 'k1',
    people: 1,
    documents: 1,
    byType: [{ field: 'qid', count: 1 }],
    examples: [
      {
        differenceId: 'd3',
        displayName: 'Chandra Test',
        externalId: '9003',
        field: 'qid',
        date: '2027-04-01',
      },
    ],
    skipped: [{ reason: 'odd_date', count: 2 }],
  };

  it('hides both apply buttons without the apply permission', async () => {
    stub(
      base(
        ['performance.fdb_check.read', 'performance.fdb_check.review', 'people.document.update'],
        {
          'GET /performance/fdb-check': () => json(200, withMissing),
        },
      ),
    );
    render(wrap(<FdbCheckPage />));
    await screen.findByText('Chandra Test');
    expect(screen.queryByRole('button', { name: 'Use Snoonu date' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply all open/ })).not.toBeInTheDocument();
  });

  it('hides them when the documents write permission is missing too', async () => {
    stub(
      base(['performance.fdb_check.read', 'performance.fdb_check.apply'], {
        'GET /performance/fdb-check': () => json(200, withMissing),
      }),
    );
    render(wrap(<FdbCheckPage />));
    await screen.findByText('Chandra Test');
    expect(screen.queryByRole('button', { name: /Apply all open/ })).not.toBeInTheDocument();
  });

  it('uses the Snoonu date of one row, only on "We have no date" rows', async () => {
    const calls = stub(
      base(
        ['performance.fdb_check.read', 'performance.fdb_check.apply', 'people.document.update'],
        {
          'GET /performance/fdb-check': () => json(200, withMissing),
          'POST /performance/fdb-check/differences/d3/apply': () =>
            json(200, { line: {}, skipped: null }),
        },
      ),
    );
    render(wrap(<FdbCheckPage />));
    await screen.findByText('Chandra Test');
    const buttons = screen.getAllByRole('button', { name: 'Use Snoonu date' });
    expect(buttons).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Use Snoonu date' }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === '/performance/fdb-check/differences/d3/apply')).toBe(
        true,
      );
    });
  });

  it('previews first, then applies on Confirm and shows the result table', async () => {
    const calls = stub(
      base(
        ['performance.fdb_check.read', 'performance.fdb_check.apply', 'people.document.update'],
        {
          'GET /performance/fdb-check': () => json(200, withMissing),
          'GET /performance/fdb-check/apply-all/preview': () => json(200, preview),
          'POST /performance/fdb-check/apply-all': () =>
            json(200, {
              checkId: 'k1',
              people: 1,
              created: 1,
              updated: 0,
              applied: preview.examples,
              skipped: [
                {
                  differenceId: 'd9',
                  displayName: 'Sam Test',
                  externalId: '9009',
                  field: 'passport',
                  date: '1999-05-05',
                  reason: 'odd_date',
                },
              ],
            }),
        },
      ),
    );
    render(wrap(<FdbCheckPage />));
    await screen.findByText('Chandra Test');
    await userEvent.click(screen.getByRole('button', { name: /Apply all open/ }));
    expect(
      await screen.findByText('1 documents for 1 people will be created or filled in.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Skipped: odd date: 2')).toBeInTheDocument();
    // Nothing was written by the preview.
    expect(calls.some((c) => c.method === 'POST' && c.path.startsWith('/performance'))).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    const table = await screen.findByRole('table', { name: 'Result' });
    expect(within(table).getByText('Skipped: odd date')).toBeInTheDocument();
    expect(within(table).getByText('Applied')).toBeInTheDocument();
  });
});
