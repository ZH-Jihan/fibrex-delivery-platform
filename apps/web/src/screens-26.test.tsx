// Tests for phase 2 row 2.6a: the record-type builder screen.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { I18nProvider } from './i18n';
import { EntityBuilderPage, entityFormInitial, fieldFormInitial } from './org/EntityBuilderPage';
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

const entity = {
  id: 'e1',
  key: 'inspection',
  name: { en: 'Inspection' },
  kind: 'custom',
  numberingKey: null,
  status: 'draft',
  publishedVersion: 0,
  hasUnpublishedChanges: true,
  version: 1,
};

beforeEach(() => {
  setAccessToken(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('record-type builder', () => {
  it('builds form starting values', () => {
    expect(entityFormInitial(null).key).toBe('');
    expect(fieldFormInitial(null).type).toBe('text');
  });

  it('lists types and publishes a draft', async () => {
    const calls = stub({
      ...signedIn(['platform.entity_definition.read', 'platform.entity_definition.publish']),
      'GET /entity-definitions': () => json(200, { items: [entity], total: 1 }),
      'GET /lookup-types': () => json(200, { items: [], total: 0 }),
      'POST /entity-definitions/e1/publish': () => json(200, entity),
    });
    render(wrap(<EntityBuilderPage />));
    await screen.findByText('inspection');
    await userEvent.click(await screen.findByRole('button', { name: /publish/i }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/publish'))).toBe(true);
    });
  });

  it('hides create and publish without permission', async () => {
    stub({
      ...signedIn(['platform.entity_definition.read']),
      'GET /entity-definitions': () => json(200, { items: [entity], total: 1 }),
      'GET /lookup-types': () => json(200, { items: [], total: 0 }),
    });
    render(wrap(<EntityBuilderPage />));
    await screen.findByText('inspection');
    expect(screen.queryByRole('button', { name: /new record type/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /publish/i })).toBeNull();
  });
});
