// Tests for phase 2 row 2.6b: generated record pages.
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { I18nProvider } from './i18n';
import {
  activeFields,
  dataToForm,
  displayValue,
  formToData,
  RecordsPage,
  sectionsOf,
  type PublishedType,
} from './records/RecordPages';
import { urlOf } from './test/helpers';
import { ThemeProvider } from './theme/theme';
import { ToastProvider } from './ui/toast';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const field = (key: string, type: string, sortOrder: number, extra = {}) => ({
  id: key,
  key,
  label: { en: key.toUpperCase() },
  type,
  validations: {},
  required: false,
  sortOrder,
  status: 'published',
  ...extra,
});

const published = {
  id: 't1',
  key: 'inspection',
  name: { en: 'Inspection' },
  version: 1,
  listConfig: { columns: ['number', 'result'] },
  formLayout: { sections: [] },
  detailLayout: { sections: [] },
  numberingKey: null,
  fields: [
    field('result', 'dropdown', 1, { lookupKey: 'results' }),
    field('km', 'number', 2),
    field('old', 'text', 3, { status: 'retired' }),
  ],
  jsonSchema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
} as unknown as PublishedType;

describe('record page helpers', () => {
  it('drops retired fields and orders by sortOrder', () => {
    expect(activeFields(published).map((f) => f.key)).toEqual(['result', 'km']);
  });

  it('puts unplaced fields in a last section', () => {
    const s = sectionsOf(
      { sections: [{ title: { en: 'Main' }, fields: ['km', 'gone'] }] },
      activeFields(published),
      'en',
    );
    expect(s).toEqual([
      { title: 'Main', keys: ['km'] },
      { title: '', keys: ['result'] },
    ]);
  });

  it('converts between form text and typed data', () => {
    const f = activeFields(published);
    expect(formToData(f, { km: '120', result: 'pass' })).toEqual({ km: 120, result: 'pass' });
    expect(formToData(f, { km: '', result: '' })).toEqual({});
    expect(dataToForm(f, { km: 5 })).toEqual({ km: '5' });
  });

  it('shows lookup labels for dropdown codes', () => {
    const lookups = { results: [{ code: 'pass', labels: { en: 'Passed' } }] };
    const f = activeFields(published)[0] as (typeof published.fields)[number];
    expect(displayValue(f, 'pass', lookups, 'en', 'Yes', 'No')).toBe('Passed');
    expect(displayValue(f, 'zzz', lookups, 'en', 'Yes', 'No')).toBe('zzz');
  });
});

describe('generated records page', () => {
  beforeEach(() => {
    setAccessToken(null);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists records with columns from the definition and hides create without permission', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>((input, init) => {
        const url = urlOf(input);
        const path = (url.split('?')[0] ?? url).replace('/api/v1', '');
        const method = init?.method ?? 'GET';
        if (path.endsWith('/auth/refresh') && method === 'POST')
          return Promise.resolve(
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
          );
        if (path.endsWith('/me/permissions'))
          return Promise.resolve(json(200, { permissions: ['custom.inspection.read'] }));
        if (path.endsWith('/entities/inspection')) return Promise.resolve(json(200, published));
        if (path.endsWith('/lookups/results'))
          return Promise.resolve(
            json(200, { items: [{ code: 'pass', labels: { en: 'Passed' } }] }),
          );
        if (path.endsWith('/records/inspection'))
          return Promise.resolve(
            json(200, {
              items: [
                {
                  id: 'r1',
                  number: 'INS-1',
                  stateCode: null,
                  data: { result: 'pass' },
                  version: 1,
                },
              ],
              total: 1,
            }),
          );
        return Promise.reject(new Error(`unexpected ${method} ${url}`));
      }),
    );
    render(
      <ThemeProvider>
        <I18nProvider>
          <ToastProvider>
            <AuthProvider>
              <MemoryRouter initialEntries={['/records/inspection']}>
                <Routes>
                  <Route path="records/:key" element={<RecordsPage />} />
                </Routes>
              </MemoryRouter>
            </AuthProvider>
          </ToastProvider>
        </I18nProvider>
      </ThemeProvider>,
    );
    await screen.findByText('INS-1');
    expect(screen.getByText('Passed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new inspection/i })).toBeNull();
  });
});
