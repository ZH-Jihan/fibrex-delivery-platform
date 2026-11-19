/**
 * People, row 3.6: OCR of scans (stub adapter), pre-fill and confirm, end to end over HTTP
 * against real PostgreSQL and Redis.
 *
 * People (all invented), tenant A, company A1:
 *   alice  super_admin: every permission
 *   carol  hr clerk: documents and OCR
 *   dave   viewer: reads documents and OCR readings
 * Tenant B: bob, super_admin (isolation checks).
 *
 * Every number below is made up by the stub adapter from synthetic file bytes.
 */
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { API_PREFIX, createApp } from '../../src/app.js';
import { createAuditService } from '../../src/kernel/audit/audit-service.js';
import { AccessTokens } from '../../src/kernel/auth/access-token.js';
import { ApiKeyResolver } from '../../src/kernel/auth/api-keys.js';
import { createAuthRouter } from '../../src/kernel/auth/auth-router.js';
import { AuthService } from '../../src/kernel/auth/auth-service.js';
import { authenticate } from '../../src/kernel/auth/authenticate.js';
import { MfaFactors } from '../../src/kernel/auth/mfa.js';
import { hashPassword } from '../../src/kernel/auth/password-hasher.js';
import { loadEnv } from '../../src/kernel/config/env.js';
import { SecretBox } from '../../src/kernel/crypto/secret-box.js';
import { createPool, type Pool } from '../../src/kernel/db/pool.js';
import { createPrisma } from '../../src/kernel/db/prisma.js';
import { UnitOfWork } from '../../src/kernel/db/unit-of-work.js';
import { ModuleRegistry } from '../../src/kernel/module-registry/index.js';
import { NumberingService } from '../../src/kernel/numbering/numbering-service.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import {
  KERNEL_PERMISSIONS,
  syncPermissionCatalogue,
} from '../../src/kernel/permissions/catalogue.js';
import { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import {
  AttachableRegistry,
  FILES_PERMISSIONS,
  FilesService,
  createFilesModule,
} from '../../src/modules/files/index.js';
import {
  PARTY_PERMISSIONS,
  PartyReferenceRegistry,
  PartyService,
  PartyVault,
  createPartyModule,
} from '../../src/modules/party/index.js';
import {
  PEOPLE_PERMISSIONS,
  createPeopleModule,
  seedDocumentTypes,
} from '../../src/modules/people/index.js';
import { StubOcrAdapter } from '../../src/adapters/ocr/stub.js';
import { MemoryStorageAdapter } from '../../src/adapters/storage/memory.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-3-6';

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let carol: string;
let dave: string;
let bob: string;
const storage = new MemoryStorageAdapter();

const ids = {
  carol: randomUUID(),
  dave: randomUUID(),
  superAdmin: randomUUID(),
  clerk: randomUUID(),
  viewer: randomUUID(),
  superAdminB: randomUUID(),
  rahim: randomUUID(),
  karim: randomUUID(),
  salma: randomUUID(),
};
/** Document type ids of company A1 by code, after the seed. */
const types: Record<string, string> = {};

type Json = Record<string, unknown>;
const auth = (req: request.Test, token: string) => req.set('Authorization', `Bearer ${token}`);
const get = (path: string, token: string) => auth(request(app).get(`${API_PREFIX}${path}`), token);
const post = (path: string, token: string, body: Json = {}) =>
  auth(request(app).post(`${API_PREFIX}${path}`), token)
    .set('Idempotency-Key', randomUUID())
    .send(body);
interface Item {
  id: string;
  version: number;
  [key: string]: unknown;
}
const item = (res: request.Response) => res.body as Item;
const codeOf = (res: request.Response) => (res.body as { code?: string }).code;
const fieldCodes = (res: request.Response) =>
  ((res.body as { errors?: { code: string }[] }).errors ?? []).map((e) => e.code);

/** "YYYY-MM-DD", `days` from today (UTC, as the API counts). */
const inDays = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function signIn(tenant: string, identifier: string): Promise<string> {
  const res = await request(app)
    .post(`${API_PREFIX}/auth/login`)
    .send({ tenant, identifier, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.body as { accessToken: string }).accessToken;
}

async function addUser(id: string, tenantId: string, username: string) {
  await owner.query(
    `INSERT INTO iam.user_account (id, tenant_id, username, display_name, must_change_password)
     VALUES ($1, $2, $3, $4, false)
     ON CONFLICT (id) DO UPDATE SET must_change_password = false`,
    [id, tenantId, username, `${username} test`],
  );
  await owner.query(
    `INSERT INTO iam.credential (tenant_id, user_id, kind, hash) VALUES ($1, $2, 'password', $3)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, await hashPassword(PASSWORD)],
  );
}

async function addMembership(tenantId: string, userId: string, companyId: string, roleId: string) {
  const membershipId = randomUUID();
  await owner.query(
    `INSERT INTO iam.company_membership (id, tenant_id, user_id, company_id, is_default)
     VALUES ($1, $2, $3, $4, true)`,
    [membershipId, tenantId, userId, companyId],
  );
  await owner.query(
    `INSERT INTO iam.membership_role (tenant_id, membership_id, role_id) VALUES ($1, $2, $3)`,
    [tenantId, membershipId, roleId],
  );
}

async function grantKeys(tenantId: string, roleId: string, keys: readonly string[] | 'all') {
  await owner.query(
    `INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
     SELECT $1, $2, id FROM iam.permission WHERE $3::text[] IS NULL OR key = ANY ($3::text[])`,
    [tenantId, roleId, keys === 'all' ? null : keys],
  );
}

const crud = (resource: string) =>
  ['read', 'create', 'update', 'delete', 'restore'].map((a) => `${resource}.${a}`);

/** A stored scan: the file row plus its bytes in the memory store (as after an upload). */
async function newScan(name: string, bytes: Buffer, mime = 'image/jpeg'): Promise<string> {
  const key = `test/${randomUUID()}`;
  storage.put(key, bytes);
  const res = await owner.query<{ id: string }>(
    `INSERT INTO files.file_object (tenant_id, company_id, bucket, object_key, sha256, size_bytes, mime_type, original_name, created_by)
     VALUES ($1, $2, 'memory', $3, $4, $5, $6, $7, $8) RETURNING id`,
    [f.tenantA, f.companyA1, key, 'a'.repeat(64), bytes.length, mime, name, f.userA],
  );
  return res.rows[0]?.id ?? '';
}

beforeAll(async () => {
  owner = await connect('owner');
  f = await createFixture(owner);
  const db = testDatabase();
  pool = createPool(connectionUrl(db, db.app), 3);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-documents');
  const prisma = createPrisma(pool);
  await syncPermissionCatalogue(prisma, [
    ...KERNEL_PERMISSIONS,
    ...PARTY_PERMISSIONS,
    ...PEOPLE_PERMISSIONS,
    ...FILES_PERMISSIONS,
  ]);

  const slugs = await owner.query<{ id: string; slug: string }>(
    `SELECT id, slug FROM platform.tenant WHERE id IN ($1, $2)`,
    [f.tenantA, f.tenantB],
  );
  const slugA = slugs.rows.find((r) => r.id === f.tenantA)?.slug ?? '';
  const slugB = slugs.rows.find((r) => r.id === f.tenantB)?.slug ?? '';

  await owner.query(
    `INSERT INTO iam.role (id, tenant_id, key, name, is_builtin) VALUES
       ($1, $4, 'super_admin', 'Super Admin', true),
       ($2, $4, 'clerk', 'Clerk', true),
       ($3, $4, 'viewer', 'Viewer', true),
       ($5, $6, 'super_admin', 'Super Admin', true)`,
    [ids.superAdmin, ids.clerk, ids.viewer, f.tenantA, ids.superAdminB, f.tenantB],
  );
  await grantKeys(f.tenantA, ids.superAdmin, 'all');
  await grantKeys(f.tenantB, ids.superAdminB, 'all');
  await grantKeys(f.tenantA, ids.clerk, [
    ...crud('people.document'),
    ...crud('people.document_type'),
    'people.document_type.read',
    'people.ocr_job.create',
    'people.ocr_job.read',
  ]);
  await grantKeys(f.tenantA, ids.viewer, ['people.document.read', 'people.ocr_job.read']);

  await addUser(f.userA, f.tenantA, 'alice');
  await addUser(f.userB, f.tenantB, 'bob');
  await addUser(ids.carol, f.tenantA, 'carol');
  await addUser(ids.dave, f.tenantA, 'dave');
  await addMembership(f.tenantA, f.userA, f.companyA1, ids.superAdmin);
  await addMembership(f.tenantA, ids.carol, f.companyA1, ids.clerk);
  await addMembership(f.tenantA, ids.dave, f.companyA1, ids.viewer);
  await addMembership(f.tenantB, f.userB, f.companyB1, ids.superAdminB);

  await owner.query(
    `INSERT INTO party.party (id, tenant_id, company_id, kind, display_name) VALUES
       ($1, $4, $5, 'person', 'Rahim Example'),
       ($2, $4, $5, 'person', 'Karim Example'),
       ($3, $4, $5, 'person', 'Salma Example')`,
    [ids.rahim, ids.karim, ids.salma, f.tenantA, f.companyA1],
  );

  const env = loadEnv({
    DATABASE_URL: 'postgresql://unused@localhost:1/x',
    REDIS_URL: 'redis://localhost:1',
    ...TEST_AUTH_ENV,
    RATE_LIMIT_ANONYMOUS: '10000',
    RATE_LIMIT_AUTHENTICATED: '10000',
    AUTH_RATE_LIMIT: '10000',
  });
  const logger = createLogger({ level: 'silent', pretty: false, serviceName: 'test' });
  const uow = new UnitOfWork(prisma);
  const tokens = new AccessTokens(env.AUTH_TOKEN_SECRET, env.AUTH_ACCESS_TTL_SECONDS);
  const mfa = new MfaFactors({
    box: new SecretBox(env.DATA_ENCRYPTION_KEY),
    tokenSecret: env.AUTH_TOKEN_SECRET,
    issuer: env.AUTH_TOTP_ISSUER,
  });
  const authService = new AuthService({
    prisma,
    uow,
    redis,
    tokens,
    mfa,
    messaging: { send: () => Promise.resolve() },
    logger,
    env,
  });
  const permissions = new PermissionService(uow);
  const apiKeys = new ApiKeyResolver({ prisma, uow, redis, logger });
  const audit = createAuditService();
  const vault = new PartyVault(new SecretBox(env.DATA_ENCRYPTION_KEY), env.DATA_ENCRYPTION_KEY);
  const attachables = new AttachableRegistry();
  const files = new FilesService({
    storage,
    permissions,
    audit,
    attachables,
    tokenSecret: env.AUTH_TOKEN_SECRET,
    maxBytes: 1_000_000,
    uploadTtlSeconds: 300,
    downloadTtlSeconds: 300,
  });
  app = createApp({
    env,
    logger,
    redis,
    readinessChecks: [],
    authenticate: authenticate({ tokens, redis, apiKeys }),
    mountApi: (api, registry) => {
      api.use(
        createAuthRouter({
          auth: authService,
          registry,
          redis,
          logger,
          env,
          cookiePath: `${API_PREFIX}/auth`,
        }),
      );
      // Wired the same way as main.ts.
      const modules = new ModuleRegistry({ kernelPermissions: KERNEL_PERMISSIONS });
      modules.register(
        createPartyModule({
          uow,
          registry,
          permissions,
          audit,
          vault,
          references: new PartyReferenceRegistry(),
        }),
      );
      const people = createPeopleModule({
        uow,
        registry,
        permissions,
        parties: new PartyService(vault),
        numbering: new NumberingService(),
        vault,
        audit,
        attachables,
        ocr: { adapter: new StubOcrAdapter(), storage },
      });
      modules.register(people.manifest);
      modules.register(createFilesModule({ uow, registry, permissions, files, attachables }));
      modules.mount(api);
      for (const attachable of modules.attachables()) attachables.register(attachable);
    },
  });

  carol = await signIn(slugA, 'carol');
  dave = await signIn(slugA, 'dave');
  bob = await signIn(slugB, 'bob');
});

afterAll(async () => {
  const counters = await redis.keys('rl:*');
  if (counters.length > 0) await redis.del(...counters);
  await redis.quit();
  await pool.end();
  await owner.end();
});

interface Job {
  id: string;
  status: string;
  provider: string;
  documentId: string | null;
  flags: string[];
  fields: {
    documentTypeId: { value: string | null; confidence: number };
    number: { value: string | null; masked: string | null; confidence: number };
    holderName: { value: string | null; confidence: number };
    issueDate: { value: string | null; confidence: number };
    expiryDate: { value: string | null; confidence: number };
  };
}
const job = (res: request.Response) => res.body as Job;
/** Synthetic scan bytes: a JPEG start marker and some text. */
const scanBytes = (text: string) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(text)]);
const firstScan = scanBytes('synthetic qid scan one');
let rahimJob: Job;

describe('OCR upload, pre-fill and confirm (row 3.6)', () => {
  it('reads a scan into an ocr_job with per-field confidence and creates no document', async () => {
    expect(await seedDocumentTypes(owner, f.tenantA, f.companyA1)).toBe(8);
    const list = await get('/document-types?pageSize=50', carol);
    for (const t of (list.body as { items: { id: string; code: string }[] }).items) {
      types[t.code] = t.id;
    }

    const fileObjectId = await newScan('rahim-qid.jpg', firstScan);
    const res = await post('/ocr/jobs', carol, {
      fileObjectId,
      ownerId: ids.rahim,
      documentTypeId: types.qid,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    rahimJob = job(res);
    expect(rahimJob.status).toBe('completed');
    expect(rahimJob.provider).toBe('stub');
    expect(rahimJob.flags).toEqual([]);
    expect(rahimJob.fields.documentTypeId.value).toBe(types.qid);
    expect(rahimJob.fields.holderName.value).toBe('Rahim Example');
    expect(rahimJob.fields.number.value).toMatch(/^[0-9]{11}$/);
    expect(rahimJob.fields.number.masked).toMatch(/^\*+[0-9]{4}$/);
    expect(rahimJob.fields.number.confidence).toBeGreaterThan(0.9);
    expect(rahimJob.fields.expiryDate.value).toBe(inDays(730));

    // Nothing is saved as a document before a person confirms.
    const docs = await get(`/documents?ownerType=party&ownerId=${ids.rahim}`, carol);
    expect((docs.body as { items: unknown[] }).items).toHaveLength(0);
    // The plain number is nowhere in the row: result keeps the mask, the number is sealed.
    const raw = await owner.query<{ result: string; sealed: Buffer }>(
      `SELECT result::text AS result, number_encrypted AS sealed FROM people.ocr_job WHERE id = $1`,
      [rahimJob.id],
    );
    const plain = rahimJob.fields.number.value ?? '';
    expect(raw.rows[0]?.result).not.toContain(plain);
    expect(raw.rows[0]?.sealed.toString('latin1')).not.toContain(plain);
    // Adapter health: the stub provider is registered for the tenant and its call recorded.
    const health = await owner.query<{ status: string; active: boolean }>(
      `SELECT h.status, c.active FROM integration.integration_health h
         JOIN integration.adapter_config c ON c.id = h.adapter_config_id
        WHERE c.tenant_id = $1 AND c.adapter_kind = 'ocr' AND c.provider = 'stub'`,
      [f.tenantA],
    );
    expect(health.rows.length).toBeGreaterThan(0);
    expect(health.rows[0]).toEqual({ status: 'ok', active: true });
  });

  it('shows the plain number only to the uploader; other tenants see nothing', async () => {
    const again = await get(`/ocr/jobs/${rahimJob.id}`, carol);
    expect(job(again).fields.number.value).toBe(rahimJob.fields.number.value);
    const viewer = await get(`/ocr/jobs/${rahimJob.id}`, dave);
    expect(viewer.status).toBe(200);
    expect(job(viewer).fields.number.value).toBeNull();
    expect(job(viewer).fields.number.masked).toBe(rahimJob.fields.number.masked);
    expect((await get(`/ocr/jobs/${rahimJob.id}`, bob)).status).toBe(404);
    expect((await post('/ocr/jobs', dave, { fileObjectId: randomUUID() })).status).toBe(403);
  });

  it('confirms the corrected values as a document with the scan attached, once', async () => {
    const corrected = inDays(700);
    const res = await post(`/ocr/jobs/${rahimJob.id}/confirm`, carol, {
      ownerType: 'party',
      ownerId: ids.rahim,
      documentTypeId: types.qid,
      number: rahimJob.fields.number.value,
      issueDate: rahimJob.fields.issueDate.value,
      expiryDate: corrected,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const doc = item(res);
    expect(doc.ocrJobId).toBe(rahimJob.id);
    expect(doc.expiryDate).toBe(corrected);
    expect(doc.numberMasked).toBe(rahimJob.fields.number.masked);

    const files = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM files.file_attachment
        WHERE entity_type = 'people.document' AND entity_id = $1`,
      [doc.id],
    );
    expect(files.rows[0]?.n).toBe(1);
    const after = job(await get(`/ocr/jobs/${rahimJob.id}`, carol));
    expect(after.status).toBe('confirmed');
    expect(after.documentId).toBe(doc.id);
    // After confirming, the number is only shown through the audited reveal.
    expect(after.fields.number.value).toBeNull();

    const twice = await post(`/ocr/jobs/${rahimJob.id}/confirm`, carol, {
      ownerType: 'party',
      ownerId: ids.rahim,
      customName: 'Second copy',
    });
    expect(twice.status).toBe(409);
    expect(codeOf(twice)).toBe('already_confirmed');
  });

  it('flags low confidence, a name mismatch and an expired document', async () => {
    const fileObjectId = await newScan('mismatch-expired-blurry.jpg', scanBytes('karim scan'));
    const res = await post('/ocr/jobs', carol, { fileObjectId, ownerId: ids.karim });
    expect(res.status).toBe(201);
    expect(job(res).flags).toEqual(['low_confidence', 'name_mismatch', 'expired']);
    expect(job(res).fields.number.confidence).toBeLessThan(0.6);
  });

  it('flags a number another document holds, and an unreadable or cropped scan', async () => {
    // Same bytes as the confirmed scan: the stub reads the same number, the hash matches.
    const dup = await post('/ocr/jobs', carol, {
      fileObjectId: await newScan('salma-qid.jpg', firstScan),
      ownerId: ids.salma,
      documentTypeId: types.qid,
    });
    expect(job(dup).flags).toEqual(['duplicate']);

    const blank = await post('/ocr/jobs', carol, {
      fileObjectId: await newScan('blank.png', scanBytes('nothing')),
    });
    expect(job(blank).flags).toEqual(['unreadable']);
    expect(job(blank).fields.number.value).toBeNull();
    const cropped = await post('/ocr/jobs', carol, {
      fileObjectId: await newScan('cropped.jpg', scanBytes('cropped')),
    });
    expect(job(cropped).flags).toEqual(['cropped']);
  });

  it('refuses a file that is not a scan, an unknown file and an unknown person', async () => {
    const text = await post('/ocr/jobs', carol, {
      fileObjectId: await newScan('notes.txt', Buffer.from('hello'), 'text/plain'),
    });
    expect(fieldCodes(text)).toContain('not_a_scan');
    const unknown = await post('/ocr/jobs', carol, { fileObjectId: randomUUID() });
    expect(fieldCodes(unknown)).toContain('unknown_file');
    const otherOwner = await post('/ocr/jobs', carol, {
      fileObjectId: await newScan('x.jpg', scanBytes('x')),
      ownerId: randomUUID(),
    });
    expect(fieldCodes(otherOwner)).toContain('unknown_owner');
  });
});
