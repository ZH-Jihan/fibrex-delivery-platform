/**
 * Google OAuth 2.0 and Sheets API client, read-only (phase 4 row 4.4; SPEC 3.1, SPEC 2.11).
 *
 * Purpose: the only code that talks to Google. It builds the consent URL, swaps the
 * authorization code for a refresh token, gets short-lived access tokens, revokes a grant,
 * and reads cell values from a spreadsheet. Nothing here can write to a sheet:
 *
 *   - The one scope ever requested is `spreadsheets.readonly` (GOOGLE_SHEETS_SCOPE). A grant
 *     that comes back with any other scope is refused by `exchangeCode`, so a token that
 *     could write is never stored.
 *   - The only Sheets call is `GET .../values/{range}`.
 *
 * Secrets: the client secret, codes and tokens are sent to Google only and are never put in
 * an error message or a log line; errors carry Google's error code, not the request.
 *
 * `fetch` is injected: the app passes the global fetch; tests pass recorded fake responses,
 * so no test reaches the network or needs a real token.
 *
 * Row 4.4b: the HTTP part shared by both ways of signing in (back-off, the values call and
 * what a failed answer means) is the base class `GoogleHttp`; the service-account client
 * (./service-account.ts) extends it, so both read sheets the same way.
 *
 * Depends on: nothing but the Fetch API. Used by: ./service-account.ts,
 * modules/performance/google-connection.ts.
 */

export const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SHEETS_URL = 'https://sheets.googleapis.com/v4/spreadsheets';

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Must equal an "Authorised redirect URI" of the OAuth client in Google Cloud. */
  redirectUri: string;
}

export type GoogleErrorCode =
  /** The refresh token was revoked, expired, or belongs to a deleted client. Reconnect. */
  | 'invalid_grant'
  /** The grant came back with a scope other than read-only, or without it. */
  | 'bad_scope'
  /** Google gave no refresh token (consent not forced, or not an offline grant). */
  | 'no_refresh_token'
  /** The client id or secret is wrong. */
  | 'invalid_client'
  /** The account cannot open the spreadsheet (not shared with it). */
  | 'not_shared'
  /** No spreadsheet with this id (or hidden from the account). */
  | 'not_found'
  /** The Google Sheets API is not enabled in the Google Cloud project. */
  | 'api_disabled'
  /** Too many requests, still refused after the back-off. */
  | 'quota'
  /** The range (tab name) does not exist. */
  | 'bad_range'
  /** The access token was refused. */
  | 'unauthorized'
  /** The service account key is missing fields, not JSON, or not an RSA private key. */
  | 'invalid_key'
  /** Network failure or a Google server error after the back-off. */
  | 'unavailable';

export class GoogleError extends Error {
  readonly code: GoogleErrorCode;
  readonly status: number | null;

  constructor(code: GoogleErrorCode, message: string, status: number | null = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = 'GoogleError';
  }
}

/** A cell as the values API returns it with UNFORMATTED_VALUE (dates as serial numbers). */
export type GoogleCellValue = string | number | boolean;

export interface GoogleClientOptions {
  fetch?: typeof fetch;
  /** Waits between retries; tests pass one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Tries for a 429 or 5xx answer before giving up (default 4). */
  maxTries?: number;
  /** First back-off in ms, doubled each try, plus Retry-After when Google sends it. */
  backoffMs?: number;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
}

/**
 * The HTTP part both sign-in modes share: the injected fetch, the back-off for 429 and 5xx
 * answers, and the read-only values call. It holds no credential; callers pass the access
 * token for each read.
 */
export class GoogleHttp {
  protected readonly fetchFn: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #maxTries: number;
  readonly #backoffMs: number;

  constructor(options: GoogleClientOptions = {}) {
    this.fetchFn = options.fetch ?? fetch;
    this.#sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
    this.#maxTries = options.maxTries ?? 4;
    this.#backoffMs = options.backoffMs ?? 1000;
  }

  /**
   * Cell values of one range, row by row (`rows[0]` is the first row of the range). Google
   * leaves out trailing blank cells and rows; the caller pads.
   *
   * UNFORMATTED_VALUE gives numbers as numbers (a percentage as its fraction, as Excel
   * stores it) and SERIAL_NUMBER gives a time as a day fraction, which the Snoonu parser
   * reads like an Excel time cell. A cell showing an error (#REF!, #N/A) arrives as its
   * error text.
   */
  async values(
    accessToken: string,
    spreadsheetId: string,
    range: string,
  ): Promise<GoogleCellValue[][]> {
    const params = new URLSearchParams({
      majorDimension: 'ROWS',
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER',
    });
    const url = `${SHEETS_URL}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?${params.toString()}`;
    const res = await this.withBackoff(() =>
      this.fetchFn(url, { headers: { Authorization: `Bearer ${accessToken}` } }),
    );
    if (!res.ok) throw await sheetsError(res);
    const body = (await res.json()) as { values?: GoogleCellValue[][] };
    return body.values ?? [];
  }

  /**
   * Retries a request Google rate-limited (429) or failed on its side (5xx), and network
   * errors, with exponential back-off: backoffMs, 2x, 4x ... or Google's Retry-After when it
   * is longer. Any other answer is returned as it is.
   */
  protected async withBackoff(send: () => Promise<Response>): Promise<Response> {
    let delay = this.#backoffMs;
    for (let attempt = 1; ; attempt += 1) {
      let res: Response | undefined;
      try {
        res = await send();
      } catch {
        if (attempt >= this.#maxTries) {
          throw new GoogleError('unavailable', 'Google could not be reached (network error).');
        }
      }
      if (res !== undefined) {
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable) return res;
        if (attempt >= this.#maxTries) {
          if (res.status === 429) {
            throw new GoogleError(
              'quota',
              'Google Sheets is refusing requests for now (quota or rate limit); the run is tried again later.',
              429,
            );
          }
          return res;
        }
        const after = Number(res.headers.get('retry-after'));
        if (Number.isFinite(after) && after * 1000 > delay) delay = after * 1000;
      }
      await this.#sleep(delay);
      delay *= 2;
    }
  }
}

export class GoogleClient extends GoogleHttp {
  readonly #config: GoogleOAuthConfig;

  constructor(config: GoogleOAuthConfig, options: GoogleClientOptions = {}) {
    super(options);
    this.#config = config;
  }

  get redirectUri(): string {
    return this.#config.redirectUri;
  }

  /**
   * The consent URL. `access_type=offline` + `prompt=consent` make Google return a refresh
   * token every time (also on a reconnect); `include_granted_scopes=false` keeps any other
   * scope the account once gave this client out of the grant.
   */
  authorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.#config.clientId,
      redirect_uri: this.#config.redirectUri,
      response_type: 'code',
      scope: GOOGLE_SHEETS_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'false',
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  /** Swaps the authorization code for a refresh token; refuses any grant that is not read-only. */
  async exchangeCode(code: string): Promise<{ refreshToken: string; scope: string }> {
    const body = await this.#token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.#config.redirectUri,
    });
    const scopes = (body.scope ?? '').split(/\s+/).filter((s) => s !== '');
    if (scopes.length !== 1 || scopes[0] !== GOOGLE_SHEETS_SCOPE) {
      // Never keep a token that can do more (or less) than read sheets.
      if (body.refresh_token !== undefined) await this.revoke(body.refresh_token);
      throw new GoogleError(
        'bad_scope',
        'Google returned a grant that is not exactly "read spreadsheets"; nothing was saved.',
      );
    }
    if (body.refresh_token === undefined) {
      throw new GoogleError(
        'no_refresh_token',
        'Google did not return a refresh token. Remove the app under Google Account > Security > Third-party access, then connect again.',
      );
    }
    return { refreshToken: body.refresh_token, scope: GOOGLE_SHEETS_SCOPE };
  }

  /** A fresh access token from the refresh token. */
  async refresh(refreshToken: string): Promise<{ accessToken: string; expiresInSeconds: number }> {
    const body = await this.#token({ grant_type: 'refresh_token', refresh_token: refreshToken });
    if (body.access_token === undefined) {
      throw new GoogleError('unavailable', 'Google gave no access token.');
    }
    return { accessToken: body.access_token, expiresInSeconds: body.expires_in ?? 3600 };
  }

  /** Revokes a token at Google. Best effort: a token Google no longer knows is already gone. */
  async revoke(token: string): Promise<boolean> {
    try {
      const res = await this.fetchFn(REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async #token(form: Record<string, string>): Promise<TokenResponse> {
    const res = await this.withBackoff(() =>
      this.fetchFn(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          ...form,
          client_id: this.#config.clientId,
          client_secret: this.#config.clientSecret,
        }).toString(),
      }),
    );
    let body: TokenResponse = {};
    try {
      body = (await res.json()) as TokenResponse;
    } catch {
      // A non-JSON answer is handled by the status below.
    }
    if (res.ok) return body;
    // Only Google's error code is used: the request held the secret and the token.
    if (body.error === 'invalid_grant') {
      throw new GoogleError(
        'invalid_grant',
        'Google refused the saved access (revoked, expired or for another client).',
        res.status,
      );
    }
    if (body.error === 'invalid_client' || body.error === 'unauthorized_client') {
      throw new GoogleError(
        'invalid_client',
        'Google refused the OAuth client id or secret; check GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.',
        res.status,
      );
    }
    throw new GoogleError(
      res.status === 429 ? 'quota' : 'unavailable',
      `Google's token service answered ${String(res.status)}${body.error === undefined ? '' : ` (${body.error})`}.`,
      res.status,
    );
  }
}

/** What a failed Sheets answer means, in words the admin can act on. */
async function sheetsError(res: Response): Promise<GoogleError> {
  let detail = { status: '', message: '' };
  try {
    const body = (await res.json()) as { error?: { status?: string; message?: string } };
    detail = { status: body.error?.status ?? '', message: body.error?.message ?? '' };
  } catch {
    // Keep the defaults.
  }
  if (res.status === 401) {
    return new GoogleError('unauthorized', 'Google refused the access token.', 401);
  }
  if (res.status === 403) {
    // A project without the Sheets API enabled also answers 403, with its own wording.
    if (/has not been used|is disabled|SERVICE_DISABLED/i.test(detail.message)) {
      return new GoogleError(
        'api_disabled',
        'The Google Sheets API is not enabled in the Google Cloud project (see docs/GOOGLE_SETUP.md, "Enable the Google Sheets API").',
        403,
      );
    }
    return new GoogleError(
      'not_shared',
      'The spreadsheet is not shared with the connected Google account.',
      403,
    );
  }
  if (res.status === 404) {
    return new GoogleError(
      'not_found',
      'No spreadsheet with this id, or it is not shared with the connected Google account.',
      404,
    );
  }
  if (res.status === 400 && /Unable to parse range/i.test(detail.message)) {
    return new GoogleError('bad_range', 'The spreadsheet has no tab with this name.', 400);
  }
  return new GoogleError(
    'unavailable',
    `Google Sheets answered ${String(res.status)}${detail.status === '' ? '' : ` (${detail.status})`}.`,
    res.status,
  );
}
