// Tests for the responsive shell: the mobile drawer (opens from the hamburger, closes on
// Escape and on navigation, holds the menu), the desktop sidebar collapse, and the tab bar.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { I18nProvider } from './i18n';
import { AppShell } from './shell/AppShell';
import { mobileTabs } from './shell/nav';
import type { NavGroup } from './shell/nav';
import { urlOf } from './test/helpers';
import { ThemeProvider } from './theme/theme';
import { ToastProvider } from './ui/toast';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const grant = {
  accessToken: 'tok',
  expiresIn: 900,
  user: {
    id: 'u1',
    username: 'root',
    displayName: 'Root Admin',
    preferredLanguage: 'en',
    mustChangePassword: false,
  },
  companyId: 'c1',
  roles: [],
  mfaEnrolmentRequired: false,
  csrfToken: 'x',
};
const access = {
  userId: 'u1',
  partyId: null,
  companyId: 'c1',
  roles: [],
  permissions: ['iam.user.read', 'party.party.read'],
  scopes: [],
};

function stubApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>((input) => {
      const url = urlOf(input);
      if (url.endsWith('/auth/refresh')) return Promise.resolve(json(200, grant));
      if (url.endsWith('/me/permissions')) return Promise.resolve(json(200, access));
      if (url.endsWith('/me/companies')) return Promise.resolve(json(200, { items: [] }));
      if (url.includes('/notifications'))
        return Promise.resolve(json(200, { unread: 0, items: [] }));
      return Promise.reject(new Error(`unexpected request ${url}`));
    }),
  );
}

/** Pretends the viewport is `width` pixels wide for the breakpoint hook. */
function fakeViewport(width: number) {
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => {
    const max = /max-width: (\d+)px/.exec(query);
    const matches = max !== null && width <= Number(max[1]);
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  });
}

const nav: NavGroup[] = [
  {
    label: 'nav.admin',
    items: [{ to: '/users', label: 'nav.users', permission: 'iam.user.read' }],
  },
  {
    label: 'nav.people.group',
    items: [{ to: '/people', label: 'nav.people', permission: 'party.party.read' }],
  },
];

const app = (
  <ThemeProvider>
    <I18nProvider>
      <ToastProvider>
        <AuthProvider>
          <MemoryRouter>
            <Routes>
              <Route element={<AppShell nav={nav} />}>
                <Route index element={<h1>Home page</h1>} />
                <Route path="users" element={<h1>Users page</h1>} />
                <Route path="people" element={<h1>People page</h1>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </ToastProvider>
    </I18nProvider>
  </ThemeProvider>
);

describe('responsive shell', () => {
  beforeEach(() => {
    setAccessToken(null);
    stubApi();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('on a phone: hamburger opens the drawer, Escape closes it, a tab bar lists the main screens', async () => {
    fakeViewport(375);
    render(app);
    const people = userEvent.setup();
    const burger = await screen.findByRole('button', { name: 'Open menu' });
    // No sidebar on a phone: the only navigation is the tab bar.
    expect(screen.getByRole('navigation', { name: 'Quick access' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Menu' })).not.toBeInTheDocument();

    await people.click(burger);
    const drawer = screen.getByRole('dialog', { name: 'Menu' });
    expect(drawer).toBeInTheDocument();
    expect(drawer).toHaveAttribute('open');
    expect(screen.getByRole('navigation', { name: 'Menu' })).toBeInTheDocument();

    await people.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Menu' })).not.toBeInTheDocument();
    });

    // Navigating from the drawer closes it.
    await people.click(burger);
    await people.click(
      within(screen.getByRole('navigation', { name: 'Menu' })).getByRole('link', { name: 'Users' }),
    );
    expect(await screen.findByRole('heading', { name: 'Users page' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Menu' })).not.toBeInTheDocument();
    });
  });

  it('on a desktop: the sidebar is shown and can be collapsed', async () => {
    fakeViewport(1440);
    render(app);
    const people = userEvent.setup();
    const sidebar = await screen.findByRole('navigation', { name: 'Menu' });
    expect(sidebar).toHaveAttribute('data-mode', 'full');
    expect(screen.queryByRole('button', { name: 'Open menu' })).not.toBeInTheDocument();
    await people.click(screen.getByRole('button', { name: 'Collapse menu' }));
    expect(sidebar).toHaveAttribute('data-mode', 'collapsed');
    expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute('title', 'Users');
  });

  it('on a tablet: the sidebar is an icon rail that the toggle keeps open', async () => {
    fakeViewport(900);
    render(app);
    const people = userEvent.setup();
    const sidebar = await screen.findByRole('navigation', { name: 'Menu' });
    expect(sidebar).toHaveAttribute('data-mode', 'rail');
    await people.click(screen.getByRole('button', { name: 'Keep the menu open' }));
    expect(sidebar).toHaveAttribute('data-mode', 'full');
  });

  it('picks the four most used screens for the tab bar, topped up with what is left', () => {
    const tabs = mobileTabs(nav);
    expect(tabs.map((t) => t.to)).toEqual(['/', '/users', '/people']);
  });
});
