// Tests for phase 3 row 3.6: scan to fill in, the OCR confirm panel and its confidence hints.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { I18nProvider, translate } from './i18n';
import { EmployeeProfilePage } from './people/EmployeeProfilePage';
import { confidenceText } from './people/OcrScan';

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

const wrap = () => (
  <ThemeProvider>
    <I18nProvider>
      <ToastProvider>
        <AuthProvider>
          <MemoryRouter initialEntries={['/employees/e1']}>
            <Routes>
              <Route path="employees/:id" element={<EmployeeProfilePage />} />
            </Routes>
          </MemoryRouter>
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
  'GET /employees/e1': () =>
    json(200, {
      id: 'e1',
      partyId: '0b8f0c8e-5f3a-4d6e-9c1a-2f7d8e9a0b1c',
      employeeCode: 'E0001',
      displayName: 'Rahim',
      statusCode: 'active',
      sponsorship: 'company',
      joiningDate: '2026-01-05',
      version: 1,
    }),
  'GET /document-types': () =>
    json(200, { items: [{ id: QID, code: 'qid', name: { en: 'QID' } }] }),
});

const QID = '1d6f0c8e-5f3a-4d6e-9c1a-2f7d8e9a0b1c';
const PARTY = '0b8f0c8e-5f3a-4d6e-9c1a-2f7d8e9a0b1c';

vi.mock('./data/upload', () => ({ uploadFile: vi.fn(() => Promise.resolve('file-1')) }));

const ocrJob = {
  id: 'job-1',
  status: 'completed',
  provider: 'stub',
  error: null,
  flags: ['low_confidence', 'name_mismatch'],
  fields: {
    documentTypeId: { value: QID, confidence: 0.8 },
    number: { value: '28435600123', masked: '*******0123', confidence: 0.93 },
    holderName: { value: 'Someone Else', confidence: 0.88 },
    issueDate: { value: '2025-11-19', confidence: 0.4 },
    expiryDate: { value: '2028-11-18', confidence: 0.95 },
  },
};

beforeEach(() => {
  setAccessToken(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('confidence hint', () => {
  const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
    translate('en', key, values);
  it('shows the percentage, asks to check a low one, and says when nothing was read', () => {
    expect(confidenceText(t, { value: 'x', confidence: 0.93 })).toBe('Read with 93% confidence');
    expect(confidenceText(t, { value: 'x', confidence: 0.35 })).toBe(
      'Low confidence (35%): check this',
    );
    expect(confidenceText(t, { value: null, confidence: 0 })).toBe('Not read: type it in');
  });
});

describe('scan to fill in', () => {
  it('pre-fills from the scan, shows warnings, and saves only the confirmed values', async () => {
    const calls = stub({
      ...signedIn([
        'people.employee.read',
        'people.document.create',
        'people.document.update',
        'people.ocr_job.create',
      ]),
      'GET /documents': () => json(200, { items: [] }),
      'POST /ocr/jobs': () => json(201, ocrJob),
      'POST /ocr/jobs/job-1/confirm': () => json(201, { id: 'd1' }),
    });
    render(wrap());
    await userEvent.click(await screen.findByRole('tab', { name: 'Documents' }));
    await userEvent.upload(
      await screen.findByLabelText('Scan to fill in'),
      new File(['scan'], 'qid.jpg', { type: 'image/jpeg' }),
    );

    // The reading fills the form; nothing is saved yet.
    expect(await screen.findByDisplayValue('28435600123')).toBeTruthy();
    expect(screen.getByText(/Demo reading/)).toBeTruthy();
    expect(screen.getByText('The name on the document does not match this person')).toBeTruthy();
    expect(screen.getByText(/Low confidence \(40%\)/)).toBeTruthy();
    expect(calls.some((c) => c.path === '/documents' && c.method === 'POST')).toBe(false);
    expect(calls.find((c) => c.path === '/ocr/jobs')?.body).toEqual({
      fileObjectId: 'file-1',
      ownerId: PARTY,
    });

    // The person corrects the issue date and confirms.
    const issue = screen.getByLabelText('Issue date');
    await userEvent.clear(issue);
    await userEvent.type(issue, '2025-11-20');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm and save' }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === '/ocr/jobs/job-1/confirm')).toBe(true);
    });
    expect(calls.find((c) => c.path === '/ocr/jobs/job-1/confirm')?.body).toEqual({
      ownerType: 'party',
      ownerId: PARTY,
      documentTypeId: QID,
      number: '28435600123',
      issueDate: '2025-11-20',
      expiryDate: '2028-11-18',
    });
  });

  it('hides the scan button without the OCR permission', async () => {
    stub({
      ...signedIn(['people.employee.read', 'people.document.create']),
      'GET /documents': () => json(200, { items: [] }),
    });
    render(wrap());
    await userEvent.click(await screen.findByRole('tab', { name: 'Documents' }));
    await screen.findByRole('button', { name: 'Add other document' });
    expect(screen.queryByLabelText('Scan to fill in')).toBeNull();
  });
});
