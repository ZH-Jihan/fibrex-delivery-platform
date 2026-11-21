// Tests for phase 4 row 4.5b: the Unmatched riders queue screen.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { I18nProvider } from './i18n';
import { UnmatchedPage } from './performance/UnmatchedPage';
import { urlOf } from './test/helpers';
import { ThemeProvider } from './theme/theme';
import { ToastProvider } from './ui/toast';

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
  'GET /client-platforms': () => json(200, { items: [{ id: 'p1', name: 'Snoonu' }] }),
  ...extra,
});

const wrap = (children: ReactNode) => (
  <ThemeProvider>
    <I18nProvider>
      <ToastProvider>
        <AuthProvider>
          <MemoryRouter initialEntries={['/performance/unmatched']}>{children}</MemoryRouter>
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

const ITEM = '11111111-2222-4333-8444-555555555555';
const row = {
  id: ITEM,
  clientPlatformId: 'p1',
  platformName: 'Snoonu',
  externalId: '91001',
  firstSeen: '2026-10-26',
  lastSeen: '2026-11-19',
  status: 'open',
  ordersSeen: 310,
  daysSeen: 23,
  sheetName: 'Test Rider Alpha',
  sheetPhone: '97455500001',
  sheetProfession: 'Rider',
  sheetPlate: 'TEST-901',
  sheetZone: 'Zone North',
  resolvedPartyId: null,
  resolvedPartyName: null,
  resolvedOn: null,
  ignoreReason: null,
};
const list = () => json(200, { items: [row], total: 1, page: 1, pageSize: 25 });
const ALL = [
  'performance.unmatched.read',
  'performance.unmatched.resolve',
  'people.employee.create',
];

describe('Unmatched riders (row 4.5b)', () => {
  it('shows the sheet details and links to a suggested employee from the first seen date', async () => {
    const calls = stub(
      base(ALL, {
        'GET /unmatched-identifiers': list,
        [`GET /unmatched-identifiers/${ITEM}/candidates`]: () =>
          json(200, {
            suggested: [
              {
                employeeId: 'e1',
                partyId: 'p',
                displayName: 'Rider Alpha Testing',
                employeeCode: 'E0007',
                statusCode: 'active',
                phone: '+97455510001',
              },
            ],
            results: [],
          }),
        [`POST /unmatched-identifiers/${ITEM}/link`]: () =>
          json(200, {
            status: 'linked',
            attachedRows: 23,
            leftUnmatched: 0,
            employeeCode: 'E0007',
          }),
      }),
    );
    render(wrap(<UnmatchedPage />));
    expect(await screen.findByText('Test Rider Alpha')).toBeInTheDocument();
    expect(screen.getByText('91001')).toBeInTheDocument();
    expect(screen.getByText('97455500001')).toBeInTheDocument();
    expect(screen.getByText('310')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Link to employee' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Best name matches')).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Link' });
    expect(confirm).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('button', { name: /Rider Alpha Testing/ }));
    expect(within(dialog).getByLabelText('ID held from')).toHaveValue('2026-10-26');
    await userEvent.click(confirm);

    expect(await screen.findByText(/23 stored days/)).toBeInTheDocument();
    const link = calls.find((c) => c.method === 'POST' && c.path.endsWith('/link'));
    expect(link?.body).toEqual({ employeeId: 'e1', validFrom: '2026-10-26' });
  });

  it('creates an employee from the sheet row and asks before a shared phone', async () => {
    let attempts = 0;
    const calls = stub(
      base(ALL, {
        'GET /unmatched-identifiers': list,
        [`POST /unmatched-identifiers/${ITEM}/create-employee`]: () => {
          attempts += 1;
          return attempts === 1
            ? json(409, {
                type: 'about:blank',
                title: 'Conflict',
                status: 409,
                code: 'possible_duplicate',
                detail: 'A person with the same phone number exists.',
              })
            : json(201, {
                status: 'created',
                attachedRows: 23,
                leftUnmatched: 2,
                employeeCode: 'E0009',
              });
        },
      }),
    );
    render(wrap(<UnmatchedPage />));
    await userEvent.click(await screen.findByRole('button', { name: 'Create employee' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Full name')).toHaveValue('Test Rider Alpha');
    expect(within(dialog).getByLabelText('Rider or driver')).toHaveValue('rider');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create employee' }));
    expect(await within(dialog).findByText(/same phone number already exists/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create anyway' }));
    expect(await screen.findByText(/Employee E0009 created/)).toBeInTheDocument();
    expect(await screen.findByText(/2 days stayed unmatched/)).toBeInTheDocument();
    const sent = calls.filter((c) => c.path.endsWith('/create-employee'));
    expect(sent[1]?.body).toMatchObject({ profession: 'rider', acknowledgeDuplicates: true });
  });

  it('ignore needs a reason; people who cannot resolve see no actions', async () => {
    const calls = stub(
      base(ALL, {
        'GET /unmatched-identifiers': list,
        [`POST /unmatched-identifiers/${ITEM}/ignore`]: () => json(200, { status: 'ignored' }),
      }),
    );
    const first = render(wrap(<UnmatchedPage />));
    await userEvent.click(await screen.findByRole('button', { name: 'Ignore' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Ignore ID' });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'Another company');
    await userEvent.click(confirm);
    await waitFor(() => {
      expect(calls.some((c) => c.path.endsWith('/ignore'))).toBe(true);
    });
    first.unmount();

    stub(base(['performance.unmatched.read'], { 'GET /unmatched-identifiers': list }));
    render(wrap(<UnmatchedPage />));
    expect(await screen.findByText('Test Rider Alpha')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link to employee' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ignore' })).toBeNull();
  });
});
