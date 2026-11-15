// Tests for phase 2 row 2.7b: the template editor screen.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { I18nProvider } from './i18n';
import { parseSample, TemplatesPage } from './org/TemplatesPage';
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

const template = { id: 't1', key: 'loan.statement', kind: 'pdf', name: 'Statement', version: 1 };
const draft = {
  id: 'v1',
  templateId: 't1',
  language: 'en',
  versionNo: 1,
  subject: null,
  body: '<h1>Hi {{name}}</h1>',
  css: '',
  paper: 'A4',
  status: 'draft',
  validFrom: '2026-11-16',
  version: 3,
};

beforeEach(() => {
  setAccessToken(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('template editor', () => {
  it('checks the sample data is a JSON object', () => {
    expect('data' in parseSample('{"name":"Asha"}')).toBe(true);
    expect('data' in parseSample('')).toBe(true);
    expect('problem' in parseSample('[1]')).toBe(true);
    expect('problem' in parseSample('{oops')).toBe(true);
  });

  it('lists versions through the flat route and previews a draft with sample data', async () => {
    const calls = stub({
      ...signedIn([
        'platform.template.read',
        'platform.template_version.update',
        'platform.template_version.preview',
      ]),
      'GET /templates': () => json(200, { items: [template], total: 1 }),
      'GET /template-versions': () => json(200, { items: [draft], total: 1 }),
      'PATCH /template-versions/v1': () => json(200, { ...draft, version: 4 }),
      'POST /template-versions/v1/preview': () =>
        json(200, { subject: null, body: '<h1>Hi Asha</h1>', html: '<h1>Hi Asha</h1>' }),
    });
    render(wrap(<TemplatesPage />));
    await userEvent.click(await screen.findByRole('button', { name: /versions/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    const list = calls.find((c) => c.method === 'GET' && c.path === '/template-versions');
    expect(list?.query).toContain('templateId=t1');
    await userEvent.click(await screen.findByRole('button', { name: /save and preview/i }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === '/template-versions/v1/preview')).toBe(true);
    });
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toMatchObject({ body: draft.body, paper: 'A4' });
    const frame = await screen.findByTitle('Preview');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain('Hi Asha');
  });

  it('shows a published version read-only', async () => {
    stub({
      ...signedIn(['platform.template.read', 'platform.template_version.preview']),
      'GET /templates': () => json(200, { items: [template], total: 1 }),
      'GET /template-versions': () =>
        json(200, { items: [{ ...draft, status: 'published' }], total: 1 }),
    });
    render(wrap(<TemplatesPage />));
    await userEvent.click(await screen.findByRole('button', { name: /versions/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^view$/i }));
    expect(await screen.findByText(/cannot be edited/i)).toBeTruthy();
    expect(screen.getByLabelText<HTMLTextAreaElement>(/^body/i).readOnly).toBe(true);
  });
});
