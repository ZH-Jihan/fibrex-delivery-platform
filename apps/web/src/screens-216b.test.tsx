// Tests for phase 2 row 2.16b: the posting simulation screen. All values are invented.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { I18nProvider } from './i18n';
import { parseInputs, SimulatePage } from './ledger/SimulatePage';
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

const signedIn = {
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
  'GET /me/permissions': () => json(200, { permissions: ['gl.posting_rule.read'] }),
};

const simulation = {
  rule: { id: 'r1', versionNo: 2, status: 'active' },
  entryDate: '2026-03-01',
  baseCurrency: 'QAR',
  lines: [
    {
      lineNo: 1,
      accountCode: '1220',
      debit: '100.0000',
      credit: '0.0000',
      currency: 'QAR',
      fxRate: '1.00000000',
      baseDebit: '100.0000',
      baseCredit: '0.0000',
      memo: null,
    },
    {
      lineNo: 2,
      accountCode: '1110',
      debit: '0.0000',
      credit: '100.0000',
      currency: 'QAR',
      fxRate: '1.00000000',
      baseDebit: '0.0000',
      baseCredit: '100.0000',
      memo: 'Cash out',
    },
  ],
  totals: { debit: '100.0000', credit: '100.0000', balanced: true },
  period: { id: 'p1', status: 'open' },
  postable: true,
};

beforeEach(() => {
  setAccessToken(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseInputs', () => {
  it('accepts an object or nothing and refuses everything else', () => {
    expect(parseInputs('')).toEqual({});
    expect(parseInputs('{"amount":"5"}')).toEqual({ amount: '5' });
    expect(parseInputs('[1]')).toBeNull();
    expect(parseInputs('not json')).toBeNull();
  });
});

describe('SimulatePage', () => {
  const view = () =>
    render(
      <ThemeProvider>
        <I18nProvider>
          <ToastProvider>
            <AuthProvider>
              <MemoryRouter>
                <SimulatePage />
              </MemoryRouter>
            </AuthProvider>
          </ToastProvider>
        </I18nProvider>
      </ThemeProvider>,
    );

  it('sends the event, date and inputs and shows the journal that would post', async () => {
    const calls = stub({
      ...signedIn,
      'POST /posting-rules/loan.disbursed/simulate': () => json(200, simulation),
    });
    const user = userEvent.setup();
    view();
    await user.type(await screen.findByLabelText('Event key'), 'loan.disbursed');
    const inputs = screen.getByLabelText('Event inputs (JSON)');
    await user.clear(inputs);
    await user.click(inputs);
    await user.paste('{"amount":"100"}');
    await user.click(screen.getByRole('button', { name: 'Simulate' }));
    expect(await screen.findByText('Could be posted')).toBeTruthy();
    expect(screen.getByText('Balanced')).toBeTruthy();
    const sent = calls.find((c) => c.path.endsWith('/simulate'));
    expect(sent?.body).toMatchObject({ inputs: { amount: '100' } });
  });

  it('refuses inputs that are not a JSON object without calling the server', async () => {
    const calls = stub(signedIn);
    const user = userEvent.setup();
    view();
    await user.type(await screen.findByLabelText('Event key'), 'loan.disbursed');
    const inputs = screen.getByLabelText('Event inputs (JSON)');
    await user.clear(inputs);
    await user.click(inputs);
    await user.paste('[1,2]');
    await user.click(screen.getByRole('button', { name: 'Simulate' }));
    await waitFor(() => {
      expect(screen.getByText(/must be a JSON object/)).toBeTruthy();
    });
    expect(calls.some((c) => c.path.endsWith('/simulate'))).toBe(false);
  });
});
