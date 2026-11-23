// Tests for phase 4 row 4.8a: the Morning call sheet screen. Synthetic names and numbers only.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

function nth<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error('no such item');
  return item;
}

const person = (n: number, over: Record<string, unknown> = {}) => ({
  partyId: `party-${String(n)}`,
  employeeId: `emp-${String(n)}`,
  employeeCode: `E000${String(n)}`,
  name: `Test Rider ${String(n)}`,
  platformIds: [{ identifierId: `i${String(n)}`, type: 'falcon_id', value: `9100${String(n)}` }],
  profession: 'rider',
  zone: 'Zone North',
  phone: `+9745550000${String(n)}`,
  statusCode: 'active',
  yesterday: { orders: 12, hours: 8.5, lateMinutes: 0 },
  entry: null,
  calledToday: false,
  lastCall: null,
  crossCheck: [],
  ...over,
});
const SHEET = {
  date: '2026-11-23',
  figuresDate: '2026-11-22',
  reported: true,
  summary: {
    totalPeople: 3,
    called: 1,
    notCalled: 2,
    ordersYesterday: 12,
    hoursYesterday: 14.5,
    zeroOrders: 1,
    statusChangesToday: 2,
    byStatus: { active: 2, inactive: 1 },
  },
  filtered: false,
  unfiltered: { totalPeople: 3, byStatus: { active: 2, inactive: 1 } },
  lowHoursLimit: 4,
  rows: [
    person(1, { calledToday: true }),
    person(2, { yesterday: { orders: 0, hours: 0, lateMinutes: 30 } }),
    person(3, { statusCode: 'inactive', yesterday: { orders: 3, hours: 2, lateMinutes: 5 } }),
  ],
};
const ALL = [
  'tracking.entry.view',
  'tracking.entry.create',
  'tracking.call.create',
  'tracking.status.apply',
  'people.employee.read',
];
const sheet = () => json(200, SHEET);

/**
 * A stand-in for the server's filtering, so the screen test checks that the screen sends the
 * filters and shows the strip it is given. (The real rules are tested through the API.)
 */
function filteredSheet(q: URLSearchParams): Response {
  const text = q.get('q')?.toLowerCase() ?? '';
  const rows = SHEET.rows.filter((r) => {
    if (q.get('status') !== null && r.statusCode !== q.get('status')) return false;
    if (q.get('notCalled') === 'true' && r.calledToday) return false;
    if (q.get('zeroOrders') === 'true' && r.yesterday.orders !== 0) return false;
    return (
      text === '' ||
      [r.name, r.employeeCode, r.phone, ...r.platformIds.map((x) => x.value)]
        .join(' ')
        .toLowerCase()
        .includes(text)
    );
  });
  return json(200, {
    ...SHEET,
    rows,
    filtered: rows.length !== SHEET.rows.length,
    summary: {
      ...SHEET.summary,
      totalPeople: rows.length,
      called: rows.filter((r) => r.calledToday).length,
      notCalled: rows.filter((r) => !r.calledToday).length,
      ordersYesterday: rows.reduce((n, r) => n + r.yesterday.orders, 0),
      hoursYesterday: rows.reduce((n, r) => n + r.yesterday.hours, 0),
      zeroOrders: rows.filter((r) => r.yesterday.orders === 0).length,
    },
  });
}
const stripValue = (label: string) =>
  within(screen.getByRole('list', { name: 'Summary' }))
    .getByText(label)
    .parentElement?.querySelector('.sheet-strip-value')?.textContent;

describe('Morning call sheet (row 4.8a)', () => {
  it('shows the summary strip, rows, tap-to-call links and marks the quiet rows', async () => {
    stub(base(ALL, { 'GET /tracking': sheet }));
    render(wrap(<CallSheetPage />));
    expect(await screen.findByText('Test Rider 1')).toBeInTheDocument();
    const strip = screen.getByRole('list', { name: 'Summary' });
    expect(within(strip).getByText('14.5')).toBeInTheDocument();
    expect(within(strip).getByText('Status changes today')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Call +97455500001' })).toHaveAttribute(
      'href',
      'tel:+97455500001',
    );
    // Marks are text as well as colour.
    expect(screen.getByText('No orders')).toBeInTheDocument();
    expect(screen.getByText('Under 4 h')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Open profile/ })[0]).toHaveAttribute(
      'href',
      '/employees/emp-1',
    );
  });

  it('sends the filters to the server and shows the strip it returns for those rows', async () => {
    const calls = stub(base(ALL, { 'GET /tracking': filteredSheet }));
    render(wrap(<CallSheetPage />));
    await screen.findByText('Test Rider 1');
    expect(screen.getByTestId('sheet-showing')).toHaveTextContent('Showing 3 of 3');
    expect(stripValue('People')).toBe('3');
    const last = () => calls.filter((c) => c.path === '/tracking').at(-1)?.query ?? '';

    await userEvent.click(screen.getByRole('button', { name: 'Not yet called' }));
    await waitFor(() => {
      expect(screen.queryByText('Test Rider 1')).not.toBeInTheDocument();
    });
    expect(last()).toContain('notCalled=true');
    expect(stripValue('People')).toBe('2');
    expect(screen.getByTestId('sheet-showing')).toHaveTextContent('Showing 2 of 3');
    expect(screen.getByTestId('sheet-showing')).toHaveTextContent('Filters: Not yet called');
    await userEvent.click(screen.getByRole('button', { name: 'Not yet called' }));
    await screen.findByText('Test Rider 1');

    await userEvent.click(screen.getByRole('button', { name: 'Zero orders yesterday' }));
    await waitFor(() => {
      expect(screen.queryByText('Test Rider 3')).not.toBeInTheDocument();
    });
    expect(last()).toContain('zeroOrders=true');
    expect(stripValue('People')).toBe('1');
    expect(stripValue('Zero-order people')).toBe('1');
    expect(stripValue('Orders yesterday')).toBe('0');
    await userEvent.click(screen.getByRole('button', { name: 'Zero orders yesterday' }));
    await screen.findByText('Test Rider 3');

    // The status filter: the strip counts only the active people and their orders and hours.
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'active');
    await waitFor(() => {
      expect(screen.queryByText('Test Rider 3')).not.toBeInTheDocument();
    });
    expect(last()).toContain('status=active');
    expect(stripValue('People')).toBe('2');
    expect(stripValue('Orders yesterday')).toBe('12');
    expect(stripValue('Hours yesterday')).toBe('8.5');
    expect(stripValue('Zero-order people')).toBe('1');
    expect(screen.getByTestId('sheet-showing')).toHaveTextContent('Showing 2 of 3');
    expect(screen.getByTestId('sheet-showing')).toHaveTextContent('Filters: Status: Active');
    // The status list keeps offering every status, whatever the filter hides.
    expect(screen.getByRole('option', { name: 'Inactive' })).toBeInTheDocument();
  });

  it('combines two filters and the search into one request and one strip', async () => {
    const calls = stub(base(ALL, { 'GET /tracking': filteredSheet }));
    render(wrap(<CallSheetPage />));
    await screen.findByText('Test Rider 1');
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'active');
    await userEvent.click(screen.getByRole('button', { name: 'Not yet called' }));
    await userEvent.type(screen.getByLabelText('Search name, code, ID or phone'), '91002');
    await waitFor(() => {
      expect(screen.queryByText('Test Rider 3')).not.toBeInTheDocument();
      expect(screen.queryByText('Test Rider 1')).not.toBeInTheDocument();
    });
    // The search is sent once typing pauses; wait for that request.
    await waitFor(() => {
      expect(calls.filter((c) => c.path === '/tracking').at(-1)?.query).toContain('q=91002');
    });
    const last = calls.filter((c) => c.path === '/tracking').at(-1)?.query ?? '';
    expect(last).toContain('status=active');
    expect(last).toContain('notCalled=true');
    expect(screen.getByText('Test Rider 2')).toBeInTheDocument();
    expect(stripValue('People')).toBe('1');
    expect(stripValue('Not yet called')).toBe('1');
    expect(stripValue('Zero-order people')).toBe('1');
    expect(screen.getByTestId('sheet-showing')).toHaveTextContent('Showing 1 of 3');
    await userEvent.clear(screen.getByLabelText('Search name, code, ID or phone'));
    await userEvent.type(screen.getByLabelText('Search name, code, ID or phone'), 'nobody');
    expect(await screen.findByText('Nobody matches these filters.')).toBeInTheDocument();
    expect(stripValue('People')).toBe('0');
  });

  it('asks the server again when the date changes', async () => {
    const calls = stub(base(ALL, { 'GET /tracking': sheet }));
    render(wrap(<CallSheetPage />));
    await screen.findByText('Test Rider 1');
    const before = calls.filter((c) => c.path === '/tracking').length;
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-11-20' } });
    await waitFor(() => {
      expect(calls.filter((c) => c.path === '/tracking').length).toBeGreaterThan(before);
    });
    expect(calls.filter((c) => c.path === '/tracking').at(-1)?.query).toContain('date=2026-11-20');
  });

  it('logs a call with an outcome and a note', async () => {
    const calls = stub(
      base(ALL, {
        'GET /tracking': sheet,
        'POST /tracking/calls': () => json(201, { id: 'c1' }),
      }),
    );
    render(wrap(<CallSheetPage />));
    await screen.findByText('Test Rider 2');
    await userEvent.click(nth(screen.getAllByRole('button', { name: 'Log a call' }), 1));
    const dialog = await screen.findByRole('dialog');
    const save = within(dialog).getByRole('button', { name: 'Save call' });
    expect(save).toBeDisabled();
    await waitFor(() => {
      expect(within(dialog).getByRole('option', { name: 'Switched off' })).toBeInTheDocument();
    });
    await userEvent.selectOptions(within(dialog).getByLabelText('Outcome'), 'o-off');
    await userEvent.type(within(dialog).getByLabelText('Note'), 'Phone off all morning');
    await userEvent.click(save);
    expect(await screen.findByText('Call saved.')).toBeInTheDocument();
    const post = calls.find((c) => c.method === 'POST' && c.path === '/tracking/calls');
    expect(post?.body).toMatchObject({
      partyId: 'party-2',
      outcomeId: 'o-off',
      note: 'Phone off all morning',
    });
    expect(calls.filter((c) => c.path === '/tracking').length).toBeGreaterThan(1);
  });

  it('shows the refusal when the status change is not allowed, and saves nothing', async () => {
    stub(
      base(ALL, {
        'GET /tracking': sheet,
        'POST /tracking/entries': () =>
          json(422, {
            type: 'about:blank',
            title: 'Unprocessable',
            status: 422,
            code: 'transition_not_allowed',
            detail: 'A person who is "inactive" cannot be set to "active".',
          }),
      }),
    );
    render(wrap(<CallSheetPage />));
    await screen.findByText('Test Rider 3');
    await userEvent.click(nth(screen.getAllByRole('button', { name: 'Set status' }), 2));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(within(dialog).getByRole('option', { name: 'Active' })).toBeInTheDocument();
    });
    await userEvent.selectOptions(within(dialog).getByLabelText('New status'), 'active');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save status' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'A person who is "inactive" cannot be set to "active".',
    );
    expect(screen.queryByText('Status saved.')).not.toBeInTheDocument();
  });

  it('asks for a reason when the status needs one', async () => {
    stub(base(ALL, { 'GET /tracking': sheet }));
    render(wrap(<CallSheetPage />));
    await screen.findByText('Test Rider 1');
    await userEvent.click(nth(screen.getAllByRole('button', { name: 'Set status' }), 0));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(within(dialog).getByRole('option', { name: 'Inactive' })).toBeInTheDocument();
    });
    await userEvent.selectOptions(within(dialog).getByLabelText('New status'), 'inactive');
    expect(within(dialog).getByRole('button', { name: 'Save status' })).toBeDisabled();
    await userEvent.selectOptions(
      within(dialog).getByLabelText('Reason (required for this status)'),
      'r-left',
    );
    expect(within(dialog).getByRole('button', { name: 'Save status' })).toBeEnabled();
  });

  it('hides the buttons the user has no permission for', async () => {
    stub(base(['tracking.entry.view'], { 'GET /tracking': sheet }));
    render(wrap(<CallSheetPage />));
    await screen.findByText('Test Rider 1');
    expect(screen.queryByRole('button', { name: 'Log a call' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set status' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open profile/ })).not.toBeInTheDocument();
  });

  it('shows an empty state when nobody is on the sheet', async () => {
    stub(
      base(ALL, {
        'GET /tracking': () => json(200, { ...SHEET, rows: [] }),
      }),
    );
    render(wrap(<CallSheetPage />));
    expect(await screen.findByText('Nobody matches these filters.')).toBeInTheDocument();
  });
});
