// Component tests: route guard order, sign-in flow, menu filtering, Can guard, dialog.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { urlOf } from './test/helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { setAccessToken } from './api/client';
import { AuthProvider, Can } from './auth/AuthContext';
import { I18nProvider } from './i18n';
import { AppShell } from './shell/AppShell';
import type { NavGroup } from './shell/nav';
import { ThemeProvider } from './theme/theme';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { ToastProvider } from './ui/toast';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const user = { id: 'u1', username: 'root', displayName: 'Root Admin', preferredLanguage: 'en' };
const grantOf = (extra: { mustChangePassword?: boolean; mfaEnrolmentRequired?: boolean } = {}) => ({
  accessToken: 'tok',
  expiresIn: 900,
  user: { ...user, mustChangePassword: extra.mustChangePassword ?? false },
  companyId: 'c1',
  roles: ['super_admin'],
  mfaEnrolmentRequired: extra.mfaEnrolmentRequired ?? false,
});
const access = {
  userId: 'u1',
  partyId: null,
  companyId: 'c1',
  roles: [],
  permissions: ['party.read'],
  scopes: [],
};

/** Routes fetch calls by URL suffix; unknown calls fail the test loudly. */
function stubApi(routes: Record<string, () => Response>) {
  const fn = vi.fn<typeof fetch>((input) => {
    const url = urlOf(input);
    const hit = Object.keys(routes).find((k) => url.endsWith(k));
    if (hit === undefined) throw new Error(`unexpected request ${url}`);
    return Promise.resolve((routes[hit] as () => Response)());
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const providers = (ui: React.ReactNode) => (
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

describe('web app', () => {
  beforeEach(() => {
    setAccessToken(null);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the sign-in screen when there is no session, then the shell after sign-in', async () => {
    stubApi({
      '/auth/refresh': () => json(401, { code: 'unauthenticated' }),
      '/auth/login': () => json(200, { ...grantOf(), csrfToken: 'x' }),
      '/me/permissions': () => json(200, access),
      '/me/companies': () => json(200, { items: [] }),
    });
    render(<App />);
    const people = userEvent.setup();
    await people.type(await screen.findByLabelText('Organisation code'), 'demo');
    await people.type(screen.getByLabelText('Username or e-mail'), 'root');
    await people.type(screen.getByLabelText('Password'), 'secret-pass');
    await people.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Welcome, Root Admin')).toBeInTheDocument();
  });

  it('sends a user who must change the password to that screen before anything else', async () => {
    stubApi({
      '/auth/refresh': () =>
        json(200, {
          ...grantOf({ mustChangePassword: true, mfaEnrolmentRequired: true }),
          csrfToken: 'x',
        }),
    });
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: 'Change your password' }),
    ).toBeInTheDocument();
  });

  it('sends a user whose role requires an authenticator to the set-up screen', async () => {
    stubApi({
      '/auth/refresh': () =>
        json(200, { ...grantOf({ mfaEnrolmentRequired: true }), csrfToken: 'x' }),
      '/auth/mfa/totp/setup': () =>
        json(200, { secret: 'ABCDEF', otpauthUrl: 'otpauth://totp/Fibrex:root?secret=ABCDEF' }),
    });
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: 'Set up two-step verification' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('ABCDEF')).toBeInTheDocument();
  });

  it('shows the second-step screen when sign-in asks for it', async () => {
    stubApi({
      '/auth/refresh': () => json(401, {}),
      '/auth/login': () =>
        json(200, { mfaRequired: true, mfaToken: 'm'.repeat(30), expiresIn: 300 }),
    });
    render(<App />);
    const people = userEvent.setup();
    await people.type(await screen.findByLabelText('Organisation code'), 'demo');
    await people.type(screen.getByLabelText('Username or e-mail'), 'root');
    await people.type(screen.getByLabelText('Password'), 'secret-pass');
    await people.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByRole('heading', { name: 'Two-step verification' }),
    ).toBeInTheDocument();
  });

  it('builds the menu from permissions and hides what the user may not open', async () => {
    stubApi({
      '/auth/refresh': () => json(200, { ...grantOf(), csrfToken: 'x' }),
      '/me/permissions': () => json(200, access),
      '/me/companies': () => json(200, { items: [] }),
    });
    const nav: NavGroup[] = [
      {
        label: 'shell.home',
        items: [
          { to: '/a', label: 'common.save', permission: 'party.read' },
          { to: '/b', label: 'common.cancel', permission: 'iam.user.read' },
        ],
      },
    ];
    render(
      providers(
        <Can permission="never">
          <span>hidden</span>
        </Can>,
      ),
    );
    expect(screen.queryByText('hidden')).not.toBeInTheDocument();
    render(providers(<AppShell nav={nav} />));
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Save' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('link', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('ConfirmDialog calls back on confirm and on cancel', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <I18nProvider>
        <ConfirmDialog open title="Delete?" onConfirm={onConfirm} onCancel={onCancel} />
      </I18nProvider>,
    );
    const people = userEvent.setup();
    await people.click(screen.getByText('Confirm', { selector: 'button' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    await people.click(screen.getByText('Cancel', { selector: 'button' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
