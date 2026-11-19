/**
 * People, row 3.7: bulk scan upload (stub OCR adapter), suggest, confirm, reject, over HTTP
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

const PASSWORD = 'synthetic-pass-3-7';

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
    ...crud('people.bulk_upload'),
  ]);
  await grantKeys(f.tenantA, ids.viewer, [
    'people.document.read',
    'people.ocr_job.read',
    'people.bulk_upload.read',
  ]);

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
  fields: { number: { value: string | null } };
}

interface Batch {
  id: string;
  status: string;
  uploadedCount: number;
  pendingCount: number;
  items: {
    id: string;
    status: string;
    suggestedPartyId: string | null;
    suggestedPartyName: string | null;
    suggestedDocumentTypeId: string | null;
    rejectReason: string | null;
    documentId: string | null;
    job: Job | null;
  }[];
}
const batchOf = (res: request.Response) => res.body as Batch;
const scanBytes = (text: string) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(text)]);

describe('bulk scan upload (row 3.7)', () => {
  let first: Batch;

  it('reads many scans into pending items; nobody is suggested when no employee matches', async () => {
    await seedDocumentTypes(owner, f.tenantA, f.companyA1);
    const typeList = await get('/document-types?pageSize=50', carol);
    for (const t of (typeList.body as { items: { id: string; code: string }[] }).items) {
      types[t.code] = t.id;
    }

    const res = await post('/bulk-uploads', carol, {
      fileObjectIds: [
        await newScan('a.jpg', scanBytes('bulk scan a')),
        await newScan('b.jpg', scanBytes('bulk scan b')),
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    first = batchOf(res);
    expect(first.status).toBe('open');
    expect(first.uploadedCount).toBe(2);
    expect(first.pendingCount).toBe(2);
    for (const i of first.items) {
      expect(i.status).toBe('pending');
      expect(i.suggestedPartyId).toBeNull();
      expect(i.suggestedDocumentTypeId).toBe(types.qid);
      expect(i.job?.status).toBe('completed');
    }
    // Nothing is a document yet.
    const docs = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM people.document WHERE ocr_job_id IS NOT NULL AND tenant_id = $1`,
      [f.tenantA],
    );
    expect(docs.rows[0]?.n).toBe(0);
  });

  it('suggests the one employee whose name matches, and nobody when two match', async () => {
    // The stub reads "Demo Holder" when no person is given.
    await owner.query(`UPDATE party.party SET display_name = 'Demo Holder' WHERE id = $1`, [
      ids.salma,
    ]);
    await owner.query(
      `INSERT INTO people.employee (tenant_id, company_id, party_id, employee_code, sponsorship)
       VALUES ($1, $2, $3, 'E7001', 'company')`,
      [f.tenantA, f.companyA1, ids.salma],
    );
    const one = batchOf(
      await post('/bulk-uploads', carol, {
        fileObjectIds: [await newScan('c.jpg', scanBytes('bulk scan c'))],
      }),
    );
    expect(one.items[0]?.suggestedPartyId).toBe(ids.salma);
    expect(one.items[0]?.suggestedPartyName).toBe('Demo Holder');

    await owner.query(`UPDATE party.party SET display_name = 'Demo Holder' WHERE id = $1`, [
      ids.karim,
    ]);
    await owner.query(
      `INSERT INTO people.employee (tenant_id, company_id, party_id, employee_code, sponsorship)
       VALUES ($1, $2, $3, 'E7002', 'company')`,
      [f.tenantA, f.companyA1, ids.karim],
    );
    const two = batchOf(
      await post('/bulk-uploads', carol, {
        fileObjectIds: [await newScan('d.jpg', scanBytes('bulk scan d'))],
      }),
    );
    expect(two.items[0]?.suggestedPartyId).toBeNull();
  });

  it('confirms one item into a document with its scan, once, and rejects another with a reason', async () => {
    const [a, b] = first.items;
    if (a === undefined || b === undefined) throw new Error('batch has two items');
    const ok = await post(`/bulk-uploads/${first.id}/items/${a.id}/confirm`, carol, {
      ownerType: 'party',
      ownerId: ids.rahim,
      documentTypeId: types.qid,
      number: a.job?.fields.number.value,
      expiryDate: inDays(500),
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const body = ok.body as { pendingCount: number; document: { id: string; ocrJobId: string } };
    expect(body.pendingCount).toBe(1);
    expect(body.document.ocrJobId).toBe(a.job?.id);
    const attached = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM files.file_attachment
        WHERE entity_type = 'people.document' AND entity_id = $1`,
      [body.document.id],
    );
    expect(attached.rows[0]?.n).toBe(1);

    const again = await post(`/bulk-uploads/${first.id}/items/${a.id}/confirm`, carol, {
      ownerType: 'party',
      ownerId: ids.rahim,
      customName: 'Second copy',
    });
    expect(again.status).toBe(409);
    expect(codeOf(again)).toBe('already_resolved');

    const noReason = await post(`/bulk-uploads/${first.id}/items/${b.id}/reject`, carol, {});
    expect(noReason.status).toBe(400);
    const rejected = await post(`/bulk-uploads/${first.id}/items/${b.id}/reject`, carol, {
      reason: 'Blurry copy',
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);

    const after = batchOf(await get(`/bulk-uploads/${first.id}`, carol));
    expect(after.status).toBe('completed');
    expect(after.pendingCount).toBe(0);
    expect(after.items.map((i) => i.status).sort()).toEqual(['confirmed', 'rejected']);
    expect(after.items.find((i) => i.status === 'rejected')?.rejectReason).toBe('Blurry copy');
    // A rejected scan creates no document.
    const rejectedDocs = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM people.document WHERE ocr_job_id = $1`,
      [b.job?.id],
    );
    expect(rejectedDocs.rows[0]?.n).toBe(0);
  });

  it('refuses a whole batch when one file is not a scan; permissions and tenants stay apart', async () => {
    const count = async () =>
      (
        await owner.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM people.bulk_upload WHERE tenant_id = $1`,
          [f.tenantA],
        )
      ).rows[0]?.n;
    const before = await count();
    const bad = await post('/bulk-uploads', carol, {
      fileObjectIds: [
        await newScan('ok.jpg', scanBytes('ok')),
        await newScan('notes.txt', Buffer.from('hello'), 'text/plain'),
      ],
    });
    expect(fieldCodes(bad)).toContain('not_a_scan');
    expect(await count()).toBe(before);

    const id = randomUUID();
    expect((await post('/bulk-uploads', dave, { fileObjectIds: [id] })).status).toBe(403);
    expect((await get(`/bulk-uploads/${first.id}`, dave)).status).toBe(200);
    expect(
      (await post(`/bulk-uploads/${first.id}/items/${id}/reject`, dave, { reason: 'x' })).status,
    ).toBe(403);
    expect((await get(`/bulk-uploads/${first.id}`, bob)).status).toBe(404);
    expect((await post('/bulk-uploads', carol, { fileObjectIds: [] })).status).toBe(400);
  });
});
