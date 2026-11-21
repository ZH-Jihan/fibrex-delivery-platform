/**
 * Row 4.4: the Google client and the grid checks, against fake Google answers (no network).
 * Checked: the consent URL asks only for read-only access with a forced refresh token; a
 * grant with any other scope is refused and revoked; refresh and invalid_grant; 429 back-off
 * with Retry-After; 403 / 404 / disabled API / bad range in plain words; secrets never in
 * error messages; Google rows become the same padded grid an Excel upload gives; an
 * IMPORTRANGE error or loading text is unreadable, not blank.
 */
import { describe, expect, it } from 'vitest';
import { FakeGoogle, googleValues } from '../../../test/fixtures/fake-google.js';
import { snoonuGrid } from '../../../test/fixtures/snoonu-daily-report.js';
import { snoonuReportAdapter } from '../../modules/performance/snoonu-parser.js';
import { assertReadable, toGrid } from '../../modules/performance/google-connection.js';
import { ReportSourceError } from '../../modules/performance/report-adapter.js';
import { SNOONU_DEFAULT_MAPPING } from '@fibrex/shared';
import { GOOGLE_SHEETS_SCOPE, GoogleClient, GoogleError } from './google-client.js';

const CONFIG = {
  clientId: 'fake-client-id.apps.googleusercontent.com',
  clientSecret: 'fake-client-secret',
  redirectUri: 'http://localhost:5173/settings/google-connection/callback',
};

function client(fake: FakeGoogle, maxTries = 3) {
  const waits: number[] = [];
  const c = new GoogleClient(CONFIG, {
    fetch: fake.fetch,
    maxTries,
    backoffMs: 10,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  return { c, waits };
}

describe('Google client (row 4.4)', () => {
  it('asks for read-only sheets access only, offline, with forced consent and the state', () => {
    const url = new URL(client(new FakeGoogle()).c.authorizationUrl('state-123'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe(GOOGLE_SHEETS_SCOPE);
    expect(GOOGLE_SHEETS_SCOPE).toBe('https://www.googleapis.com/auth/spreadsheets.readonly');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
    expect(url.searchParams.has('client_secret')).toBe(false);
  });

  it('exchanges the code, and refuses (and revokes) a grant with a wider scope', async () => {
    const fake = new FakeGoogle();
    fake.token.authorization_code.push(FakeGoogle.grant('fake-refresh-1'));
    const { c } = client(fake);
    await expect(c.exchangeCode('code-1')).resolves.toEqual({
      refreshToken: 'fake-refresh-1',
      scope: GOOGLE_SHEETS_SCOPE,
    });
    const sent = fake.callsTo('oauth2.googleapis.com', '/token')[0]?.form;
    expect(sent?.get('grant_type')).toBe('authorization_code');
    expect(sent?.get('redirect_uri')).toBe(CONFIG.redirectUri);

    fake.token.authorization_code.splice(
      0,
      1,
      FakeGoogle.grant(
        'fake-refresh-wide',
        `${GOOGLE_SHEETS_SCOPE} https://www.googleapis.com/auth/spreadsheets`,
      ),
    );
    const err = await c.exchangeCode('code-2').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleError);
    expect((err as GoogleError).code).toBe('bad_scope');
    const revoked = fake.callsTo('oauth2.googleapis.com', '/revoke');
    expect(revoked.map((r) => r.form?.get('token'))).toEqual(['fake-refresh-wide']);
  });

  it('refreshes, and reports invalid_grant without echoing the token or the secret', async () => {
    const fake = new FakeGoogle();
    fake.token.refresh_token.push(
      FakeGoogle.access('fake-access-1', 1200),
      FakeGoogle.invalidGrant(),
    );
    const { c } = client(fake);
    await expect(c.refresh('fake-refresh-1')).resolves.toEqual({
      accessToken: 'fake-access-1',
      expiresInSeconds: 1200,
    });
    const err = (await c.refresh('fake-refresh-1').catch((e: unknown) => e)) as GoogleError;
    expect(err.code).toBe('invalid_grant');
    expect(err.message).not.toContain('fake-refresh-1');
    expect(err.message).not.toContain('fake-client-secret');
  });

  it('backs off on 429 (honouring Retry-After), then reads; gives up as quota', async () => {
    const fake = new FakeGoogle();
    const limited = {
      ...FakeGoogle.sheetsError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded'),
      headers: { 'Retry-After': '2' },
    };
    fake.values.push(limited, { status: 200, body: { values: [['a', 1]] } });
    const { c, waits } = client(fake);
    await expect(c.values('tok', 'sheet-id-aaaaaaaaaaaaaaaa', "'Daily Report'")).resolves.toEqual([
      ['a', 1],
    ]);
    expect(waits).toEqual([2000]);

    const always = new FakeGoogle();
    always.values.push(FakeGoogle.sheetsError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded'));
    const second = client(always, 3);
    const err = (await second.c
      .values('tok', 'sheet-id-aaaaaaaaaaaaaaaa', "'Daily Report'")
      .catch((e: unknown) => e)) as GoogleError;
    expect(err.code).toBe('quota');
    expect(second.waits).toEqual([10, 20]);
    expect(always.callsTo('sheets.googleapis.com')).toHaveLength(3);
  });

  it('names a sheet that is not shared, missing, a disabled API and a missing tab', async () => {
    const cases: [number, string, string, string][] = [
      [403, 'PERMISSION_DENIED', 'The caller does not have permission', 'not_shared'],
      [404, 'NOT_FOUND', 'Requested entity was not found.', 'not_found'],
      [
        403,
        'PERMISSION_DENIED',
        'Google Sheets API has not been used in project 123 before or it is disabled.',
        'api_disabled',
      ],
      [400, 'INVALID_ARGUMENT', "Unable to parse range: 'Daily Reprt'", 'bad_range'],
    ];
    for (const [status, word, message, code] of cases) {
      const fake = new FakeGoogle();
      fake.values.push(FakeGoogle.sheetsError(status, word, message));
      const err = (await client(fake)
        .c.values('tok', 'sheet-id-aaaaaaaaaaaaaaaa', "'Daily Report'")
        .catch((e: unknown) => e)) as GoogleError;
      expect(err.code).toBe(code);
    }
  });

  it('sends only a GET for values (nothing that could write)', async () => {
    const fake = new FakeGoogle();
    fake.values.push({ status: 200, body: { values: [] } });
    await client(fake).c.values('tok', 'sheet-id-aaaaaaaaaaaaaaaa', "'Daily Report'!3:3");
    const [call] = fake.callsTo('sheets.googleapis.com');
    expect(call?.method).toBe('GET');
    expect(call?.url.pathname).toContain('/values/');
    expect(call?.url.searchParams.get('valueRenderOption')).toBe('UNFORMATTED_VALUE');
    expect(call?.authorization).toBe('Bearer tok');
  });
});

describe('Google rows as a report grid (row 4.4)', () => {
  it('pads ragged rows and parses exactly like the Excel grid', () => {
    const excel = snoonuGrid();
    const google = toGrid(excel.tab, googleValues(excel));
    const context = { mapping: SNOONU_DEFAULT_MAPPING, cycleStartDay: 26, readOn: '2026-11-20' };
    const fromExcel = snoonuReportAdapter.parse(excel, context);
    const fromGoogle = snoonuReportAdapter.parse(google, context);
    expect(fromGoogle.ok).toBe(true);
    expect(fromGoogle).toEqual(fromExcel);
    const widths = new Set(google.rows.map((r) => r.length));
    expect(widths.size).toBe(1);
  });

  it('treats an IMPORTRANGE error or loading text as unreadable, not as no figures', () => {
    const broken = toGrid('Daily Report', [['#REF!']]);
    expect(() => {
      assertReadable(broken, 0);
    }).toThrow(ReportSourceError);
    const loading = toGrid('Daily Report', [['Loading...']]);
    const err = (() => {
      try {
        assertReadable(loading, 0);
      } catch (e) {
        return e as ReportSourceError;
      }
      return null;
    })();
    expect(err?.code).toBe('sheet_unreadable');
    expect(err?.retryable).toBe(true);
    // One #N/A deep in a person's figures is left for the parser (a row error).
    const rows = Array.from({ length: 6 }, () => ['x', 1]);
    rows[5] = ['x', '#N/A'];
    expect(() => {
      assertReadable(toGrid('Daily Report', rows), 0);
    }).not.toThrow();
    // The header row read alone (row 3) is checked as a top row.
    expect(() => {
      assertReadable(toGrid('Daily Report', [['#REF!']]), 2);
    }).toThrow(ReportSourceError);
  });
});
