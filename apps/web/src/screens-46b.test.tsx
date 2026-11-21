// Tests for phase 4 row 4.6b: the daily performance summary settings screen.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { I18nProvider } from './i18n';
import { SummarySettingsPage } from './performance/SummarySettingsPage';
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

const base = (extra: Record<string, () => Response>) => ({
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
  'GET /me/permissions': () => json(200, { permissions: ['performance.summary.manage'] }),
  ...extra,
});

const wrap = (children: ReactNode) => (
  <ThemeProvider>
    <I18nProvider>
      <ToastProvider>
        <AuthProvider>
          <MemoryRouter initialEntries={['/performance/summary']}>{children}</MemoryRouter>
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

const state = (recipients: string[]) => ({
  companyId: 'c1',
  recipients,
  sendTime: '07:00',
  timeZone: 'Asia/Qatar',
  enabled: true,
  version: 1,
  defaultDate: '2026-11-19',
  recent: [
    {
      date: '2026-11-18',
      variant: 'incomplete',
      reason: 'partial',
      trigger: 'scheduled',
      recipients: 1,
      sentAt: '2026-11-19T04:00:00.000Z',
    },
  ],
});

describe('Performance summary settings (row 4.6b)', () => {
  it('shows the saved settings and the last sent summaries, and saves new recipients', async () => {
    const calls = stub(
      base({
        'GET /performance/summary': () => json(200, state(['ops@example.test'])),
        'PUT /performance/summary': () =>
          json(200, state(['ops@example.test', 'boss@example.test'])),
      }),
    );
    render(wrap(<SummarySettingsPage />));
    const box = await screen.findByLabelText('Performance summary recipients');
    expect(box).toHaveValue('ops@example.test');
    expect(screen.getByText('2026-11-18')).toBeInTheDocument();
    expect(screen.getByText('Data incomplete')).toBeInTheDocument();

    await userEvent.clear(box);
    await userEvent.type(box, 'ops@example.test{enter}boss@example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        recipients: ['ops@example.test', 'boss@example.test'],
        sendTime: '07:00',
        timeZone: 'Asia/Qatar',
        enabled: true,
      });
    });
  });

  it('refuses a bad address before calling the API', async () => {
    const calls = stub(
      base({ 'GET /performance/summary': () => json(200, state(['ops@example.test'])) }),
    );
    render(wrap(<SummarySettingsPage />));
    const box = await screen.findByLabelText('Performance summary recipients');
    await userEvent.clear(box);
    await userEvent.type(box, 'not-an-email');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('asks before sending now, sends the chosen date, and shows "already sent" from the API', async () => {
    let attempt = 0;
    const calls = stub(
      base({
        'GET /performance/summary': () => json(200, state(['ops@example.test'])),
        'POST /performance/summary/send-now': () => {
          attempt += 1;
          return attempt === 1
            ? json(200, { date: '2026-11-19', variant: 'full', reason: null, recipients: 1 })
            : json(409, {
                type: 'about:blank',
                title: 'Conflict',
                status: 409,
                code: 'summary_already_sent',
                detail: 'The summary for 2026-11-19 was already sent. It is sent once per date.',
              });
        },
      }),
    );
    render(wrap(<SummarySettingsPage />));
    await screen.findByLabelText('Performance summary recipients');
    await userEvent.click(screen.getByRole('button', { name: 'Send now' }));
    // Nothing is sent until the question is confirmed.
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('send-now'))).toBe(false);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('2026-11-19');
    await userEvent.click(
      Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Send now') ??
        dialog,
    );
    await waitFor(() => {
      expect(calls.find((c) => c.path.endsWith('send-now'))?.body).toEqual({ date: '2026-11-19' });
    });

    await userEvent.click(screen.getByRole('button', { name: 'Send now' }));
    const again = await screen.findByRole('dialog');
    await userEvent.click(
      Array.from(again.querySelectorAll('button')).find((b) => b.textContent === 'Send now') ??
        again,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/was already sent/);
  });

  it('cannot send with no saved recipients', async () => {
    stub(base({ 'GET /performance/summary': () => json(200, state([])) }));
    render(wrap(<SummarySettingsPage />));
    expect(await screen.findByText(/No recipients are saved yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send now' })).toBeDisabled();
  });
});
