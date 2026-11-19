// Tests for phase 3 row 3.3b: the Employee profile page (tabs, other document, bank approval).
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { I18nProvider } from './i18n';
import { EmployeeProfilePage, bankActions } from './people/EmployeeProfilePage';
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
      const hit = Object.keys(routes).find((k) => `${method} ${path}`.endsWith(k));
      if (hit === undefined) return Promise.reject(new Error(`unexpected ${method} ${url}`));
      return Promise.resolve((routes[hit] as () => Response)());
    }),
  );
  return calls;
}

const wrap = () => (
  <ThemeProvider>
    <I18nProvider>
      <ToastProvider>
        <AuthProvider>
          <MemoryRouter initialEntries={['/employees/e1']}>
            <Routes>
              <Route path="employees/:id" element={<EmployeeProfilePage />} />
            </Routes>
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
  'GET /employees/e1': () =>
    json(200, {
      id: 'e1',
      partyId: '0b8f0c8e-5f3a-4d6e-9c1a-2f7d8e9a0b1c',
      employeeCode: 'E0001',
      displayName: 'Rahim',
      statusCode: 'active',
      sponsorship: 'company',
      joiningDate: '2026-01-05',
      version: 1,
    }),
  'GET /document-types': () => json(200, { items: [] }),
});

const account = (over: Record<string, unknown>) => ({
  id: 'b1',
  kind: 'bank',
  bankName: 'QNB',
  numberMasked: '****1234',
  accountName: 'Rahim',
  walletProvider: null,
  status: 'pending',
  proofFileId: null,
  proofCheckedAt: null,
  reviewNote: null,
  requestedBy: 'u2',
  version: 2,
  ...over,
});

beforeEach(() => {
  setAccessToken(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bank approval rule', () => {
  const can = () => true;
  it('lets only a second person approve', () => {
    expect(bankActions(account({ requestedBy: 'u1' }) as never, 'u1', can).approve).toBe(false);
    expect(
      bankActions(account({ requestedBy: 'u1' }) as never, 'u1', can).waitingForSecondPerson,
    ).toBe(true);
    expect(bankActions(account({}) as never, 'u1', can).approve).toBe(true);
  });
  it('wants the proof checked before approval', () => {
    const a = account({ proofFileId: 'f1' }) as never;
    expect(bankActions(a, 'u1', can).approve).toBe(false);
    expect(bankActions(a, 'u1', can).verify).toBe(true);
  });
});

describe('employee profile page', () => {
  it('shows the bank account of another requester with an Approve button that posts', async () => {
    const calls = stub({
      ...signedIn(['people.employee.read', 'party.bank_account.approve']),
      'GET /party-bank-accounts': () => json(200, { items: [account({})] }),
      'POST /party-bank-accounts/b1/approve': () => json(200, account({ status: 'verified' })),
    });
    render(wrap());
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === '/party-bank-accounts/b1/approve')).toBe(true);
    });
  });

  it('hides Approve for the person who added the account', async () => {
    stub({
      ...signedIn(['people.employee.read', 'party.bank_account.approve']),
      'GET /party-bank-accounts': () => json(200, { items: [account({ requestedBy: 'u1' })] }),
    });
    render(wrap());
    await screen.findByText(/second person must approve/i);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('adds another document with a custom name for this person', async () => {
    const calls = stub({
      ...signedIn(['people.employee.read', 'people.document.create']),
      'GET /documents': () => json(200, { items: [] }),
      'POST /documents': () => json(201, {}),
    });
    render(wrap());
    await userEvent.click(await screen.findByRole('tab', { name: 'Documents' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Add other document' }));
    await userEvent.type(await screen.findByLabelText('Name of the document'), 'Gym pass');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path === '/documents')).toBe(true);
    });
    expect(calls.find((c) => c.method === 'POST' && c.path === '/documents')?.body).toEqual({
      ownerType: 'party',
      ownerId: '0b8f0c8e-5f3a-4d6e-9c1a-2f7d8e9a0b1c',
      customName: 'Gym pass',
    });
  });

  it('lists placements and employment periods', async () => {
    stub({
      ...signedIn(['people.employee.read']),
      'GET /party-bank-accounts': () => json(200, { items: [] }),
      'GET /employees/e1/placements': () =>
        json(200, {
          items: [{ id: 'x', profession: 'rider', validFrom: '2026-01-05', validTo: null }],
        }),
      'GET /employees/e1/employment-periods': () =>
        json(200, {
          items: [{ id: 'y', startDate: '2026-01-05', endDate: null, rehireEligible: true }],
        }),
    });
    render(wrap());
    await userEvent.click(await screen.findByRole('tab', { name: 'Placement' }));
    await screen.findByText('rider');
  });
});
