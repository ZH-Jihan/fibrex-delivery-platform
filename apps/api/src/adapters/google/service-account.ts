/**
 * Google service-account sign-in for the read-only Sheets reader (phase 4 row 4.4b; SPEC 2.11).
 *
 * Purpose: the recommended way to read Snoonu's report. The owner keeps a mirror Google
 * Sheet (`=IMPORTRANGE` of Snoonu's Daily Report) and shares it as Viewer with a Google
 * service account. The app signs in as that service account with its JSON key, so no
 * person's consent is involved, and nothing expires every 7 days as an unpublished OAuth
 * app's grant does (DECISIONS 4.4b).
 *
 * How it signs in (Google's "OAuth 2.0 for server to server applications"):
 *   1. Build a JWT: header { alg: RS256, typ: JWT, kid: private_key_id }, claims
 *      { iss: client_email, scope: spreadsheets.readonly, aud: token_uri, iat, exp = iat + 1h }.
 *   2. Sign `base64url(header).base64url(claims)` with the key's RSA private key (SHA-256),
 *      using Node's crypto; no extra library.
 *   3. POST it to the key's `token_uri` as grant_type
 *      `urn:ietf:params:oauth:grant-type:jwt-bearer`; Google answers with an access token
 *      that lives about an hour.
 *   4. Keep that token in memory and reuse it until one minute before it expires; then sign
 *      a new JWT. Calls that arrive while a token is being fetched wait for the same one.
 *
 * Secrets, and why each rule exists:
 *   - The key is read from the file named by GOOGLE_SERVICE_ACCOUNT_KEY_FILE (kept outside
 *     the repository) or from GOOGLE_SERVICE_ACCOUNT_KEY_JSON. It is never written to the
 *     database, never logged, never returned by an API.
 *   - The private key is turned into a `KeyObject` at once and the PEM text is not kept.
 *     Only `client_email` (which the owner must see to share the sheet) leaves this file.
 *   - Error messages never quote the key: a JSON parse error is replaced by a fixed
 *     sentence, because the parser's own message can include part of the text it read.
 *     Token errors carry Google's error code only.
 *   - Only the scope `spreadsheets.readonly` is ever asked for, so the token cannot write.
 *
 * Depends on: node:crypto, node:fs, ./google-client.ts (GoogleHttp, GoogleError).
 * Used by: modules/performance/google-connection.ts, src/main.ts, the Google tests.
 */
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  GOOGLE_SHEETS_SCOPE,
  GoogleError,
  GoogleHttp,
  type GoogleClientOptions,
} from './google-client.js';

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
/** A signed assertion is valid for one hour, the most Google accepts. */
const ASSERTION_SECONDS = 3600;
/** Access tokens are renewed a minute before Google says they expire. */
const TOKEN_MARGIN_MS = 60_000;

/** The parts of a service account key the app uses. The PEM text itself is not kept. */
export interface ServiceAccountKey {
  clientEmail: string;
  privateKeyId: string | null;
  tokenUri: string;
  privateKey: KeyObject;
}

const KEY_HELP = 'See docs/GOOGLE_SETUP.md, "Create the service account key".';

/**
 * Reads a key from the JSON Google downloads ("Keys > Add key > JSON"). Refuses anything
 * that is not a service account key with an RSA private key and an https token endpoint.
 */
export function parseServiceAccountKey(json: string): ServiceAccountKey {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    // Not the parser's message: it can quote the text, which is the private key.
    throw new GoogleError('invalid_key', `The service account key is not valid JSON. ${KEY_HELP}`);
  }
  const key = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  if (key.type !== 'service_account') {
    throw new GoogleError(
      'invalid_key',
      `The key is not a service account key (its "type" must be "service_account"). ${KEY_HELP}`,
    );
  }
  const clientEmail = key.client_email;
  if (typeof clientEmail !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(clientEmail)) {
    throw new GoogleError('invalid_key', `The key has no "client_email". ${KEY_HELP}`);
  }
  const tokenUri = typeof key.token_uri === 'string' ? key.token_uri : DEFAULT_TOKEN_URI;
  let tokenUrl: URL;
  try {
    tokenUrl = new URL(tokenUri);
  } catch {
    throw new GoogleError('invalid_key', `The key's "token_uri" is not a URL. ${KEY_HELP}`);
  }
  // The signed assertion is a credential for an hour: never send it over plain http.
  if (tokenUrl.protocol !== 'https:') {
    throw new GoogleError('invalid_key', `The key's "token_uri" must use https. ${KEY_HELP}`);
  }
  let privateKey: KeyObject;
  try {
    if (typeof key.private_key !== 'string') throw new Error('missing');
    privateKey = createPrivateKey({ key: key.private_key, format: 'pem' });
  } catch {
    throw new GoogleError(
      'invalid_key',
      `The key's "private_key" is missing or cannot be read. ${KEY_HELP}`,
    );
  }
  if (privateKey.asymmetricKeyType !== 'rsa') {
    throw new GoogleError('invalid_key', `The key's "private_key" is not an RSA key. ${KEY_HELP}`);
  }
  return {
    clientEmail,
    privateKeyId: typeof key.private_key_id === 'string' ? key.private_key_id : null,
    tokenUri: tokenUrl.href,
    privateKey,
  };
}

/**
 * The key from the environment: the file GOOGLE_SERVICE_ACCOUNT_KEY_FILE names, else the
 * JSON in GOOGLE_SERVICE_ACCOUNT_KEY_JSON; null when neither is set. A file that cannot be
 * read is reported by its path only (the path is not a secret; its contents are).
 */
export function loadServiceAccountKey(
  source: { file?: string | undefined; json?: string | undefined },
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): ServiceAccountKey | null {
  if (source.file !== undefined) {
    let text: string;
    try {
      text = readFile(source.file);
    } catch {
      throw new GoogleError(
        'invalid_key',
        `The service account key file "${source.file}" (GOOGLE_SERVICE_ACCOUNT_KEY_FILE) cannot be read. ${KEY_HELP}`,
      );
    }
    return parseServiceAccountKey(text);
  }
  if (source.json !== undefined) return parseServiceAccountKey(source.json);
  return null;
}

const b64url = (data: string | Buffer) =>
  (typeof data === 'string' ? Buffer.from(data, 'utf8') : data).toString('base64url');

export interface ServiceAccountClientOptions extends GoogleClientOptions {
  /** Clock in ms; tests move it to check the token cache. */
  now?: () => number;
}

interface TokenAnswer {
  access_token?: string;
  expires_in?: number;
  error?: string;
}

export class ServiceAccountClient extends GoogleHttp {
  readonly #key: ServiceAccountKey;
  readonly #now: () => number;
  #cached: { token: string; expiresAt: number } | null = null;
  #inFlight: Promise<string> | null = null;

  constructor(key: ServiceAccountKey, options: ServiceAccountClientOptions = {}) {
    super(options);
    this.#key = key;
    this.#now = options.now ?? Date.now;
  }

  /** The address the owner shares the sheet with (Viewer). Not a secret. */
  get email(): string {
    return this.#key.clientEmail;
  }

  /** Step 1 and 2: a signed JWT asking for read-only access, valid one hour from `nowMs`. */
  signedAssertion(nowMs: number = this.#now()): string {
    const iat = Math.floor(nowMs / 1000);
    const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' };
    if (this.#key.privateKeyId !== null) header.kid = this.#key.privateKeyId;
    const claims = {
      iss: this.#key.clientEmail,
      scope: GOOGLE_SHEETS_SCOPE,
      aud: this.#key.tokenUri,
      iat,
      exp: iat + ASSERTION_SECONDS,
    };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    // RS256 = RSASSA-PKCS1-v1_5 with SHA-256, Node's default padding for an RSA key.
    const signature = sign('sha256', Buffer.from(signingInput, 'utf8'), this.#key.privateKey);
    return `${signingInput}.${b64url(signature)}`;
  }

  /** Step 4: the cached token while it has more than a minute left, else a new one. */
  async accessToken(): Promise<string> {
    const cached = this.#cached;
    if (cached !== null && cached.expiresAt - TOKEN_MARGIN_MS > this.#now()) return cached.token;
    // One fetch at a time: parallel reads (a header test during a run) share it.
    this.#inFlight ??= this.#fetchToken().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  /** Drops the cached token (Google refused it with 401), so the next read signs again. */
  forgetToken(): void {
    this.#cached = null;
  }

  async #fetchToken(): Promise<string> {
    const issuedAt = this.#now();
    const res = await this.withBackoff(() =>
      this.fetchFn(this.#key.tokenUri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: JWT_BEARER,
          assertion: this.signedAssertion(issuedAt),
        }).toString(),
      }),
    );
    let body: TokenAnswer = {};
    try {
      body = (await res.json()) as TokenAnswer;
    } catch {
      // A non-JSON answer is handled by the status below.
    }
    if (res.ok && typeof body.access_token === 'string') {
      const lifetime = typeof body.expires_in === 'number' ? body.expires_in : 3600;
      this.#cached = { token: body.access_token, expiresAt: issuedAt + lifetime * 1000 };
      return body.access_token;
    }
    // Only Google's error code is used: the request held the signed assertion.
    if (body.error === 'invalid_grant' || body.error === 'invalid_client') {
      // invalid_grant: the key was deleted or disabled, the account was removed, or this
      // server's clock is far off (the JWT's iat/exp are then refused). invalid_client: the
      // service account itself no longer exists.
      throw new GoogleError(
        'invalid_grant',
        `Google refused the service account key for ${this.#key.clientEmail} (${body.error}): the key was deleted or disabled, the service account was removed, or this server's clock is wrong.`,
        res.status,
      );
    }
    if (res.status === 429) {
      throw new GoogleError(
        'quota',
        'Google is refusing token requests for now (rate limit); the run is tried again later.',
        429,
      );
    }
    throw new GoogleError(
      'unavailable',
      `Google's token service answered ${String(res.status)}${body.error === undefined ? '' : ` (${body.error})`}.`,
      res.status,
    );
  }
}
