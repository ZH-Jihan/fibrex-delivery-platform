// Tests for commit 12a: DataTable (CSV safety, sort, paging), EntityForm (validation),
// permission matrix (pending changes, re-authentication), notification bell, Ctrl+K palette.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { roleCreateSchema } from '@fibrex/shared';
import { MatrixPage } from './admin/MatrixPage';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { I18nProvider } from './i18n';
import { CommandPalette } from './shell/CommandPalette';
import { NotificationBell } from './shell/NotificationBell';
import { urlOf } from './test/helpers';
import { ThemeProvider } from './theme/theme';
import { DataTable, csvCell, toCsv } from './ui/DataTable';
import { EntityForm } from './ui/EntityForm';
import { ToastProvider } from './ui/toast';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Call {
  method: string;
  url: string;
  body: unknown;
}
/** Answers by "METHOD path-suffix"; records every call; unknown calls fail loudly. */
function stub(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>((input, init) => {
      const url = urlOf(input);
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const path = (url.split('?')[0] ?? url).replace('/api/v1', '');
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

beforeEach(() => {
  setAccessToken(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DataTable', () => {
  it('neutralises spreadsheet formulas and quotes in CSV', () => {
    expect(csvCell('=SUM(A1)')).toBe(`"'=SUM(A1)"`);
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('""');
    const csv = toCsv([{ key: 'a', header: 'A', value: (r: { a: string }) => r.a }], [{ a: '@x' }]);
    expect(csv).toBe(`"A"\r\n"'@x"`);
  });

  it('sorts the page on header click and pages through', async () => {
    const onPage = vi.fn();
    render(
      wrap(
        <DataTable
          columns={[{ key: 'n', header: 'Name', value: (r: { n: string }) => r.n }]}
          rows={[{ n: 'bravo' }, { n: 'alpha' }]}
          rowKey={(r) => r.n}
          total={60}
          page={1}
          pageSize={25}
          onPageChange={onPage}
        />,
      ),
    );
    const people = userEvent.setup();
    await people.click(screen.getByRole('button', { name: 'Sort by Name' }));
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows.at(0) ?? document.body).getByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 3 (60 rows)')).toBeInTheDocument();
    await people.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPage).toHaveBeenCalledWith(2);
  });
});

describe('EntityForm', () => {
  it('shows schema errors and sends nothing until the values are valid', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(
      wrap(
        <EntityForm
          fields={[
            { name: 'key', label: 'Key' },
            { name: 'name', label: 'Name' },
          ]}
          schema={roleCreateSchema}
          onSubmit={onSubmit}
        />,
      ),
    );
    const people = userEvent.setup();
    await people.type(screen.getByLabelText('Key'), 'Bad Key');
    await people.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findAllByRole('alert')).not.toHaveLength(0);

    await people.clear(screen.getByLabelText('Key'));
    await people.type(screen.getByLabelText('Key'), 'clerk');
    await people.type(screen.getByLabelText('Name'), 'Clerk');
    await people.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ key: 'clerk', name: 'Clerk' });
    });
  });
});

describe('MatrixPage', () => {
  const matrix = {
    roles: [{ id: 'r1', key: 'viewer', name: 'Viewer', isBuiltin: true }],
    permissions: [{ key: 'party.read', moduleKey: 'party', description: 'Read parties' }],
    grants: [],
  };
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
    'GET /me/permissions': () =>
      json(200, {
        userId: 'u1',
        partyId: null,
        companyId: 'c1',
        roles: [],
        permissions: ['iam.permission_matrix.read', 'iam.permission_matrix.update'],
        scopes: [],
      }),
    'GET /permission-matrix': () => json(200, matrix),
  };

  it('saves ticked cells, asking for the password when the API requires it', async () => {
    let puts = 0;
    const calls = stub({
      ...signedIn,
      'PUT /permission-matrix': () => {
        puts += 1;
        return puts === 1 ? json(403, { code: 'reauth_required' }) : json(200, {});
      },
      'POST /auth/reauth': () => json(200, {}),
    });
    render(wrap(<MatrixPage />));
    const people = userEvent.setup();
    const box = await screen.findByRole('checkbox', { name: 'Viewer: party.read' });
    await people.click(box);
    expect(screen.getByText('1 unsaved changes')).toBeInTheDocument();
    await people.click(screen.getByRole('button', { name: 'Save changes' }));
    await people.type(await screen.findByLabelText('Password'), 'secret-pass');
    await people.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(puts).toBe(2);
    });
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toEqual({
      changes: [{ roleId: 'r1', permissionKey: 'party.read', granted: true }],
    });
  });

  it('cancels a pending change when the box is ticked back', async () => {
    stub(signedIn);
    render(wrap(<MatrixPage />));
    const people = userEvent.setup();
    const box = await screen.findByRole('checkbox', { name: 'Viewer: party.read' });
    await people.click(box);
    await people.click(box);
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('on a phone shows one role at a time with a switch per permission', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: /max-width: (\d+)px/.test(query),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    stub(signedIn);
    render(wrap(<MatrixPage />));
    const people = userEvent.setup();
    expect(await screen.findByRole('combobox', { name: 'Role' })).toHaveValue('r1');
    expect(screen.queryByRole('table')).toBeNull();
    await people.click(screen.getByRole('switch', { name: 'Viewer: party.read' }));
    expect(screen.getByText('1 unsaved changes')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});

describe('NotificationBell', () => {
  it('shows the unread count and marks everything read', async () => {
    const calls = stub({
      'GET /notifications/unread-count': () => json(200, { unread: 3 }),
      'GET /notifications': () =>
        json(200, {
          items: [
            {
              id: 'n1',
              title: 'Hello',
              body: 'World',
              read: false,
              createdAt: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      'POST /notifications/read-all': () => json(200, { marked: 1 }),
    });
    render(wrap(<NotificationBell />));
    const people = userEvent.setup();
    await people.click(await screen.findByRole('button', { name: 'Notifications (3)' }));
    expect(await screen.findByText('Hello')).toBeInTheDocument();
    await people.click(screen.getByRole('button', { name: 'Mark all as read' }));
    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith('/notifications/read-all'))).toBe(true);
    });
    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeInTheDocument();
  });
});

describe('CommandPalette', () => {
  it('opens with Ctrl+K and filters the screens it was given', async () => {
    render(
      wrap(
        <CommandPalette
          entries={[
            { to: '/users', label: 'nav.users' },
            { to: '/roles', label: 'nav.roles' },
          ]}
        />,
      ),
    );
    const people = userEvent.setup();
    await people.keyboard('{Control>}k{/Control}');
    await people.type(screen.getByPlaceholderText('Type to find a screen (Ctrl+K)'), 'rol');
    expect(screen.getByRole('button', { name: 'Roles' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Users' })).not.toBeInTheDocument();
  });
});
