// Tests for phase 3 row 3.7: bulk scan upload, suggestions, confirm and reject.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { I18nProvider } from './i18n';
import { BulkUploadPage } from './people/BulkUploadPage';
import { urlOf } from './test/helpers';
import { ThemeProvider } from './theme/theme';
import { ToastProvider } from './ui/toast';

const QID = '1d6f0c8e-5f3a-4d6e-9c1a-2f7d8e9a0b1c';
const RAHIM = '0b8f0c8e-5f3a-4d6e-9c1a-2f7d8e9a0b1c';

vi.mock('./data/upload', () => ({ uploadFile: vi.fn(() => Promise.resolve('file-1')) }));

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

const job = (id: string, holder: string) => ({
  id,
  status: 'completed',
  provider: 'stub',
  error: null,
  flags: [],
  fields: {
    documentTypeId: { value: QID, confidence: 0.9 },
    number: { value: '28435600123', masked: '*******0123', confidence: 0.93 },
    holderName: { value: holder, confidence: 0.88 },
    issueDate: { value: '2025-11-19', confidence: 0.9 },
    expiryDate: { value: '2028-11-18', confidence: 0.95 },
  },
});
const item = (id: string, suggested: boolean, status = 'pending') => ({
  id,
  status,
  suggestedPartyId: suggested ? RAHIM : null,
  suggestedPartyName: suggested ? 'Rahim' : null,
  suggestedDocumentTypeId: QID,
  rejectReason: null,
  job: job(`job-${id}`, 'Rahim'),
});
const batch = {
  id: 'b1',
  status: 'open',
  uploadedCount: 2,
  pendingCount: 2,
  items: [item('i1', true), item('i2', false)],
};

const routes = (extra: Record<string, () => Response> = {}) => ({
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
      permissions: ['people.bulk_upload.read', 'people.bulk_upload.create'],
    }),
  'GET /employees': () =>
    json(200, {
      items: [{ id: 'e1', partyId: RAHIM, employeeCode: 'E0001', displayName: 'Rahim' }],
      total: 1,
    }),
  'GET /document-types': () =>
    json(200, { items: [{ id: QID, code: 'qid', name: { en: 'QID' } }] }),
  'POST /bulk-uploads': () => json(201, batch),
  ...extra,
});

const wrap = () => (
  <ThemeProvider>
    <I18nProvider>
      <ToastProvider>
        <AuthProvider>
          <MemoryRouter>
            <BulkUploadPage />
          </MemoryRouter>
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

async function pickTwo() {
  await userEvent.upload(await screen.findByLabelText('Choose scans'), [
    new File(['a'], 'a.jpg', { type: 'image/jpeg' }),
    new File(['b'], 'b.jpg', { type: 'image/jpeg' }),
  ]);
  await userEvent.click(await screen.findByRole('button', { name: 'Read 2 scans' }));
}

describe('bulk scan upload', () => {
  it('reads the files, pre-selects the suggested person and saves only on confirm', async () => {
    const calls = stub(
      routes({
        'POST /bulk-uploads/b1/items/i1/confirm': () => json(201, { item: {}, pendingCount: 1 }),
        'GET /bulk-uploads/b1': () =>
          json(200, {
            ...batch,
            pendingCount: 1,
            items: [item('i1', true, 'confirmed'), item('i2', false)],
          }),
      }),
    );
    render(wrap());
    await pickTwo();

    expect(await screen.findByText('2 of 2 still to review')).toBeTruthy();
    expect(calls.find((c) => c.path === '/bulk-uploads')?.body).toEqual({
      fileObjectIds: ['file-1', 'file-1'],
    });
    // Scan 1 has a suggested person, so its form is open; scan 2 asks for a person.
    expect(await screen.findByDisplayValue('28435600123')).toBeTruthy();
    expect(screen.getByText('No single match for the name read: choose the person.')).toBeTruthy();
    expect(calls.some((c) => c.path.endsWith('/confirm'))).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Confirm and save' }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === '/bulk-uploads/b1/items/i1/confirm')).toBe(true);
    });
    expect(calls.find((c) => c.path.endsWith('/i1/confirm'))?.body).toMatchObject({
      ownerType: 'party',
      ownerId: RAHIM,
      documentTypeId: QID,
    });
    expect(await screen.findByText('1 of 2 still to review')).toBeTruthy();
  });

  it('rejects a scan only with a reason', async () => {
    const calls = stub(
      routes({
        'POST /bulk-uploads/b1/items/i2/reject': () => json(200, { item: {}, pendingCount: 1 }),
        'GET /bulk-uploads/b1': () =>
          json(200, {
            ...batch,
            pendingCount: 1,
            items: [item('i1', true), item('i2', false, 'rejected')],
          }),
      }),
    );
    render(wrap());
    await pickTwo();
    await screen.findByText('2 of 2 still to review');

    const rejectButtons = await screen.findAllByRole('button', { name: 'Reject' });
    await userEvent.click(rejectButtons.at(1) ?? rejectButtons[0] ?? document.body);
    const submit = screen.getByRole('button', { name: 'Reject this scan' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Reason for rejecting'), 'Blurry');
    await userEvent.click(submit);
    await waitFor(() => {
      expect(calls.find((c) => c.path === '/bulk-uploads/b1/items/i2/reject')?.body).toEqual({
        reason: 'Blurry',
      });
    });
  });
});
