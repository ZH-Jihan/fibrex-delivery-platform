/**
 * Fake Google HTTP (phase 4 row 4.4): a `fetch` that answers like Google's token, revoke
 * and Sheets values endpoints, from responses the test sets. No network, no real token, no
 * real data: tokens are invented strings and the sheet is the fake Snoonu fixture.
 *
 * The answers follow Google's documented shapes (recorded from the API reference):
 *   token ok     { access_token, expires_in, refresh_token?, scope, token_type: "Bearer" }
 *   token error  400 { error: "invalid_grant", error_description: "Token has been expired or revoked." }
 *   values ok    { range, majorDimension: "ROWS", values: [[...], ...] } (trailing blanks left out)
 *   values error { error: { code, message, status } }
 *
 * Used by: src/adapters/google/google-client.test.ts, test/integration/performance-google.test.ts.
 */
import type { SheetCell, SheetGrid } from '../../src/modules/performance/index.js';

export const FAKE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

export interface FakeCall {
  method: string;
  url: URL;
  form: URLSearchParams | null;
  authorization: string | null;
}

/** One answer: status and JSON body, plus optional headers. */
export interface FakeAnswer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const ok = (body: unknown): FakeAnswer => ({ status: 200, body });

/** A grid cell as Google's UNFORMATTED_VALUE / SERIAL_NUMBER answer gives it. */
function googleValue(cell: SheetCell): string | number | boolean {
  if (cell === null) return '';
  if (cell instanceof Date) {
    // Serial number: days since 1899-12-30 (a time alone is the fraction of a day).
    return (cell.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000;
  }
  return cell;
}

/** The fixture grid as Google returns it: trailing blank cells and rows left out. */
export function googleValues(
  grid: SheetGrid,
  fromRow = 1,
  toRow?: number,
): (string | number | boolean)[][] {
  const rows = grid.rows.slice(fromRow - 1, toRow).map((row) => {
    const values = row.map(googleValue);
    while (values.length > 0 && values[values.length - 1] === '') values.pop();
    return values;
  });
  while (rows.length > 0 && rows[rows.length - 1]?.length === 0) rows.pop();
  return rows;
}

export class FakeGoogle {
  readonly calls: FakeCall[] = [];
  /** Next answers of the token endpoint by grant type (shifted; the last one repeats). */
  readonly token: Record<'authorization_code' | 'refresh_token', FakeAnswer[]> = {
    authorization_code: [],
    refresh_token: [],
  };
  /** Answers of the values endpoint, in order (the last one repeats); or built from `sheet`. */
  readonly values: FakeAnswer[] = [];
  /** The sheet the values endpoint serves when `values` is empty. */
  sheet: SheetGrid | null = null;

  /** A grant like Google's: read-only scope and a refresh token. */
  static grant(refreshToken: string, scope = FAKE_SCOPE): FakeAnswer {
    return ok({
      access_token: `access-${refreshToken}`,
      expires_in: 3599,
      refresh_token: refreshToken,
      scope,
      token_type: 'Bearer',
    });
  }

  static access(token: string, expiresIn = 3599): FakeAnswer {
    return ok({
      access_token: token,
      expires_in: expiresIn,
      scope: FAKE_SCOPE,
      token_type: 'Bearer',
    });
  }

  static invalidGrant(): FakeAnswer {
    return {
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
    };
  }

  static sheetsError(code: number, status: string, message: string): FakeAnswer {
    return { status: code, body: { error: { code, message, status } } };
  }

  callsTo(host: string, path?: string): FakeCall[] {
    return this.calls.filter(
      (c) => c.url.host === host && (path === undefined || c.url.pathname.includes(path)),
    );
  }

  readonly fetch: typeof fetch = (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? 'GET';
    const form = typeof init?.body === 'string' ? new URLSearchParams(init.body) : null;
    const headers = new Headers(init?.headers);
    this.calls.push({ method, url, form, authorization: headers.get('authorization') });
    const answer = this.#answer(url, form);
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'Content-Type': 'application/json', ...(answer.headers ?? {}) },
      }),
    );
  };

  #answer(url: URL, form: URLSearchParams | null): FakeAnswer {
    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/token') {
      const grant = form?.get('grant_type') as 'authorization_code' | 'refresh_token';
      const list = this.token[grant];
      const next = list.length > 1 ? list.shift() : list[0];
      return next ?? FakeGoogle.invalidGrant();
    }
    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/revoke') return ok({});
    if (url.host === 'sheets.googleapis.com') {
      const next = this.values.length > 1 ? this.values.shift() : this.values[0];
      if (next !== undefined) return next;
      if (this.sheet === null)
        return FakeGoogle.sheetsError(404, 'NOT_FOUND', 'Requested entity was not found.');
      // The range is the last path part: 'Daily Report' or 'Daily Report'!3:3.
      const range = decodeURIComponent(url.pathname.split('/values/')[1] ?? '');
      const match = /^'(.*)'(?:!(\d+):(\d+))?$/.exec(range);
      const tab = match?.[1]?.replace(/''/g, "'");
      if (tab !== this.sheet.tab) {
        return FakeGoogle.sheetsError(400, 'INVALID_ARGUMENT', `Unable to parse range: ${range}`);
      }
      const from = match?.[2] === undefined ? 1 : Number(match[2]);
      const to = match?.[3] === undefined ? undefined : Number(match[3]);
      return ok({ range, majorDimension: 'ROWS', values: googleValues(this.sheet, from, to) });
    }
    return { status: 599, body: { error: 'unexpected host in a test' } };
  }
}
