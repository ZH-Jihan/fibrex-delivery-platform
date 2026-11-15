// Tests for phase 2 row 2.9b: the formula and rate-table screens. All rates are invented.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { I18nProvider } from './i18n';
import { FormulasPage, parseJson, sampleInputs } from './org/FormulasPage';
import { filledDims, RateTablesPage, splitDimensions } from './org/RateTablesPage';
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

/** The n-th element of a list, failing the test when it is missing. */
function nth<T>(list: ArrayLike<T>, n: number): T {
  const item = list[n];
  if (item === undefined) throw new Error(`no element ${String(n)}`);
  return item;
}

beforeEach(() => {
  setAccessToken(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const formula = {
  id: 'f1',
  key: 'pay.per_order',
  name: 'Pay per order',
  purpose: 'pay_component',
  returnType: 'decimal',
  inputSchema: { orders: { type: 'int' }, profession: { type: 'string' } },
  version: 1,
};
const draft = {
  id: 'v1',
  formulaId: 'f1',
  versionNo: 1,
  expression: 'rate("pay_rate_per_order", {"profession": profession}) * orders',
  validFrom: '2026-11-16',
  validTo: null,
  status: 'draft',
  testCases: [],
  version: 2,
};

describe('formula screen', () => {
  it('helpers: JSON boxes and sample inputs', () => {
    expect(parseJson('{oops')).toBeUndefined();
    expect(parseJson('[]')).toEqual([]);
    expect(JSON.parse(sampleInputs(formula.inputSchema))).toEqual({ orders: 1, profession: '' });
  });

  it('saves a draft, then shows the result, the rates used and how it was calculated', async () => {
    const calls = stub({
      ...signedIn([
        'platform.formula.read',
        'platform.formula.evaluate',
        'platform.formula_version.update',
      ]),
      'GET /formulas': () => json(200, { items: [formula], total: 1 }),
      'GET /formula-versions': () => json(200, { items: [draft], total: 1 }),
      'PATCH /formula-versions/v1': () => json(200, { ...draft, version: 3 }),
      'POST /formulas/evaluate': () =>
        json(200, {
          value: '4200',
          inputs: { orders: '300', profession: 'driver' },
          rates: [
            {
              table: 'pay_rate_per_order',
              dims: { profession: 'driver' },
              value: '14.0000',
              currency: 'QAR',
            },
          ],
          trace: [
            { expression: 'rate("pay_rate_per_order", {"profession": profession})', value: '14' },
          ],
          formulaVersionId: 'v1',
          versionNo: 1,
          checksum: 'x',
        }),
    });
    render(wrap(<FormulasPage />));
    await userEvent.click(await screen.findByRole('button', { name: /versions/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    await userEvent.click(await screen.findByRole('button', { name: /calculate/i }));
    expect(await screen.findByText('4200')).toBeTruthy();
    expect(screen.getByText(/pay_rate_per_order \(profession=driver\): 14\.0000 QAR/)).toBeTruthy();
    expect(screen.getByText(/how it was calculated/i)).toBeTruthy();
    const list = calls.find((c) => c.method === 'GET' && c.path === '/formula-versions');
    expect(list?.query).toContain('formulaId=f1');
    const evaluate = calls.find((c) => c.path === '/formulas/evaluate');
    expect(evaluate?.body).toMatchObject({ versionId: 'v1', explain: true });
    expect(calls.some((c) => c.method === 'PATCH')).toBe(true);
  });

  it('shows a version that has been in force read-only', async () => {
    stub({
      ...signedIn(['platform.formula.read']),
      'GET /formulas': () => json(200, { items: [formula], total: 1 }),
      'GET /formula-versions': () =>
        json(200, { items: [{ ...draft, status: 'active' }], total: 1 }),
    });
    render(wrap(<FormulasPage />));
    await userEvent.click(await screen.findByRole('button', { name: /versions/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^view$/i }));
    expect(await screen.findByText(/cannot be edited/i)).toBeTruthy();
    expect(screen.getByLabelText<HTMLTextAreaElement>(/^formula/i).readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: /put in force/i })).toBeNull();
  });
});

const table = {
  id: 't1',
  key: 'pay_rate_per_order',
  name: 'Pay rate per order',
  dimensions: ['platform', 'profession'],
  version: 1,
};
const started = {
  id: 'r1',
  rateTableId: 't1',
  dims: { profession: 'driver' },
  value: '14.0000',
  currency: 'QAR',
  validFrom: '2026-01-01',
  validTo: null,
  version: 1,
};

describe('rate-table screen', () => {
  it('helpers: dimensions and filled-in values', () => {
    expect(splitDimensions(' platform, profession ,')).toEqual(['platform', 'profession']);
    expect(filledDims({ platform: ' ', profession: 'rider ' })).toEqual({ profession: 'rider' });
  });

  it('lists rates with "Any", adds one and finds the rate for a day', async () => {
    const calls = stub({
      ...signedIn(['platform.rate_table.read', 'platform.rate_table_row.create']),
      'GET /rate-tables': () => json(200, { items: [table], total: 1 }),
      'GET /rate-table-rows': () => json(200, { items: [started], total: 1 }),
      'POST /rate-table-rows': () => json(201, { ...started, id: 'r2' }),
      'GET /rate-tables/pay_rate_per_order/resolve': () =>
        json(200, { value: '14.0000', currency: 'QAR', row: started }),
    });
    render(wrap(<RateTablesPage />));
    await userEvent.click(await screen.findByRole('button', { name: /^rates$/i }));
    expect(await screen.findAllByText('Any')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /add rate/i }));
    const form = screen.getByRole('region', { name: /add rate/i });
    const boxes = form.querySelectorAll('input');
    await userEvent.type(nth(boxes, 1), 'rider'); // profession
    await userEvent.type(nth(boxes, 2), '10'); // rate
    await userEvent.click(nth(screen.getAllByRole('button', { name: /^save$/i }), 0));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path === '/rate-table-rows')).toBe(true);
    });
    const added = calls.find((c) => c.method === 'POST' && c.path === '/rate-table-rows');
    expect(added?.body).toMatchObject({
      rateTableId: 't1',
      dims: { profession: 'rider' },
      value: '10',
      currency: 'QAR',
      validTo: null,
    });

    await userEvent.click(screen.getByRole('button', { name: /find the rate/i }));
    expect(await screen.findByText('14.0000 QAR')).toBeTruthy();
    const resolve = calls.find((c) => c.path.endsWith('/resolve'));
    expect(decodeURIComponent(resolve?.query ?? '')).toContain('dims={}');
  });

  it('a rate that has started can only get an end date', async () => {
    const calls = stub({
      ...signedIn([
        'platform.rate_table.read',
        'platform.rate_table_row.update',
        'platform.rate_table_row.delete',
      ]),
      'GET /rate-tables': () => json(200, { items: [table], total: 1 }),
      'GET /rate-table-rows': () => json(200, { items: [started], total: 1 }),
      'PATCH /rate-table-rows/r1': () => json(200, { ...started, validTo: '2099-12-31' }),
    });
    render(wrap(<RateTablesPage />));
    await userEvent.click(await screen.findByRole('button', { name: /^rates$/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    expect(screen.getByText(/only its end date can change/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();
    const form = screen.getByRole('region', { name: /edit rate/i });
    const end = nth(form.querySelectorAll('input'), 5);
    await userEvent.type(end, '2099-12-31');
    await userEvent.click(nth(screen.getAllByRole('button', { name: /^save$/i }), 0));
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ validTo: '2099-12-31' });
    });
  });
});
