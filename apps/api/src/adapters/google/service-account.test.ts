/**
 * Row 4.4b: service-account sign-in for the Google reader, against fake Google answers (no
 * network). The key is a throwaway RSA key generated for each run; the service account
 * email is invented.
 *
 * Checked: the key file is read, checked and never quoted in an error; the JWT has the
 * RS256 header and the claims Google needs (iss, read-only scope only, aud = the key's
 * token_uri, one hour), and its signature verifies with the key's public half; the access
 * token is cached until a minute before it expires and parallel reads share one request;
 * through the connection service: 401 re-signs once, invalid_grant is not retried and says
 * to replace the key, 403 and 404 name the service account email to share the sheet with,
 * 429 is retried later, an IMPORTRANGE error is unreadable, a missing or broken key says so.
 */
import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { FAKE_SCOPE, FakeGoogle, JWT_BEARER } from '../../../test/fixtures/fake-google.js';
import { GoogleConnectionService } from '../../modules/performance/google-connection.js';
import { ReportSourceError } from '../../modules/performance/report-adapter.js';
import type { DbContext } from '../../kernel/db/unit-of-work.js';
import type { UnitOfWork } from '../../kernel/db/unit-of-work.js';
import type { SecretBox } from '../../kernel/crypto/secret-box.js';
import { GoogleError } from './google-client.js';
import {
  loadServiceAccountKey,
  parseServiceAccountKey,
  ServiceAccountClient,
} from './service-account.js';

const EMAIL = 'fake-reader@fake-project-123.iam.gserviceaccount.com';
const KEY_ID = 'fake-key-id-0001';
const SHEET_ID = 'FakeMirrorSheetId_0123456789abcdefABCDEF';
const CONTEXT = { tenantId: 'tenant-a', companyIds: [], userId: 'u' } as unknown as DbContext;

let pem = '';
let publicKey: KeyObject;
/** The secret part of the PEM, to look for in anything that must never contain it. */
let pemBody = '';

function keyJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'fake-project-123',
    private_key_id: KEY_ID,
    private_key: pem,
    client_email: EMAIL,
    client_id: '000000000000000000000',
    token_uri: 'https://oauth2.googleapis.com/token',
    ...over,
  });
}

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function setup(now = { ms: Date.UTC(2026, 10, 21, 1, 0, 0) }) {
  const fake = new FakeGoogle();
  const sa = new ServiceAccountClient(parseServiceAccountKey(keyJson()), {
    fetch: fake.fetch,
    maxTries: 2,
    backoffMs: 1,
    sleep: () => Promise.resolve(),
    now: () => now.ms,
  });
  // The service-account path never opens the database or the secret box.
  const connection = new GoogleConnectionService({
    uow: null as unknown as UnitOfWork,
    box: null as unknown as SecretBox,
    client: null,
    serviceAccount: sa,
  });
  const tokenCalls = () => fake.callsTo('oauth2.googleapis.com', '/token');
  return { fake, sa, connection, now, tokenCalls };
}

async function sourceError(promise: Promise<unknown>): Promise<ReportSourceError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ReportSourceError) return err;
    throw err;
  }
  throw new Error('expected a ReportSourceError');
}

beforeAll(() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  publicKey = pair.publicKey;
  pemBody = pem.split('\n')[5] ?? '';
  expect(pemBody.length).toBeGreaterThan(40);
});

describe('service account key (row 4.4b)', () => {
  it('reads the fields it needs and keeps only the email in sight', () => {
    const key = parseServiceAccountKey(keyJson());
    expect(key.clientEmail).toBe(EMAIL);
    expect(key.privateKeyId).toBe(KEY_ID);
    expect(key.tokenUri).toBe('https://oauth2.googleapis.com/token');
    expect(key.privateKey.asymmetricKeyType).toBe('rsa');
    expect(new ServiceAccountClient(key).email).toBe(EMAIL);
    expect(JSON.stringify(key)).not.toContain(pemBody);
  });

  it('refuses a broken key without ever quoting it', () => {
    const cases: [string, RegExp][] = [
      [keyJson().slice(0, -5), /not valid JSON/],
      [keyJson({ type: 'authorized_user' }), /not a service account key/],
      [keyJson({ client_email: undefined }), /no "client_email"/],
      [keyJson({ token_uri: 'http://oauth2.googleapis.com/token' }), /must use https/],
      [keyJson({ private_key: pem.replace(pemBody, 'garbage') }), /cannot be read/],
      [
        keyJson({
          private_key: generateKeyPairSync('ec', { namedCurve: 'P-256' })
            .privateKey.export({ type: 'pkcs8', format: 'pem' })
            .toString(),
        }),
        /not an RSA key/,
      ],
    ];
    for (const [text, message] of cases) {
      let caught: unknown;
      try {
        parseServiceAccountKey(text);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(GoogleError);
      const err = caught as GoogleError;
      expect(err.code).toBe('invalid_key');
      expect(err.message).toMatch(message);
      expect(err.message).not.toContain(pemBody);
      expect(err.message).not.toContain('BEGIN PRIVATE KEY');
    }
  });

  it('loads from the file first, then the JSON variable; an unreadable file is named by path only', () => {
    const files: Record<string, string> = { '/secrets/key.json': keyJson() };
    const read = (path: string) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return text;
    };
    expect(loadServiceAccountKey({}, read)).toBeNull();
    expect(loadServiceAccountKey({ json: keyJson() }, read)?.clientEmail).toBe(EMAIL);
    expect(
      loadServiceAccountKey(
        {
          file: '/secrets/key.json',
          json: keyJson({ client_email: 'other@x.iam.gserviceaccount.com' }),
        },
        read,
      )?.clientEmail,
    ).toBe(EMAIL);
    expect(() => loadServiceAccountKey({ file: '/secrets/missing.json' }, read)).toThrow(
      /"\/secrets\/missing.json" \(GOOGLE_SERVICE_ACCOUNT_KEY_FILE\) cannot be read/,
    );
  });
});

describe('service account JWT and token (row 4.4b)', () => {
  it('signs an RS256 JWT for read-only access that the public key verifies', () => {
    const { sa } = setup();
    const nowMs = Date.UTC(2026, 10, 21, 1, 0, 0);
    const jwt = sa.signedAssertion(nowMs);
    const [h = '', c = '', sig = ''] = jwt.split('.');
    expect(decode(h)).toEqual({ alg: 'RS256', typ: 'JWT', kid: KEY_ID });
    const iat = Math.floor(nowMs / 1000);
    expect(decode(c)).toEqual({
      iss: EMAIL,
      scope: FAKE_SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat,
      exp: iat + 3600,
    });
    expect(
      verify('sha256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig, 'base64url')),
    ).toBe(true);
    // A changed claim no longer verifies.
    const forged = Buffer.from(JSON.stringify({ ...decode(c), scope: 'x' })).toString('base64url');
    expect(
      verify('sha256', Buffer.from(`${h}.${forged}`), publicKey, Buffer.from(sig, 'base64url')),
    ).toBe(false);
  });

  it('posts the assertion as a jwt-bearer grant, never the key', async () => {
    const { fake, sa, tokenCalls } = setup();
    fake.token[JWT_BEARER].push(FakeGoogle.access('sa-access-1'));
    expect(await sa.accessToken()).toBe('sa-access-1');
    const [call] = tokenCalls();
    expect(call?.method).toBe('POST');
    expect(call?.form?.get('grant_type')).toBe(JWT_BEARER);
    const [h = '', c = '', sig = ''] = (call?.form?.get('assertion') ?? '').split('.');
    expect(
      verify('sha256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig, 'base64url')),
    ).toBe(true);
    expect(call?.form?.toString()).not.toContain(encodeURIComponent(pemBody).slice(0, 30));
    expect([...(call?.form?.keys() ?? [])].sort()).toEqual(['assertion', 'grant_type']);
  });

  it('reuses the token until a minute before it expires; parallel calls share one request', async () => {
    const { fake, sa, now, tokenCalls } = setup();
    fake.token[JWT_BEARER].push(FakeGoogle.access('sa-access-1', 3600));
    fake.token[JWT_BEARER].push(FakeGoogle.access('sa-access-2', 3600));
    const [a, b] = await Promise.all([sa.accessToken(), sa.accessToken()]);
    expect([a, b]).toEqual(['sa-access-1', 'sa-access-1']);
    expect(tokenCalls()).toHaveLength(1);

    now.ms += 58 * 60_000; // 2 minutes left: still cached
    expect(await sa.accessToken()).toBe('sa-access-1');
    expect(tokenCalls()).toHaveLength(1);

    now.ms += 90_000; // 30 seconds left: renewed with a newly signed JWT
    expect(await sa.accessToken()).toBe('sa-access-2');
    expect(tokenCalls()).toHaveLength(2);
    const iats = tokenCalls().map(
      (call) => decode((call.form?.get('assertion') ?? '').split('.')[1] ?? '').iat,
    );
    expect(iats[1]).not.toBe(iats[0]);
  });

  it('a refused key is invalid_grant with the email and Google code, never the assertion', async () => {
    const { fake, sa, tokenCalls } = setup();
    fake.token[JWT_BEARER].push({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' },
    });
    const err = await sa.accessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleError);
    expect((err as GoogleError).code).toBe('invalid_grant');
    expect((err as GoogleError).message).toContain(EMAIL);
    expect((err as GoogleError).message).not.toContain(tokenCalls()[0]?.form?.get('assertion'));
  });
});

describe('service account through the connection service (row 4.4b)', () => {
  it('reads the header row with the bearer token from the signed JWT', async () => {
    const { fake, connection } = setup();
    fake.token[JWT_BEARER].push(FakeGoogle.access('sa-access-1'));
    fake.values.push({ status: 200, body: { values: [['Public ID', 'Name', 'Company']] } });
    const headers = await connection.readHeaders(
      CONTEXT,
      SHEET_ID,
      'Daily Report',
      3,
      'service_account',
    );
    expect(headers).toEqual(['Public ID', 'Name', 'Company']);
    const [read] = fake.callsTo('sheets.googleapis.com');
    expect(read?.authorization).toBe('Bearer sa-access-1');
    expect(decodeURIComponent(read?.url.pathname ?? '')).toContain(
      `${SHEET_ID}/values/'Daily Report'!3:3`,
    );
  });

  it('a 401 drops the cached token and signs again once', async () => {
    const { fake, connection, tokenCalls } = setup();
    fake.token[JWT_BEARER].push(FakeGoogle.access('sa-old'));
    fake.token[JWT_BEARER].push(FakeGoogle.access('sa-new'));
    fake.values.push(FakeGoogle.sheetsError(401, 'UNAUTHENTICATED', 'Invalid Credentials'));
    fake.values.push({ status: 200, body: { values: [['Public ID']] } });
    expect(
      await connection.readHeaders(CONTEXT, SHEET_ID, 'Daily Report', 3, 'service_account'),
    ).toEqual(['Public ID']);
    expect(tokenCalls()).toHaveLength(2);
    expect(fake.callsTo('sheets.googleapis.com').map((c) => c.authorization)).toEqual([
      'Bearer sa-old',
      'Bearer sa-new',
    ]);
  });

  it('a refused key fails at once (not retried) and says to replace it', async () => {
    const { fake, connection } = setup();
    fake.token[JWT_BEARER].push(FakeGoogle.invalidGrant());
    const err = await sourceError(
      connection.readTab(CONTEXT, SHEET_ID, 'Daily Report', 'service_account'),
    );
    expect(err.code).toBe('access_revoked');
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/new JSON key/);
    expect(err.message).toMatch(/Excel/);
  });

  it('403 and 404 name the service account email to share the sheet with', async () => {
    for (const [status, code] of [
      [403, 'PERMISSION_DENIED'],
      [404, 'NOT_FOUND'],
    ] as const) {
      const { fake, connection } = setup();
      fake.token[JWT_BEARER].push(FakeGoogle.access('sa-access'));
      fake.values.push(FakeGoogle.sheetsError(status, code, 'The caller does not have permission'));
      const err = await sourceError(
        connection.readHeaders(CONTEXT, SHEET_ID, 'Daily Report', 3, 'service_account'),
      );
      expect(err.code).toBe('not_shared');
      expect(err.retryable).toBe(false);
      expect(err.message).toContain(`add ${EMAIL} as Viewer`);
      expect(err.message).not.toMatch(/Ask Snoonu/);
    }
  });

  it('429 that lasts is a quota error tried again later', async () => {
    const { fake, connection } = setup();
    fake.token[JWT_BEARER].push(FakeGoogle.access('sa-access'));
    fake.values.push(FakeGoogle.sheetsError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded'));
    const err = await sourceError(
      connection.readTab(CONTEXT, SHEET_ID, 'Daily Report', 'service_account'),
    );
    expect(err.code).toBe('quota_exceeded');
    expect(err.retryable).toBe(true);
  });

  it('an IMPORTRANGE error in the mirror sheet is unreadable, never zeros', async () => {
    const { fake, connection } = setup();
    fake.token[JWT_BEARER].push(FakeGoogle.access('sa-access'));
    fake.values.push({ status: 200, body: { values: [['#REF!']] } });
    const err = await sourceError(
      connection.readTab(CONTEXT, SHEET_ID, 'Daily Report', 'service_account'),
    );
    expect(err.code).toBe('sheet_unreadable');
    expect(err.retryable).toBe(true);
    fake.values.length = 0;
    fake.values.push({ status: 200, body: { values: [['Loading...']] } });
    expect(
      (await sourceError(connection.readTab(CONTEXT, SHEET_ID, 'Daily Report', 'service_account')))
        .code,
    ).toBe('sheet_unreadable');
  });

  it('without a key says how to set it, or why the key that is set cannot be used', async () => {
    const none = new GoogleConnectionService({
      uow: null as unknown as UnitOfWork,
      box: null as unknown as SecretBox,
      client: null,
    });
    const missing = await sourceError(
      none.readTab(CONTEXT, SHEET_ID, 'Daily Report', 'service_account'),
    );
    expect(missing.code).toBe('not_connected');
    expect(missing.message).toMatch(/GOOGLE_SERVICE_ACCOUNT_KEY_FILE/);

    const broken = new GoogleConnectionService({
      uow: null as unknown as UnitOfWork,
      box: null as unknown as SecretBox,
      client: null,
      serviceAccount: null,
      serviceAccountProblem: 'The service account key is not valid JSON.',
    });
    const why = await sourceError(
      broken.readTab(CONTEXT, SHEET_ID, 'Daily Report', 'service_account'),
    );
    expect(why.message).toMatch(/not valid JSON/);
    expect(why.retryable).toBe(false);
  });
});
