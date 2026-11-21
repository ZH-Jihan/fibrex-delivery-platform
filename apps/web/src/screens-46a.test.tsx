// Tests for phase 4 row 4.6a: performance reports screens and the employee Performance tab.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { I18nProvider } from './i18n';
import { PerformanceReportsPage } from './performance/PerformanceReportsPage';
import { PersonPerformanceTab } from './performance/PersonPerformanceTab';
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
      const [rawPath = '', query = ''] = url.split('?');
      const path = rawPath.replace('/api/v1', '');
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
          <MemoryRouter>{children}</MemoryRouter>
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

const OPTIONS = {
  today: '2026-11-21',
  yesterday: '2026-11-20',
  platforms: [
    {
      id: 'p1',
      companyId: 'c1',
      code: 'snoonu',
      name: 'Snoonu',
      cycleStartDay: 26,
      thisCycle: { start: '2026-10-26', end: '2026-11-25' },
      lastCycle: { start: '2026-09-26', end: '2026-10-25' },
    },
  ],
};
const optionsRoute = () => json(200, OPTIONS);

describe('PerformanceReportsPage', () => {
  it('runs the daily report for yesterday and shows the rows', async () => {
    const calls = stub(
      base(['performance.report.view'], {
        'GET /performance/report-options': optionsRoute,
        'POST /reports/performance.daily/run': () =>
          json(200, {
            rows: [
              {
                personName: 'Test Rider Alpha',
                falconId: 'F1',
                date: '2026-11-20',
                orders: 14,
                hoursActive: 7.5,
                acceptanceRate: 92,
                lateMinutes: null,
                km: 88.2,
              },
            ],
            total: 1,
            page: 1,
            pageSize: 50,
          }),
      }),
    );
    render(wrap(<PerformanceReportsPage kind="daily" />));
    expect(await screen.findByText('Test Rider Alpha')).toBeInTheDocument();
    const run = calls.find((c) => c.path === '/reports/performance.daily/run');
    expect(run?.body).toMatchObject({ filters: { platformId: 'p1', date: '2026-11-20' } });
    expect(screen.getByText('14')).toBeInTheDocument();
    expect(screen.getByText('7.5')).toBeInTheDocument();
    // No export permission: no export buttons.
    expect(screen.queryByRole('button', { name: /export csv/i })).toBeNull();
  });

  it('switches to last cycle, shows its dates and exports through the engine', async () => {
    const calls = stub(
      base(['performance.report.view', 'platform.report.export'], {
        'GET /performance/report-options': optionsRoute,
        'POST /reports/performance.cycle_summary/run': () =>
          json(200, {
            rows: [
              {
                personName: 'Test Rider Alpha',
                falconId: 'F1',
                cycleStart: '2026-09-26',
                cycleEnd: '2026-10-25',
                totalOrders: 300,
                totalHours: 150,
                avgOrdersPerActiveDay: 11.54,
                daysWorked: 26,
                zeroDays: 4,
                ordersPerHour: 2,
              },
            ],
            total: 1,
            page: 1,
            pageSize: 50,
          }),
        'POST /reports/performance.cycle_summary/export': () =>
          json(201, { fileId: 'f1', fileName: 'cycle.csv', rowCount: 1, format: 'csv' }),
        'GET /files/f1/download-url': () => json(200, { url: 'about:blank' }),
      }),
    );
    render(wrap(<PerformanceReportsPage kind="cycle" />));
    expect(await screen.findByText('Test Rider Alpha')).toBeInTheDocument();
    expect(screen.getByText('2026-10-26 to 2026-11-25')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Last cycle' }));
    expect(await screen.findByText('2026-09-26 to 2026-10-25')).toBeInTheDocument();
    await waitFor(() => {
      const runs = calls.filter((c) => c.path === '/reports/performance.cycle_summary/run');
      expect(runs.at(-1)?.body).toMatchObject({ filters: { platformId: 'p1', cycle: 'last' } });
    });

    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === '/reports/performance.cycle_summary/export')).toBe(true);
    });
    const exported = calls.find((c) => c.path === '/reports/performance.cycle_summary/export');
    expect(exported?.body).toMatchObject({
      format: 'csv',
      filters: { platformId: 'p1', cycle: 'last' },
    });
  });

  it('shows an explanation, not zeros, when the platform reported nothing', async () => {
    stub(
      base(['performance.report.view'], {
        'GET /performance/report-options': optionsRoute,
        'POST /reports/performance.top_bottom/run': () =>
          json(200, { rows: [], total: 0, page: 1, pageSize: 50 }),
      }),
    );
    render(wrap(<PerformanceReportsPage kind="topBottom" />));
    expect(await screen.findByText('No figures for this period')).toBeInTheDocument();
  });

  it('translates the list codes of the top and bottom report', async () => {
    stub(
      base(['performance.report.view'], {
        'GET /performance/report-options': optionsRoute,
        'POST /reports/performance.top_bottom/run': () =>
          json(200, {
            rows: [
              {
                list: 'streak',
                rank: 1,
                personName: 'Test Rider Beta',
                falconId: 'F2',
                totalOrders: 0,
                totalHours: 0,
                streakDays: 3,
                streakFrom: '2026-11-01',
                streakTo: '2026-11-03',
              },
            ],
            total: 1,
            page: 1,
            pageSize: 50,
          }),
      }),
    );
    render(wrap(<PerformanceReportsPage kind="topBottom" />));
    expect(await screen.findByText('No orders 3+ days in a row')).toBeInTheDocument();
  });

  it('says so when there is no platform yet', async () => {
    stub(
      base(['performance.report.view'], {
        'GET /performance/report-options': () =>
          json(200, { today: '2026-11-21', yesterday: '2026-11-20', platforms: [] }),
      }),
    );
    render(wrap(<PerformanceReportsPage kind="daily" />));
    expect(await screen.findByText('No client platform yet')).toBeInTheDocument();
  });
});

describe('PersonPerformanceTab', () => {
  const history = {
    partyId: 'x',
    platformId: 'p1',
    platformName: 'Snoonu',
    from: '2026-10-26',
    to: '2026-11-25',
    reportedDays: 3,
    totals: { orders: 12, hours: 9.5, daysWorked: 3, zeroDays: 0 },
    days: [
      { date: '2026-10-26', reported: true, orders: 5, hours: 4, acceptanceRate: 90, lateMinutes: 0, km: 40 },
      { date: '2026-10-27', reported: false, orders: null, hours: null, acceptanceRate: null, lateMinutes: null, km: null },
      { date: '2026-10-28', reported: true, orders: 7, hours: 5.5, acceptanceRate: 95, lateMinutes: 3, km: 51 },
      // After the last reported day: the cycle has not got there yet, so it is not listed.
      { date: '2026-10-29', reported: false, orders: null, hours: null, acceptanceRate: null, lateMinutes: null, km: null },
    ],
  };

  it('shows the cycle as a table and charts, a gap as "no figures", and leaves out the future', async () => {
    const calls = stub(
      base(['performance.report.view'], {
        'GET /performance/person/pty1': () => json(200, history),
      }),
    );
    render(wrap(<PersonPerformanceTab partyId="pty1" />));
    // The chart also prints the first and last date, so look in the table.
    const table = await screen.findByRole('table');
    expect(within(table).getByText('2026-10-26')).toBeInTheDocument();
    expect(within(table).getByText('2026-10-28')).toBeInTheDocument();
    expect(within(table).queryByText('2026-10-29')).toBeNull();
    // The unreported day inside the cycle is a gap, not a zero.
    expect(screen.getAllByText('No figures reported').length).toBeGreaterThan(0);
    expect(screen.getByRole('img', { name: 'Orders per day' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Hours per day' })).toBeInTheDocument();
    const personCalls = () => calls.filter((c) => c.path === '/performance/person/pty1');
    expect(personCalls().at(-1)?.query).toContain('cycle=this');

    await userEvent.click(screen.getByRole('button', { name: 'Last cycle' }));
    await waitFor(() => {
      expect(personCalls().at(-1)?.query).toContain('cycle=last');
    });
  });

  it('shows an empty state when the cycle has no reported day', async () => {
    stub(
      base(['performance.report.view'], {
        'GET /performance/person/pty1': () =>
          json(200, {
            ...history,
            reportedDays: 0,
            days: history.days.map((d) => ({ ...d, reported: false, orders: null, hours: null })),
          }),
      }),
    );
    render(wrap(<PersonPerformanceTab partyId="pty1" />));
    expect(await screen.findByText('No figures for this period')).toBeInTheDocument();
  });
});
