/**
 * Google connection and the read-only Google Sheets reader (phase 4 row 4.4; SPEC 3.1).
 *
 * Purpose: the owner's Google account (the one Snoonu shared the Daily Report with) gives
 * read-only consent once; the sync engine then reads the sheet every morning without anyone
 * signing in. This file holds both halves:
 *
 *   - `GoogleConnectionService`: the consent flow (start, callback, disconnect), the status
 *     the settings screen shows, and short-lived access tokens for the reader.
 *   - `GoogleSheetsProvider`: the `ReportSourceProvider` for `sheet` sources. It reads the
 *     source's spreadsheet id and tab and returns the same `SheetGrid` an uploaded Excel file
 *     gives, so the Snoonu parser cannot tell them apart.
 *
 * Where the grant lives: one `integration.adapter_config` row per tenant (kind
 * `client_report`, provider `google_sheets`). Its `settings_encrypted` is a JSON document
 * sealed with the SecretBox (AES-256-GCM, context bound to the tenant): the refresh token,
 * when and by whom it was connected, the last problem, and a pending consent. Rules, and why:
 *
 *   1. The refresh token is never returned by any API, never logged, and never in an error
 *      message. The audit trigger shows `settings_encrypted` as "[redacted]".
 *   2. Consent uses a one-time `state`: 32 random bytes, only its SHA-256 stored, for the
 *      user who started it, valid 10 minutes. A callback with any other state is refused
 *      (cross-site request forgery: someone else's code must never be attached to our
 *      tenant). It is cleared when used.
 *   3. Google's HTTP calls happen outside database transactions, so a slow Google answer
 *      never holds a database connection.
 *   4. A refused grant (`invalid_grant`: revoked by the account, or expired because the
 *      consent screen was left in "Testing") is written onto the connection as a problem.
 *      Runs then fail at once, without asking Google again, with a message telling an admin
 *      to reconnect and that the day's Excel upload is the fallback; the sync engine alerts
 *      admins (`performance.sync_problem`). Reconnecting clears it.
 *   5. A sheet showing an error or "Loading..." where the data should be (Snoonu's tab is an
 *      IMPORTRANGE, which shows #REF! or Loading... when the link breaks or is slow) is
 *      unreadable, never "no figures": reading it as blanks would look like a day nobody
 *      worked. The run fails and is retried.
 *
 * Depends on: adapters/google/google-client.ts, kernel/crypto/secret-box.ts, kernel/db,
 * kernel/http/errors.ts, ./report-adapter.ts, ./source-providers.ts. Used by:
 * ./google-router.ts, ./sync-source-router.ts, src/main.ts, the Google tests.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  GoogleError,
  type GoogleCellValue,
  type GoogleClient,
} from '../../adapters/google/google-client.js';
import type { SecretBox } from '../../kernel/crypto/secret-box.js';
import type { Db } from '../../kernel/db/prisma.js';
import { currentUnit, type DbContext, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { BadRequestError, ConflictError } from '../../kernel/http/errors.js';
import {
  ReportSourceError,
  type ReportSource,
  type SheetCell,
  type SheetGrid,
} from './report-adapter.js';
import type { ReportSourceProvider, SourceOpenRequest } from './source-providers.js';

export const GOOGLE_ADAPTER_KIND = 'client_report';
export const GOOGLE_PROVIDER = 'google_sheets';
const STATE_TTL_MS = 10 * 60_000;
/** Access tokens are renewed a minute before Google says they expire. */
const TOKEN_MARGIN_MS = 60_000;

/** Shown wherever a run cannot use Google, so the admin knows the way round it. */
const FALLBACK = "Until then, upload the day's Excel file (Sync sources > Upload a day's Excel).";
const RECONNECT_MESSAGE = `Google access for reading the sheet was revoked or has expired. An admin must reconnect Google under Settings > Google connection. ${FALLBACK}`;
const NOT_CONNECTED_MESSAGE = `No Google account is connected for reading sheets. An admin must connect one under Settings > Google connection. ${FALLBACK}`;

/** The sealed settings document. */
interface GoogleSettings {
  refreshToken?: string;
  scope?: string;
  connectedAt?: string;
  connectedBy?: string | null;
  problem?: { code: string; message: string; at: string } | null;
  pending?: { stateHash: string; userId: string; expiresAt: string } | null;
}

export type GoogleConnectionState =
  'not_configured' | 'not_connected' | 'connected' | 'reconnect_needed';

/** What the settings screen sees. Never holds a token. */
export interface GoogleConnectionStatus {
  state: GoogleConnectionState;
  /** False when the server has no OAuth client id and secret (see docs/GOOGLE_SETUP.md). */
  configured: boolean;
  redirectUri: string | null;
  scope: string | null;
  connectedAt: string | null;
  connectedBy: string | null;
  connectedByName: string | null;
  problem: { code: string; message: string; at: string } | null;
}

export interface GoogleConnectionDeps {
  uow: UnitOfWork;
  box: SecretBox;
  /** Null when GOOGLE_OAUTH_CLIENT_ID / SECRET are not set: connecting is then refused. */
  client: GoogleClient | null;
  now?: () => Date;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest();
const secretContext = (tenantId: string) =>
  `integration.adapter_config:${GOOGLE_PROVIDER}:${tenantId}`;

/** A tab name as an A1 range: quoted, with quotes inside doubled ('Daily Report'!3:3). */
export function a1Range(tab: string, rows?: string): string {
  const quoted = `'${tab.replace(/'/g, "''")}'`;
  return rows === undefined ? quoted : `${quoted}!${rows}`;
}

export class GoogleConnectionService {
  readonly #deps: GoogleConnectionDeps;
  /** Access tokens in memory only, per tenant; the key includes the row version. */
  readonly #tokens = new Map<string, { key: string; token: string; expiresAt: number }>();

  constructor(deps: GoogleConnectionDeps) {
    this.#deps = deps;
  }

  #now(): Date {
    return this.#deps.now?.() ?? new Date();
  }

  // -------------------------------------------------------------------------------------
  // Settings row (call inside a unit of work)
  // -------------------------------------------------------------------------------------

  async #load(db: Db): Promise<{ id: string; version: number; settings: GoogleSettings } | null> {
    const { context } = currentUnit();
    const row = await db.adapterConfig.findFirst({
      where: { adapterKind: GOOGLE_ADAPTER_KIND, provider: GOOGLE_PROVIDER, deletedAt: null },
      select: { id: true, version: true, settingsEncrypted: true },
    });
    if (row === null) return null;
    let settings: GoogleSettings = {};
    if (row.settingsEncrypted !== null) {
      const opened = this.#deps.box.open(
        Buffer.from(row.settingsEncrypted, 'base64'),
        secretContext(context.tenantId),
      );
      settings = JSON.parse(opened.toString('utf8')) as GoogleSettings;
    }
    return { id: row.id, version: row.version, settings };
  }

  async #save(db: Db, settings: GoogleSettings | null, active: boolean): Promise<void> {
    const { context } = currentUnit();
    const sealed =
      settings === null
        ? null
        : this.#deps.box
            .seal(Buffer.from(JSON.stringify(settings), 'utf8'), secretContext(context.tenantId))
            .toString('base64');
    const existing = await db.adapterConfig.findFirst({
      where: { adapterKind: GOOGLE_ADAPTER_KIND, provider: GOOGLE_PROVIDER, deletedAt: null },
      select: { id: true },
    });
    if (existing === null) {
      await db.adapterConfig.create({
        data: {
          tenantId: context.tenantId,
          adapterKind: GOOGLE_ADAPTER_KIND,
          provider: GOOGLE_PROVIDER,
          settingsEncrypted: sealed,
          active,
        },
      });
    } else {
      await db.adapterConfig.update({
        where: { id: existing.id },
        data: { settingsEncrypted: sealed, active },
      });
    }
    this.#tokens.delete(context.tenantId);
  }

  // -------------------------------------------------------------------------------------
  // Settings screen (call inside a unit of work, after the permission check)
  // -------------------------------------------------------------------------------------

  async status(): Promise<GoogleConnectionStatus> {
    const { db } = currentUnit();
    const row = await this.#load(db);
    const s = row?.settings ?? {};
    const connected = s.refreshToken !== undefined;
    let connectedByName: string | null = null;
    if (connected && typeof s.connectedBy === 'string') {
      const user = await db.userAccount.findFirst({
        where: { id: s.connectedBy },
        select: { displayName: true },
      });
      connectedByName = user?.displayName ?? null;
    }
    const configured = this.#deps.client !== null;
    let state: GoogleConnectionState = 'not_connected';
    if (connected) state = s.problem == null ? 'connected' : 'reconnect_needed';
    else if (!configured) state = 'not_configured';
    return {
      state,
      configured,
      redirectUri: this.#deps.client?.redirectUri ?? null,
      scope: connected ? (s.scope ?? null) : null,
      connectedAt: connected ? (s.connectedAt ?? null) : null,
      connectedBy: connected ? (s.connectedBy ?? null) : null,
      connectedByName,
      problem: s.problem ?? null,
    };
  }

  /** Starts consent: stores a one-time state for this user and returns Google's URL. */
  async start(): Promise<{ authorizationUrl: string }> {
    const client = this.#requireClient();
    const { db, context } = currentUnit();
    if (context.userId === undefined)
      throw new BadRequestError('google_needs_user', 'Only a signed-in user can connect Google.');
    const state = randomBytes(32).toString('base64url');
    const row = await this.#load(db);
    await this.#save(
      db,
      {
        ...(row?.settings ?? {}),
        pending: {
          stateHash: sha256(state).toString('hex'),
          userId: context.userId,
          expiresAt: new Date(this.#now().getTime() + STATE_TTL_MS).toISOString(),
        },
      },
      row?.settings.refreshToken !== undefined && row.settings.problem == null,
    );
    return { authorizationUrl: client.authorizationUrl(state) };
  }

  /**
   * Step 1 of the callback (inside a unit of work): the state must be the one this user was
   * given, unexpired. Returns the hash to confirm again when saving.
   */
  async checkState(state: string): Promise<string> {
    this.#requireClient();
    const { db, context } = currentUnit();
    const pending = (await this.#load(db))?.settings.pending ?? null;
    const given = sha256(state);
    const ok =
      pending != null &&
      pending.userId === context.userId &&
      new Date(pending.expiresAt).getTime() > this.#now().getTime() &&
      timingSafeEqual(Buffer.from(pending.stateHash, 'hex'), given);
    if (!ok) {
      throw new BadRequestError(
        'google_bad_state',
        'This Google sign-in does not match a connection you started in the last 10 minutes. Start again from Settings > Google connection.',
      );
    }
    return pending.stateHash;
  }

  /** Step 2 (no transaction): swap the code for a refresh token at Google. */
  async exchange(code: string): Promise<{ refreshToken: string; scope: string }> {
    const client = this.#requireClient();
    try {
      return await client.exchangeCode(code);
    } catch (err) {
      if (err instanceof GoogleError) {
        throw new BadRequestError('google_consent_failed', err.message);
      }
      throw err;
    }
  }

  /**
   * Step 3 (inside a unit of work): save the grant, once. The pending state must still be
   * the one checked in step 1, so the same callback cannot be used twice. Returns the
   * refresh token it replaced, for the caller to revoke at Google after the commit.
   */
  async saveGrant(
    stateHash: string,
    grant: { refreshToken: string; scope: string },
  ): Promise<string | null> {
    const { db, context } = currentUnit();
    const row = await this.#load(db);
    if (row?.settings.pending?.stateHash !== stateHash) {
      throw new ConflictError('google_state_used', 'This Google sign-in was already used.');
    }
    const replaced = row.settings.refreshToken ?? null;
    await this.#save(
      db,
      {
        refreshToken: grant.refreshToken,
        scope: grant.scope,
        connectedAt: this.#now().toISOString(),
        connectedBy: context.userId ?? null,
        problem: null,
        pending: null,
      },
      true,
    );
    return replaced === grant.refreshToken ? null : replaced;
  }

  /** Forgets the grant (inside a unit of work). Returns the token to revoke after commit. */
  async disconnect(): Promise<string | null> {
    const { db } = currentUnit();
    const row = await this.#load(db);
    if (row === null) return null;
    await this.#save(db, null, false);
    return row.settings.refreshToken ?? null;
  }

  /** Best-effort revoke at Google (outside any transaction). */
  async revoke(token: string | null): Promise<void> {
    if (token !== null && this.#deps.client !== null) await this.#deps.client.revoke(token);
  }

  #requireClient(): GoogleClient {
    if (this.#deps.client === null) {
      throw new ConflictError(
        'google_not_configured',
        'Google sign-in is not set up on the server: GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are missing (see docs/GOOGLE_SETUP.md).',
      );
    }
    return this.#deps.client;
  }

  // -------------------------------------------------------------------------------------
  // Reading (no transaction open; settings are read in short units of work)
  // -------------------------------------------------------------------------------------

  /** An access token for the tenant, from memory or refreshed from the sealed grant. */
  async #accessToken(context: DbContext): Promise<string> {
    const { uow } = this.#deps;
    const row = await uow.runAs(context, (db) => this.#load(db));
    const s = row?.settings;
    if (this.#deps.client === null || row === null || s?.refreshToken === undefined) {
      throw new ReportSourceError('not_connected', NOT_CONNECTED_MESSAGE, false);
    }
    // Rule 4: a grant Google already refused is not tried again until someone reconnects.
    if (s.problem != null) throw new ReportSourceError('access_revoked', RECONNECT_MESSAGE, false);

    const key = `${row.id}:${String(row.version)}`;
    const cached = this.#tokens.get(context.tenantId);
    if (cached?.key === key && cached.expiresAt - TOKEN_MARGIN_MS > Date.now()) return cached.token;

    try {
      const fresh = await this.#deps.client.refresh(s.refreshToken);
      this.#tokens.set(context.tenantId, {
        key,
        token: fresh.accessToken,
        expiresAt: Date.now() + fresh.expiresInSeconds * 1000,
      });
      return fresh.accessToken;
    } catch (err) {
      if (err instanceof GoogleError && err.code === 'invalid_grant') {
        await this.#markRevoked(context);
        throw new ReportSourceError('access_revoked', RECONNECT_MESSAGE, false);
      }
      if (err instanceof GoogleError && err.code === 'invalid_client') {
        throw new ReportSourceError('not_connected', `${err.message} ${FALLBACK}`, false);
      }
      throw toSourceError(err);
    }
  }

  /** Writes the refused grant onto the connection (rule 4). */
  async #markRevoked(context: DbContext): Promise<void> {
    this.#tokens.delete(context.tenantId);
    await this.#deps.uow.runAs(context, async (db) => {
      const row = await this.#load(db);
      if (row?.settings.refreshToken === undefined) return;
      await this.#save(
        db,
        {
          ...row.settings,
          problem: {
            code: 'invalid_grant',
            message: 'Google refused the saved access. Reconnect Google.',
            at: this.#now().toISOString(),
          },
        },
        false,
      );
    });
  }

  /** Values of a range; a refused access token is renewed once. */
  async #values(
    context: DbContext,
    spreadsheetId: string,
    range: string,
  ): Promise<GoogleCellValue[][]> {
    const client = this.#deps.client;
    if (client === null) throw new ReportSourceError('not_connected', NOT_CONNECTED_MESSAGE, false);
    for (let attempt = 1; ; attempt += 1) {
      const token = await this.#accessToken(context);
      try {
        return await client.values(token, spreadsheetId, range);
      } catch (err) {
        if (err instanceof GoogleError && err.code === 'unauthorized' && attempt === 1) {
          this.#tokens.delete(context.tenantId);
          continue;
        }
        throw toSourceError(err);
      }
    }
  }

  /** The whole tab as a grid, refused when it shows errors or "Loading..." (rule 5). */
  async readTab(context: DbContext, spreadsheetId: string, tab: string): Promise<SheetGrid> {
    const grid = toGrid(tab, await this.#values(context, spreadsheetId, a1Range(tab)));
    assertReadable(grid, 0);
    return grid;
  }

  /** "Test headers": only the header row (row 3 for Snoonu) of the tab, as text. */
  async readHeaders(
    context: DbContext,
    spreadsheetId: string,
    tab: string,
    headerRow: number,
  ): Promise<string[]> {
    const row = String(headerRow);
    const values = await this.#values(context, spreadsheetId, a1Range(tab, `${row}:${row}`));
    const grid = toGrid(tab, values);
    assertReadable(grid, headerRow - 1);
    return (grid.rows[0] ?? []).map((cell) => (cell === null ? '' : String(cell).trim()));
  }
}

/** A Google failure as the source error the sync engine understands. */
function toSourceError(err: unknown): Error {
  if (err instanceof ReportSourceError) return err;
  if (!(err instanceof GoogleError)) return err instanceof Error ? err : new Error(String(err));
  switch (err.code) {
    case 'not_shared':
    case 'not_found':
      return new ReportSourceError(
        'not_shared',
        `${err.message} Ask Snoonu to share it with the connected account (viewer is enough), or check the spreadsheet id. ${FALLBACK}`,
        false,
      );
    case 'api_disabled':
      return new ReportSourceError('api_disabled', `${err.message} ${FALLBACK}`, false);
    case 'quota':
      return new ReportSourceError('quota_exceeded', err.message, true);
    case 'bad_range':
      return new ReportSourceError('missing_tab', err.message, false);
    default:
      // Network or Google server trouble: worth trying again later.
      return new ReportSourceError(
        'sheet_unreadable',
        `Google Sheets could not be read: ${err.message}`,
        true,
      );
  }
}

/**
 * Google's rows as the same grid an Excel upload gives: "" is a blank cell (null), every row
 * padded to the widest row, numbers and booleans kept as they are.
 */
export function toGrid(tab: string, values: readonly (readonly GoogleCellValue[])[]): SheetGrid {
  const width = values.reduce((w, row) => Math.max(w, row.length), 0);
  const rows: SheetCell[][] = values.map((row) => {
    const cells: SheetCell[] = [];
    for (let c = 0; c < width; c += 1) {
      const v = row[c];
      cells.push(v === undefined || v === '' ? null : v);
    }
    return cells;
  });
  return { tab, rows };
}

/** Spreadsheet error values as Google shows them. */
const ERROR_TEXT = /^#(REF!|N\/A|ERROR!|VALUE!|NAME\?|DIV\/0!|NUM!|NULL!|SPILL!|CALC!)$/i;
/** IMPORTRANGE's text while it is still fetching the other workbook. */
const LOADING_TEXT = /^loading(\.\.\.|…)?$/i;

/**
 * Rule 5. A whole-tab IMPORTRANGE puts its error or loading text in its own cell (A1 for
 * Snoonu) and leaves the rest blank, so an error anywhere in the top rows, or loading text
 * anywhere, means the data is not there. An error inside one person's figures further down
 * stays for the parser, which reports that row and keeps the rest.
 *
 * `firstRowNo` is the 0-based sheet row of `grid.rows[0]`.
 */
export function assertReadable(grid: SheetGrid, firstRowNo: number): void {
  const TOP_ROWS = 3;
  grid.rows.forEach((row, i) => {
    row.forEach((cell, c) => {
      if (typeof cell !== 'string') return;
      const text = cell.trim();
      const loading = LOADING_TEXT.test(text);
      if (loading || (ERROR_TEXT.test(text) && firstRowNo + i < TOP_ROWS)) {
        const at = `${columnLetter(c)}${String(firstRowNo + i + 1)}`;
        throw new ReportSourceError(
          'sheet_unreadable',
          loading
            ? `The "${grid.tab}" tab is still loading its data (cell ${at} shows "${text}"). The run is tried again later.`
            : `The "${grid.tab}" tab shows ${text} in cell ${at} instead of data: its IMPORTRANGE link to Snoonu's master sheet is broken or not allowed. The run is tried again later; if it keeps failing, ask Snoonu to check the sheet. ${FALLBACK}`,
          true,
        );
      }
    });
  });
  // Nothing at all: treated by the engine as an empty sheet (it alerts admins).
}

function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** The reader the sync engine uses for `sheet` sources. */
export class GoogleSheetsProvider implements ReportSourceProvider {
  readonly adapterKind = 'sheet';
  readonly #google: GoogleConnectionService;

  constructor(google: GoogleConnectionService) {
    this.#google = google;
  }

  open(request: SourceOpenRequest): ReportSource {
    const spreadsheetId = request.config?.spreadsheetId;
    return {
      read: (tab) => {
        if (typeof spreadsheetId !== 'string' || spreadsheetId === '') {
          return Promise.reject(
            new ReportSourceError(
              'not_connected',
              `This sync source has no spreadsheet id; set it under Sync sources. ${FALLBACK}`,
              false,
            ),
          );
        }
        return this.#google.readTab(request.context, spreadsheetId, tab);
      },
    };
  }
}
