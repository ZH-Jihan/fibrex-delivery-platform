// Tests for phase 4 row 4.8c: the platform sheet's details on the call sheet row, the "Day off
// today" mark, filter and sort, the Details panel, amounts hidden without permission, and the
// Platform details section of the employee profile. Synthetic names and numbers only.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { I18nProvider } from './i18n';
import { PersonPerformanceTab } from './performance/PersonPerformanceTab';
import { urlOf } from './test/helpers';
import { NO_SHEET, fullSheet } from './test/sheet-fixture';
import { ThemeProvider } from './theme/theme';
import { CallSheetPage } from './tracking/CallSheetPage';
import { ToastProvider } from './ui/toast';

function nth<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error('no such item');
  return item;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
interface Call {
  method: string;
  path: string;
  query: string;
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
      calls.push({ method, path, query });
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
    json(200, { items: [{ id: 'o-reached', code: 'reached', labels: { en: 'Reached' } }] }),
  'GET /lookups/status_reason': () => json(200, { items: [] }),
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

const wrap = (children: ReactNode) => (
  <ThemeProvider>
    <I18nProvider>
      <ToastProvider>
        <AuthProvider>
          <MemoryRouter initialEntries={['/tracking']}>{children}</MemoryRouter>
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

const row = (n: number, over: Record<string, unknown> = {}) => ({
  partyId: `party-${String(n)}`,
  employeeId: `emp-${String(n)}`,
  employeeCode: `E000${String(n)}`,
  name: `Test Rider ${String(n)}`,
  platformIds: [{ identifierId: `i${String(n)}`, type: 'falcon_id', value: `9100${String(n)}` }],
  profession: 'rider',
  zone: null,
  phone: `+9745550000${String(n)}`,
  statusCode: 'active',
  yesterday: { orders: 12, hours: 8.5, lateMinutes: 0 },
  sheet: NO_SHEET,
  entry: null,
  calledToday: false,
  lastCall: null,
  crossCheck: [],
  ...over,
});
const summary = {
  totalPeople: 3,
  called: 0,
  notCalled: 3,
  ordersYesterday: 30,
  hoursYesterday: 20,
  zeroOrders: 0,
  statusChangesToday: 0,
  byStatus: { active: 3 },
};
const sheetBody = (amountsVisible: boolean) => {
  const rows = [
    row(1, {
      sheet: fullSheet({ cod: amountsVisible ? { amount: '125.5000', currency: 'QAR' } : null }),
    }),
    row(2, {
      yesterday: { orders: 4, hours: 3, lateMinutes: 0 },
      sheet: fullSheet({
        dayOff: {
          text: 'Sunday',
          weekdays: [0],
          onFiguresDate: false,
          onCallDate: true,
          notUpdated: false,
        },
        cod: null,
      }),
    }),
    row(3, {
      yesterday: { orders: 2, hours: 5, lateMinutes: 0 },
      sheet: fullSheet({
        dayOff: {
          text: null,
          weekdays: [],
          onFiguresDate: false,
          onCallDate: false,
          notUpdated: true,
        },
        dutyTime: { from: null, to: null, text: null, notUpdated: true },
        break: { from: null, to: null, text: null, notUpdated: false },
        zone: null,
        cod: null,
      }),
    }),
  ];
  return {
    date: '2026-11-22',
    figuresDate: '2026-11-21',
    reported: true,
    summary,
    rows,
    filtered: false,
    unfiltered: { totalPeople: 3, byStatus: { active: 3 } },
    lowHoursLimit: 2,
    amountsVisible,
  };
};
const ALL = ['tracking.entry.view', 'tracking.call.create', 'people.employee.read'];

const DETAILS = (amountsVisible: boolean) => ({
  partyId: 'party-1',
  date: '2026-11-22',
  figuresDate: '2026-11-21',
  amountsVisible,
  sheet: fullSheet({
    cod: amountsVisible ? { amount: '125.5000', currency: 'QAR' } : null,
    balance: amountsVisible ? { amount: '40.0000', currency: 'QAR' } : null,
  }),
  platformIds: [
    { identifierId: 'i1', type: 'falcon_id', value: '91001', validFrom: '2026-01-01' },
    { identifierId: 'i2', type: 'falcon_id', value: '91002', validFrom: '2026-09-15' },
  ],
  recentDays: [
    { date: '2026-11-15', dayOff: false, reported: false, orders: null, hours: null },
    { date: '2026-11-16', dayOff: false, reported: true, orders: 9, hours: 6.5 },
    { date: '2026-11-21', dayOff: true, reported: true, orders: 12, hours: 8.5 },
  ],
});
const HISTORY = {
  calls: [
    {
      id: 'c1',
      at: '2026-11-20T06:00:00.000Z',
      outcomeId: 'o-reached',
      outcomeCode: 'reached',
      note: 'Will start at noon',
    },
  ],
  statusHistory: [
    {
      id: 's1',
      fromCode: 'inactive',
      toCode: 'active',
      effectiveDate: '2026-11-10',
      at: '2026-11-10T06:00:00.000Z',
    },
  ],
};

describe('Call sheet: sheet details on each row (row 4.8c)', () => {
  it('shows day off, duty time, break, zone and the COD with its currency', async () => {
    stub(
      base([...ALL, 'performance.amounts.view'], {
        'GET /tracking': () => json(200, sheetBody(true)),
      }),
    );
    render(wrap(<CallSheetPage />));
    expect(await screen.findByText('Test Rider 1')).toBeInTheDocument();
    const facts = nth(screen.getAllByRole('list', { name: 'Platform sheet details' }), 0);
    expect(within(facts).getByText('Friday')).toBeInTheDocument();
    expect(within(facts).getByText('14:00 - 02:00')).toBeInTheDocument();
    expect(within(facts).getByText('16:00 - 17:00')).toBeInTheDocument();
    expect(within(facts).getByText('North Gate')).toBeInTheDocument();
    expect(within(facts).getByText('COD (pending amount):')).toBeInTheDocument();
    expect(within(facts).getByText('QAR 125.50')).toBeInTheDocument();
    // The balance amount is never on the call sheet.
    expect(screen.queryByText(/Balance amount/)).not.toBeInTheDocument();
  });

  it('shows "Not updated" as an empty value with a small hint', async () => {
    stub(base(ALL, { 'GET /tracking': () => json(200, sheetBody(false)) }));
    render(wrap(<CallSheetPage />));
    await screen.findByText('Test Rider 3');
    const facts = nth(screen.getAllByRole('list', { name: 'Platform sheet details' }), 2);
    // Day off and duty time carry the hint; break and zone are plain empty values.
    expect(within(facts).getAllByText(/Not updated on the sheet/)).toHaveLength(2);
    expect(within(facts).queryByText('Friday')).not.toBeInTheDocument();
  });

  it('hides the COD line without permission (the server sends no amount)', async () => {
    stub(base(ALL, { 'GET /tracking': () => json(200, sheetBody(false)) }));
    render(wrap(<CallSheetPage />));
    await screen.findByText('Test Rider 1');
    expect(screen.queryByText('COD (pending amount):')).not.toBeInTheDocument();
    expect(screen.queryByText(/QAR/)).not.toBeInTheDocument();
  });

  it('marks "Day off today" with text, filters it on the server and sorts it first', async () => {
    const calls = stub(base(ALL, { 'GET /tracking': () => json(200, sheetBody(false)) }));
    const user = userEvent.setup();
    render(wrap(<CallSheetPage />));
    await screen.findByText('Test Rider 2');
    // The filter button and the one row mark both say it in words, not only by colour.
    expect(screen.getAllByText('Day off today')).toHaveLength(2);
    const names = () =>
      screen
        .getAllByRole('row')
        .map((r) => r.querySelector('strong')?.textContent)
        .filter((x): x is string => typeof x === 'string');
    expect(names()).toEqual(['Test Rider 1', 'Test Rider 2', 'Test Rider 3']);

    await user.selectOptions(screen.getByLabelText('Sort by'), 'dayOff');
    expect(names()).toEqual(['Test Rider 2', 'Test Rider 1', 'Test Rider 3']);
    await user.selectOptions(screen.getByLabelText('Sort by'), 'orders');
    expect(names()).toEqual(['Test Rider 3', 'Test Rider 2', 'Test Rider 1']);

    await user.click(screen.getByRole('button', { name: 'Day off today' }));
    await waitFor(() => {
      expect(
        calls.some((c) => c.path === '/tracking' && c.query.includes('dayOffToday=true')),
      ).toBe(true);
    });
    expect(await screen.findByText(/Filters: Day off today/)).toBeInTheDocument();
  });
});

describe('Call sheet: Details panel (row 4.8c)', () => {
  const open = async (permissions: string[], amountsVisible: boolean) => {
    const calls = stub(
      base(permissions, {
        'GET /tracking': () => json(200, sheetBody(amountsVisible)),
        'GET /tracking/party-1/details': () => json(200, DETAILS(amountsVisible)),
        'GET /tracking/party-1/history': () => json(200, HISTORY),
      }),
    );
    const user = userEvent.setup();
    render(wrap(<CallSheetPage />));
    await screen.findByText('Test Rider 1');
    await user.click(nth(screen.getAllByRole('button', { name: 'Details' }), 0));
    return calls;
  };

  it('shows every sheet detail, the IDs with valid-from dates, 7 days, calls and status moves', async () => {
    const calls = await open([...ALL, 'performance.amounts.view'], true);
    const panel = await screen.findByRole('dialog', { name: 'Details of Test Rider 1' });
    expect(await within(panel).findByText('91002')).toBeInTheDocument();
    expect(within(panel).getByText('from 2026-09-15')).toBeInTheDocument();
    expect(within(panel).getByText('QAR 125.50')).toBeInTheDocument();
    for (const text of ['123456', 'Express', 'Night shift', 'Rider', 'North Gate', 'E0001']) {
      expect(within(panel).getByText(text)).toBeInTheDocument();
    }
    // The balance sits under the small "Other" heading.
    expect(within(panel).getByText('Other')).toBeInTheDocument();
    expect(within(panel).getByText('QAR 40.00')).toBeInTheDocument();
    // Last 7 days: a day with no figures is "not reported", never a zero.
    expect(within(panel).getByText('No figures reported')).toBeInTheDocument();
    expect(within(panel).getByText('2026-11-21')).toBeInTheDocument();
    expect(await within(panel).findByText(/Will start at noon/)).toBeInTheDocument();
    expect(within(panel).getByText(/Inactive → Active/)).toBeInTheDocument();
    expect(
      calls.some((c) => c.path === '/tracking/party-1/details' && c.query.includes('date=')),
    ).toBe(true);
  });

  it('shows no COD or balance when the server sends none', async () => {
    await open(ALL, false);
    const panel = await screen.findByRole('dialog', { name: 'Details of Test Rider 1' });
    await within(panel).findByText('91002');
    expect(within(panel).queryByText('Other')).not.toBeInTheDocument();
    expect(within(panel).queryByText(/Balance amount/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/COD/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/QAR/)).not.toBeInTheDocument();
  });

  it('explains when the sheet has no row for the person', async () => {
    stub(
      base(ALL, {
        'GET /tracking': () => json(200, sheetBody(false)),
        'GET /tracking/party-1/details': () =>
          json(200, { ...DETAILS(false), sheet: NO_SHEET, platformIds: [], recentDays: [] }),
        'GET /tracking/party-1/history': () => json(200, { calls: [], statusHistory: [] }),
      }),
    );
    const user = userEvent.setup();
    render(wrap(<CallSheetPage />));
    await screen.findByText('Test Rider 1');
    await user.click(nth(screen.getAllByRole('button', { name: 'Details' }), 0));
    expect(await screen.findByText(/has no row for this person/)).toBeInTheDocument();
    expect(await screen.findByText('No calls logged.')).toBeInTheDocument();
  });
});

describe('Employee profile: Platform details section (row 4.8c)', () => {
  it('shows the same sheet details above the performance figures', async () => {
    stub(
      base(['performance.report.view'], {
        'GET /performance/person/party-1/platform-details': () => json(200, DETAILS(true)),
        'GET /performance/person/party-1': () =>
          json(200, {
            partyId: 'party-1',
            platformId: 'p1',
            platformName: 'Snoonu',
            from: '2026-10-26',
            to: '2026-11-25',
            reportedDays: 0,
            totals: { orders: 0, hours: 0, daysWorked: 0, zeroDays: 0 },
            days: [],
          }),
      }),
    );
    render(wrap(<PersonPerformanceTab partyId="party-1" />));
    expect(await screen.findByText('Platform details')).toBeInTheDocument();
    expect(await screen.findByText('14:00 - 02:00')).toBeInTheDocument();
    expect(screen.getByText('COD (pending amount)')).toBeInTheDocument();
    expect(screen.getByText('QAR 125.50')).toBeInTheDocument();
    expect(screen.getByText('from 2026-01-01')).toBeInTheDocument();
  });
});

describe('Call sheet: day off for the figures date and the call date (row 4.8d)', () => {
  // Synthetic people. The sheet is for Sunday 2026-11-22; its figures are from Saturday 2026-11-21.
  const sheetFor = () => {
    const off = (onFiguresDate: boolean, onCallDate: boolean, text: string | null) =>
      fullSheet({
        dayOff: {
          text,
          weekdays: text === 'Saturday' ? [6] : text === 'Sunday' ? [0] : [],
          onFiguresDate,
          onCallDate,
          notUpdated: false,
        },
      });
    const rows = [
      // Day off on the figures date, no orders: not a problem.
      row(1, {
        yesterday: { orders: 0, hours: 0, lateMinutes: 0 },
        sheet: off(true, false, 'Saturday'),
      }),
      // Day off on the call date only, and no orders yesterday: still a problem.
      row(2, {
        yesterday: { orders: 0, hours: 0, lateMinutes: 0 },
        sheet: off(false, true, 'Sunday'),
      }),
      // No day off set, no orders: a problem.
      row(3, {
        yesterday: { orders: 0, hours: 0, lateMinutes: 0 },
        sheet: off(false, false, null),
      }),
    ];
    return {
      date: '2026-11-22',
      figuresDate: '2026-11-21',
      reported: true,
      summary: { ...summary, zeroOrders: 2 },
      rows,
      filtered: false,
      unfiltered: { totalPeople: 3, byStatus: { active: 3 } },
      lowHoursLimit: 2,
      amountsVisible: false,
    };
  };

  it('labels the figures date with its weekday and tags each date on its own', async () => {
    stub(base(ALL, { 'GET /tracking': () => json(200, sheetFor()) }));
    render(wrap(<CallSheetPage />));
    await screen.findByText('Test Rider 1');
    expect(screen.getByText('Figures are from 2026-11-21 (Saturday).')).toBeInTheDocument();
    // Filter buttons plus one tag each: yesterday on rider 1, today on rider 2.
    expect(screen.getAllByText('Day off yesterday')).toHaveLength(2);
    expect(screen.getAllByText('Day off today')).toHaveLength(2);
  });

  it('shows a neutral "Day off" mark, not "No orders", and no red tint on the figures day off', async () => {
    stub(base(ALL, { 'GET /tracking': () => json(200, sheetFor()) }));
    render(wrap(<CallSheetPage />));
    await screen.findByText('Test Rider 1');
    const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;
    expect(within(rowOf('Test Rider 1')).queryByText('No orders')).not.toBeInTheDocument();
    expect(within(rowOf('Test Rider 1')).getByText('Day off')).toBeInTheDocument();
    expect(rowOf('Test Rider 1')).not.toHaveClass('sheet-row-zero');
    // Day off only on the call date, and nobody with a day off set: still no orders.
    expect(within(rowOf('Test Rider 2')).getByText('No orders')).toBeInTheDocument();
    expect(within(rowOf('Test Rider 3')).getByText('No orders')).toBeInTheDocument();
    expect(rowOf('Test Rider 3')).toHaveClass('sheet-row-zero');
  });

  it('sends the "Day off yesterday" filter to the server', async () => {
    const calls = stub(base(ALL, { 'GET /tracking': () => json(200, sheetFor()) }));
    const user = userEvent.setup();
    render(wrap(<CallSheetPage />));
    await screen.findByText('Test Rider 1');
    await user.click(screen.getByRole('button', { name: 'Day off yesterday' }));
    await waitFor(() => {
      expect(
        calls.some((c) => c.path === '/tracking' && c.query.includes('dayOffYesterday=true')),
      ).toBe(true);
    });
  });
});
