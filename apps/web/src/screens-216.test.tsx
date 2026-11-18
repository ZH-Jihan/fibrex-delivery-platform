// Tests for phase 2 row 2.16a: chart of accounts, journals and manual journals screens.
// All accounts, amounts and numbers are invented.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { I18nProvider } from './i18n';
import { AccountsPage, accountFormProblem } from './ledger/AccountsPage';
import { canReverse, JournalsPage } from './ledger/JournalsPage';
import { flattenTree, showAmount, totalsByCurrency, type AccountNode } from './ledger/ledger-utils';
import { ManualJournalsPage, toApiLines } from './ledger/ManualJournalsPage';
import { urlOf } from './test/helpers';
import { ThemeProvider } from './theme/theme';
import { ToastProvider } from './ui/toast';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Call {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
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
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const hit = Object.keys(routes).find((k) => `${method} ${path}`.endsWith(k));
      if (hit === undefined) return Promise.reject(new Error(`unexpected ${method} ${url}`));
      return Promise.resolve((routes[hit] as () => Response)());
    }),
  );
  return calls;
}

const wrap = (ui: React.ReactNode) => (
  <ThemeProvider>
    <I18nProvider>
      <ToastProvider>
        <AuthProvider>
          <MemoryRouter>{ui}</MemoryRouter>
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

const node = (
  id: string,
  code: string,
  en: string,
  extra: Partial<AccountNode> = {},
): AccountNode => ({
  id,
  code,
  name: { en },
  type: 'asset',
  parentId: null,
  isPostable: true,
  isControl: false,
  currencyRestriction: null,
  requiresDimensions: [],
  description: null,
  version: 1,
  children: [],
  ...extra,
});
const tree: AccountNode[] = [
  node('h1', '1000', 'Current assets', {
    isPostable: false,
    children: [
      node('a1', '1010', 'Cash on hand', { parentId: 'h1' }),
      node('a2', '1020', 'Bank', { parentId: 'h1' }),
    ],
  }),
];

beforeEach(() => {
  setAccessToken(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ledger helpers', () => {
  it('flattens the tree depth-first with depths', () => {
    expect(flattenTree(tree).map((a) => [a.code, a.depth])).toEqual([
      ['1000', 0],
      ['1010', 1],
      ['1020', 1],
    ]);
  });

  it('adds lines per currency exactly and says whether each balances', () => {
    expect(
      totalsByCurrency(
        [
          { debit: '0.1' },
          { debit: '0.2' },
          { credit: '0.3' },
          { debit: '10', currency: 'USD' },
          { credit: 'abc', currency: 'USD' },
        ],
        'base',
      ),
    ).toEqual([
      { currency: 'base', debit: '0.30', credit: '0.30', balanced: true },
      { currency: 'USD', debit: '10.00', credit: '0.00', balanced: false },
    ]);
    expect(showAmount('1234567.5')).toBe('1,234,567.50');
    expect(showAmount('0.0000')).toBe('');
  });

  it('checks the account form and the reversal rule', () => {
    const form = {
      code: 'bad code',
      nameEn: 'X',
      type: 'asset' as const,
      parentId: '',
      isPostable: true,
      isControl: false,
      currencyRestriction: '',
      description: '',
    };
    expect(accountFormProblem(form, true)).toBe('gl.codeHint');
    expect(accountFormProblem({ ...form, code: '1030' }, true)).toBeNull();
    expect(accountFormProblem({ ...form, code: '1030', currencyRestriction: 'qa' }, true)).toBe(
      'gl.currencyHint',
    );
    expect(canReverse({ reversalOfId: null, reversedById: null })).toBe(true);
    expect(canReverse({ reversalOfId: 'j1', reversedById: null })).toBe(false);
    expect(canReverse({ reversalOfId: null, reversedById: 'j2' })).toBe(false);
  });

  it('drops empty boxes from manual journal lines', () => {
    expect(
      toApiLines([
        { accountCode: '1010', debit: '50', credit: '', currency: '', fxRate: '', memo: ' ' },
      ]),
    ).toEqual([{ accountCode: '1010', debit: '50' }]);
  });
});

describe('chart of accounts screen', () => {
  it('shows the tree and creates an account under a header of the same type', async () => {
    const calls = stub({
      ...signedIn(['gl.account.read', 'gl.account.create']),
      'GET /accounts/tree': () => json(200, { items: tree }),
      'POST /accounts': () => json(201, node('a3', '1030', 'Petty cash')),
    });
    render(wrap(<AccountsPage />));
    expect(await screen.findByText('Cash on hand')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'New account' }));
    const form = screen.getByRole('region', { name: 'New account' });
    await userEvent.type(within(form).getByLabelText(/^Code/), '1030');
    await userEvent.type(within(form).getByLabelText('Name (English)'), 'Petty cash');
    await userEvent.selectOptions(within(form).getByLabelText('Header (parent)'), 'h1');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path === '/accounts')).toBe(true);
    });
    const post = calls.find((c) => c.method === 'POST' && c.path === '/accounts');
    expect(post?.body).toMatchObject({
      code: '1030',
      name: { en: 'Petty cash' },
      type: 'asset',
      parentId: 'h1',
      isPostable: true,
    });
  });
});

const journal = {
  id: 'j1',
  number: 'JV-2026-00001',
  entryDate: '2026-11-10',
  eventKey: 'gl.manual_journal',
  sourceType: 'gl.manual_journal',
  description: 'MJ-2026-00001: Float',
  lineCount: 2,
  reversalOfId: null,
  reversedById: null,
  reason: null,
  postedAt: '2026-11-10T08:00:00.000Z',
};
const line = (id: string, accountId: string, debit: string, credit: string) => ({
  id,
  lineNo: id === 'l1' ? 1 : 2,
  accountId,
  debit,
  credit,
  currency: 'QAR',
  fxRate: '1.00000000',
  baseDebit: debit,
  baseCredit: credit,
  partyId: null,
  memo: null,
});

describe('journals screen', () => {
  it('opens a journal with base totals and reverses it with a reason', async () => {
    const calls = stub({
      ...signedIn(['gl.journal.read', 'gl.journal.reverse', 'gl.account.read']),
      'GET /accounts/tree': () => json(200, { items: tree }),
      'GET /journals': () => json(200, { items: [journal], total: 1, page: 1, pageSize: 50 }),
      'GET /journals/j1': () =>
        json(200, {
          ...journal,
          lines: [line('l1', 'a1', '500.0000', '0.0000'), line('l2', 'a2', '0.0000', '500.0000')],
        }),
      'POST /journals/j1/reverse': () =>
        json(201, { ...journal, id: 'j2', number: 'JV-2026-00002', reversalOfId: 'j1', lines: [] }),
    });
    render(wrap(<JournalsPage />));
    await userEvent.click(await screen.findByRole('button', { name: 'Open' }));
    const detail = await screen.findByRole('region', { name: 'Journal JV-2026-00001' });
    expect(within(detail).getByText('1010 Cash on hand')).toBeInTheDocument();
    expect(
      within(detail).getByText('Totals in base currency: debit 500.00, credit 500.00'),
    ).toBeInTheDocument();
    await userEvent.click(within(detail).getByRole('button', { name: 'Reverse' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'Wrong account');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reverse' }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === '/journals/j1/reverse')).toBe(true);
    });
    expect(calls.find((c) => c.path === '/journals/j1/reverse')?.body).toEqual({
      reason: 'Wrong account',
    });
    // The reversal is shown and offers no further reversal.
    expect(
      await screen.findByRole('region', { name: 'Journal JV-2026-00002' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reverse' })).toBeNull();
  });
});

describe('manual journals screen', () => {
  it('saves a balanced draft, then posts it with its version', async () => {
    const draft = {
      id: 'm1',
      number: 'MJ-2026-00001',
      entryDate: '2026-11-10',
      description: 'Float',
      lines: [
        { accountCode: '1010', debit: '500' },
        { accountCode: '1020', credit: '500' },
      ],
      status: 'draft',
      journalId: null,
      version: 3,
    };
    const calls = stub({
      ...signedIn([
        'gl.manual_journal.read',
        'gl.manual_journal.create',
        'gl.manual_journal.post',
        'gl.account.read',
      ]),
      'GET /accounts/tree': () => json(200, { items: tree }),
      'GET /manual-journals': () => json(200, { items: [draft], total: 1 }),
      'POST /manual-journals': () => json(201, draft),
      'POST /manual-journals/m1/post': () =>
        json(200, { ...draft, status: 'posted', journal: { number: 'JV-2026-00001' } }),
    });
    render(wrap(<ManualJournalsPage />));
    await screen.findByText('MJ-2026-00001');
    await userEvent.click(screen.getByRole('button', { name: 'New manual journal' }));
    const form = screen.getByRole('region', { name: 'New manual journal' });
    await userEvent.type(within(form).getByLabelText('Description'), 'Float');
    const first = within(form).getByRole('group', { name: 'Line 1' });
    const second = within(form).getByRole('group', { name: 'Line 2' });
    await userEvent.selectOptions(within(first).getByLabelText('Account'), '1010');
    await userEvent.type(within(first).getByLabelText('Debit'), '500');
    await userEvent.selectOptions(within(second).getByLabelText('Account'), '1020');
    await userEvent.type(within(second).getByLabelText('Credit'), '500');
    expect(within(form).getByText('Balanced')).toBeInTheDocument();
    await userEvent.click(within(form).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path === '/manual-journals')).toBe(true);
    });
    expect(
      calls.find((c) => c.method === 'POST' && c.path === '/manual-journals')?.body,
    ).toMatchObject({
      description: 'Float',
      lines: [
        { accountCode: '1010', debit: '500' },
        { accountCode: '1020', credit: '500' },
      ],
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Post' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Post' }));
    expect(await screen.findByText('Posted as journal JV-2026-00001.')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/manual-journals/m1/post')?.headers['if-match']).toBe(
      '"3"',
    );
  });
});
