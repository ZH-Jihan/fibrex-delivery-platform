// Tests for phase 4 row 4.8b: the Tracking tab, operator periods, Status differences, and the
// call sheet's progress bar, export and low-hours setting. Synthetic names and numbers only.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { I18nProvider } from './i18n';
import { urlOf } from './test/helpers';
import { ThemeProvider } from './theme/theme';
import { CallSheetPage } from './tracking/CallSheetPage';
import { PersonTrackingTab } from './tracking/PersonTrackingTab';
import { StatusDifferencesPage } from './tracking/StatusDifferencesPage';
import { ToastProvider } from './ui/toast';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
interface Call {
  method: string;
  path: string;
  query: string;
  body: unknown;
}
function stub(routes: Record<string, (query: URLSearchParams) => Response>) {
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
      const hit = Object.keys(routes).find((k) => `${method} ${path}` === k);
      if (hit === undefined) return Promise.reject(new Error(`unexpected ${method} ${url}`));
      return Promise.resolve(
        (routes[hit] as (q: URLSearchParams) => Response)(new URLSearchParams(query)),
      );
    }),
  );
  return calls;
}

const base = (permissions: string[], extra: Record<string, (q: URLSearchParams) => Response>) => ({
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
  'GET /lookups/call_outcome': () =>
    json(200, {
      items: [
        { id: 'o-reached', code: 'reached', labels: { en: 'Reached' } },
        { id: 'o-off', code: 'switched_off', labels: { en: 'Switched off' } },
      ],
    }),
  'GET /lookups/status_reason': () =>
    json(200, { items: [{ id: 'r-left', code: 'left', labels: { en: 'Left the job' } }] }),
  'GET /state-machines': () => json(200, { items: [{ id: 'sm1' }] }),
  'GET /states': () =>
    json(200, {
      items: [
        { code: 'active', labels: { en: 'Active' }, sortOrder: 1 },
        { code: 'inactive', labels: { en: 'Inactive' }, sortOrder: 2 },
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

function nth<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error('no such item');
  return item;
}

const HISTORY = {
  partyId: 'party-1',
  employeeId: 'emp-1',
  entries: [],
  statusHistory: [
    {
      id: 's1',
      fromCode: 'active',
      toCode: 'inactive',
      effectiveDate: '2026-10-01',
      reasonId: 'r-left',
      note: 'Went home',
      actorId: 'u-admin',
      at: '2026-10-01T06:00:00.000Z',
    },
    {
      id: 's2',
      fromCode: 'inactive',
      toCode: 'active',
      effectiveDate: '2026-11-10',
      reasonId: null,
      note: null,
      actorId: null,
      at: '2026-11-10T06:00:00.000Z',
    },
  ],
  calls: [
    {
      id: 'c1',
      businessDate: '2026-11-20',
      at: '2026-11-20T05:30:00.000Z',
      outcomeId: 'o-reached',
      outcomeCode: 'reached',
      callerUserId: 'u-caller',
      note: 'Will start tomorrow',
    },
  ],
  operatorPeriods: [
    {
      id: 'p1',
      partyIdentifierId: 'i1',
      ownerPartyId: 'party-1',
      operatorPartyId: null,
      operatorName: 'Test Stand-in',
      operatorPhone: '+97455500099',
      fromDate: '2026-11-01',
      toDate: null,
      codAtHandover: null,
      currency: null,
      ordersAtHandover: null,
      note: 'Rider on leave',
      createdBy: 'u-admin',
      version: 1,
    },
    {
      id: 'p0',
      partyIdentifierId: 'i1',
      ownerPartyId: 'party-1',
      operatorPartyId: null,
      operatorName: 'Test Earlier',
      operatorPhone: null,
      fromDate: '2026-09-01',
      toDate: '2026-09-10',
      codAtHandover: null,
      currency: null,
      ordersAtHandover: null,
      note: null,
      createdBy: null,
      version: 1,
    },
  ],
  platformIds: [{ identifierId: 'i1', type: 'falcon_id', value: '91001' }],
  users: { 'u-admin': 'Test Admin', 'u-caller': 'Test Caller' },
};

describe('Tracking tab (row 4.8b)', () => {
  it('lists status changes, calls and operator periods newest first with who did it', async () => {
    stub(
      base(['tracking.entry.view'], { 'GET /tracking/party-1/history': () => json(200, HISTORY) }),
    );
    render(wrap(<PersonTrackingTab partyId="party-1" />));
    expect(await screen.findByText('Went home')).toBeInTheDocument();
    const status = nth(screen.getAllByRole('table'), 0);
    const dates = within(status)
      .getAllByRole('row')
      .slice(1)
      .map((r) => within(r).getAllByRole('cell')[0]?.textContent);
    expect(dates).toEqual(['2026-11-10', '2026-10-01']);
    expect(within(status).getByText('Test Admin')).toBeInTheDocument();
    expect(within(status).getByText('System')).toBeInTheDocument();
    expect(screen.getByText('Will start tomorrow')).toBeInTheDocument();
    expect(screen.getByText('Test Caller')).toBeInTheDocument();
    const periods = nth(screen.getAllByRole('table'), 2);
    const first = nth(within(periods).getAllByRole('row'), 1);
    expect(within(first).getByText('Test Stand-in')).toBeInTheDocument();
    expect(within(first).getByText('Ongoing')).toBeInTheDocument();
    expect(within(first).getByText('Test Admin')).toBeInTheDocument();
  });

  it('is read-only without the update permission', async () => {
    stub(
      base(['tracking.entry.view'], { 'GET /tracking/party-1/history': () => json(200, HISTORY) }),
    );
    render(wrap(<PersonTrackingTab partyId="party-1" />));
    await screen.findByText('Test Stand-in');
    expect(screen.queryByRole('button', { name: 'Add period' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'End period' })).not.toBeInTheDocument();
  });

  it('shows empty states when nothing has been recorded', async () => {
    stub(
      base(['tracking.entry.view'], {
        'GET /tracking/party-1/history': () =>
          json(200, { ...HISTORY, statusHistory: [], calls: [], operatorPeriods: [] }),
      }),
    );
    render(wrap(<PersonTrackingTab partyId="party-1" />));
    expect(await screen.findByText('No status changes recorded.')).toBeInTheDocument();
    expect(screen.getByText('No calls logged.')).toBeInTheDocument();
    expect(screen.getByText("Nobody else has worked this person's IDs.")).toBeInTheDocument();
  });

  it('adds a period, and shows the server message when it overlaps another', async () => {
    let attempt = 0;
    const calls = stub(
      base(['tracking.entry.view', 'tracking.entry.create', 'tracking.entry.update'], {
        'GET /tracking/party-1/history': () => json(200, HISTORY),
        'POST /tracking/operator-periods': () => {
          attempt += 1;
          return attempt === 1
            ? json(409, {
                type: 'about:blank',
                title: 'Conflict',
                status: 409,
                code: 'operator_period_overlap',
                detail:
                  'Someone else is already recorded as working this ID on some of these days.',
              })
            : json(201, { id: 'p2' });
        },
      }),
    );
    render(wrap(<PersonTrackingTab partyId="party-1" />));
    await screen.findByText('Test Stand-in');
    await userEvent.click(screen.getByRole('button', { name: 'Add period' }));
    const dialog = await screen.findByRole('dialog');
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Operator name'), 'Test Cover');
    await userEvent.type(within(dialog).getByLabelText('Note'), 'Overlapping cover');
    await userEvent.click(save);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Someone else is already recorded as working this ID on some of these days.',
    );
    // Nothing was saved: the dialog stays open and no success message appeared.
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    const posts = calls.filter((c) => c.path === '/tracking/operator-periods');
    expect(posts[0]?.body).toMatchObject({
      partyIdentifierId: 'i1',
      operatorName: 'Test Cover',
      note: 'Overlapping cover',
    });
  });

  it('ends an ongoing period with an end date, refusing one before the start', async () => {
    const calls = stub(
      base(['tracking.entry.view', 'tracking.entry.update'], {
        'GET /tracking/party-1/history': () => json(200, HISTORY),
        'PATCH /tracking/operator-periods/p1': () => json(200, { id: 'p1' }),
      }),
    );
    render(wrap(<PersonTrackingTab partyId="party-1" />));
    await screen.findByText('Test Stand-in');
    // Only the ongoing period offers "End period".
    expect(screen.getAllByRole('button', { name: 'End period' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'End period' }));
    const dialog = await screen.findByRole('dialog');
    const date = within(dialog).getByLabelText('End date');
    await userEvent.clear(date);
    await userEvent.type(date, '2026-10-01');
    expect(
      within(dialog).getByText('The end date cannot be before the start date.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.clear(date);
    await userEvent.type(date, '2026-11-15');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PATCH')).toBe(true);
    });
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      version: 1,
      toDate: '2026-11-15',
    });
  });

  it('edits the details of a period', async () => {
    const calls = stub(
      base(['tracking.entry.view', 'tracking.entry.update'], {
        'GET /tracking/party-1/history': () => json(200, HISTORY),
        'PATCH /tracking/operator-periods/p0': () => json(200, { id: 'p0' }),
      }),
    );
    render(wrap(<PersonTrackingTab partyId="party-1" />));
    await screen.findByText('Test Earlier');
    await userEvent.click(nth(screen.getAllByRole('button', { name: 'Edit' }), 1));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Note'), 'Corrected dates');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PATCH')).toBe(true);
    });
    expect(calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({
      version: 1,
      fromDate: '2026-09-01',
      toDate: '2026-09-10',
      operatorName: 'Test Earlier',
      note: 'Corrected dates',
    });
  });
});

const ITEM = {
  partyId: 'party-1',
  employeeId: 'emp-1',
  employeeCode: 'E0001',
  name: 'Test Rider 1',
  platformIds: ['91001'],
  entry: null,
  ourStatus: 'active',
  sheetStatus: { text: 'Blocked', code: 'blocked' },
  orders: 0,
  kinds: ['status_mismatch', 'active_no_orders'],
};

describe('Status differences (row 4.8b)', () => {
  it('lists the differences with a finding label and the one-tap actions', async () => {
    const calls = stub(
      base(
        [
          'tracking.entry.view',
          'tracking.entry.create',
          'tracking.status.apply',
          'people.employee.read',
        ],
        {
          'GET /tracking/cross-check': () =>
            json(200, {
              date: '2026-11-23',
              figuresDate: '2026-11-22',
              reported: true,
              items: [ITEM],
            }),
          'POST /tracking/entries': () => json(201, { id: 'e1' }),
        },
      ),
    );
    render(wrap(<StatusDifferencesPage />));
    expect(await screen.findByText('Test Rider 1')).toBeInTheDocument();
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.getByText('Status differs from sheet')).toBeInTheDocument();
    expect(screen.getByText('Active, no orders')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open profile/ })).toHaveAttribute(
      'href',
      '/employees/emp-1',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Set status' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(within(dialog).getByRole('option', { name: 'Inactive' })).toBeInTheDocument();
    });
    await userEvent.selectOptions(within(dialog).getByLabelText('New status'), 'active');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save status' }));
    expect(await screen.findByText('Status saved.')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/tracking/entries')?.body).toMatchObject({
      partyId: 'party-1',
      statusCode: 'active',
    });
    // The list is read again after saving.
    expect(calls.filter((c) => c.path === '/tracking/cross-check').length).toBeGreaterThan(1);
  });

  it('changes an existing entry instead of starting a second one for the day', async () => {
    const calls = stub(
      base(['tracking.entry.view', 'tracking.entry.update', 'tracking.status.apply'], {
        'GET /tracking/cross-check': () =>
          json(200, {
            date: '2026-11-23',
            figuresDate: '2026-11-22',
            reported: true,
            items: [{ ...ITEM, entry: { id: 'e9', version: 3 } }],
          }),
        'PATCH /tracking/entries/e9': () => json(200, { id: 'e9' }),
      }),
    );
    render(wrap(<StatusDifferencesPage />));
    await screen.findByText('Test Rider 1');
    await userEvent.click(screen.getByRole('button', { name: 'Set status' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(within(dialog).getByRole('option', { name: 'Inactive' })).toBeInTheDocument();
    });
    await userEvent.selectOptions(within(dialog).getByLabelText('New status'), 'active');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save status' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PATCH')).toBe(true);
    });
    expect(calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({
      version: 3,
      statusCode: 'active',
    });
  });

  it('hides the actions without permission, and shows empty and not-reported states', async () => {
    stub(
      base(['tracking.entry.view'], {
        'GET /tracking/cross-check': () =>
          json(200, { date: '2026-11-23', figuresDate: '2026-11-22', reported: false, items: [] }),
      }),
    );
    render(wrap(<StatusDifferencesPage />));
    expect(await screen.findByText('No differences found.')).toBeInTheDocument();
    expect(
      screen.getByText('The platform sheet has no figures for 2026-11-22 yet.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set status' })).not.toBeInTheDocument();
  });
});

const SHEET = {
  date: '2026-11-23',
  figuresDate: '2026-11-22',
  reported: true,
  summary: {
    totalPeople: 4,
    called: 1,
    notCalled: 3,
    ordersYesterday: 20,
    hoursYesterday: 30,
    zeroOrders: 1,
    statusChangesToday: 0,
    byStatus: { active: 4 },
  },
  filtered: false,
  unfiltered: { totalPeople: 4, byStatus: { active: 4 } },
  lowHoursLimit: 6,
  rows: [
    {
      partyId: 'party-1',
      employeeId: 'emp-1',
      employeeCode: 'E0001',
      name: 'Test Rider 1',
      platformIds: [],
      profession: 'rider',
      zone: null,
      phone: null,
      statusCode: 'active',
      yesterday: { orders: 5, hours: 5, lateMinutes: 0 },
      entry: null,
      calledToday: true,
      lastCall: null,
      crossCheck: [],
    },
  ],
};

describe('Call sheet additions (row 4.8b)', () => {
  it('shows the called-today progress and marks low hours by the company limit', async () => {
    stub(base(['tracking.entry.view'], { 'GET /tracking': () => json(200, SHEET) }));
    render(wrap(<CallSheetPage />));
    await screen.findByText('Test Rider 1');
    const bar = screen.getByRole('progressbar', { name: 'Called today' });
    expect(bar).toHaveAttribute('aria-valuenow', '1');
    expect(bar).toHaveAttribute('aria-valuemax', '4');
    expect(screen.getByText('Called today: 1 of 4')).toBeInTheDocument();
    // 5 hours is under the company's limit of 6, so the row is marked with the limit named.
    expect(screen.getByText('Under 6 h')).toBeInTheDocument();
  });

  it('exports the sheet to Excel with the current date and filters', async () => {
    const calls = stub(
      base(['tracking.entry.view', 'platform.report.export'], {
        'GET /tracking': () => json(200, SHEET),
        'POST /reports/tracking.call_sheet/export': () =>
          json(200, { fileId: 'f1', fileName: 'call-sheet.xlsx' }),
        'GET /files/f1/download-url': () => json(200, { url: 'http://localhost/none' }),
      }),
    );
    // The browser would leave the page for the file; keep the test on it.
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    render(wrap(<CallSheetPage />));
    await screen.findByText('Test Rider 1');
    await userEvent.click(screen.getByRole('button', { name: 'Not yet called' }));
    await waitFor(() => {
      expect(calls.filter((c) => c.path === '/tracking').at(-1)?.query).toContain('notCalled=true');
    });
    await userEvent.click(screen.getByRole('button', { name: 'Export to Excel' }));
    expect(await screen.findByText('Exported call-sheet.xlsx.')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/reports/tracking.call_sheet/export')?.body).toEqual({
      format: 'xlsx',
      filters: { date: expect.any(String) as string, notCalled: 'true' },
    });
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('http://localhost/none');
    });
  });

  it('hides export and the limit field without permission', async () => {
    stub(base(['tracking.entry.view'], { 'GET /tracking': () => json(200, SHEET) }));
    render(wrap(<CallSheetPage />));
    await screen.findByText('Test Rider 1');
    expect(screen.queryByRole('button', { name: 'Export to Excel' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Low-hours limit (hours)')).not.toBeInTheDocument();
  });

  it('saves a new low-hours limit and reloads the sheet', async () => {
    const calls = stub(
      base(['tracking.entry.view', 'tracking.entry.update'], {
        'GET /tracking': () => json(200, SHEET),
        'PUT /tracking/settings': () => json(200, { companyId: 'c1', lowHours: 3 }),
      }),
    );
    render(wrap(<CallSheetPage />));
    await screen.findByText('Test Rider 1');
    const field = screen.getByLabelText('Low-hours limit (hours)');
    const save = screen.getByRole('button', { name: 'Save limit' });
    expect(save).toBeDisabled();
    await userEvent.type(field, '3');
    await userEvent.click(save);
    expect(await screen.findByText('Limit saved.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ lowHours: 3 });
    expect(calls.filter((c) => c.path === '/tracking').length).toBeGreaterThan(1);
  });
});
