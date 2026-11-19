/**
 * People, row 3.2: document types, requirements and documents, end to end over HTTP against
 * real PostgreSQL and Redis.
 *
 * People (all invented), tenant A, company A1:
 *   alice  super_admin: every permission (including revealing numbers)
 *   carol  hr clerk: documents and types, but not the reveal permission
 *   dave   viewer: reads documents
 * Tenant B: bob, super_admin (isolation checks).
 *
 * Every document number below is made up.
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
import { MemoryStorageAdapter } from '../../src/adapters/storage/memory.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-3-2';

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let alice: string;
let carol: string;
let dave: string;
let bob: string;

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
interface Doc {
  id: string;
  version: number;
  status: string;
  numberMasked: string | null;
  replacesId: string | null;
  expiryDate: string | null;
}
const auth = (req: request.Test, token: string) => req.set('Authorization', `Bearer ${token}`);
const get = (path: string, token: string) => auth(request(app).get(`${API_PREFIX}${path}`), token);
const post = (path: string, token: string, body: Json = {}) =>
  auth(request(app).post(`${API_PREFIX}${path}`), token)
    .set('Idempotency-Key', randomUUID())
    .send(body);
const postIf = (path: string, token: string, version: number, body: Json = {}) =>
  auth(request(app).post(`${API_PREFIX}${path}`), token)
    .set('Idempotency-Key', randomUUID())
    .set('If-Match', `"${String(version)}"`)
    .send(body);
const patch = (path: string, token: string, version: number, body: Json) =>
  auth(request(app).patch(`${API_PREFIX}${path}`), token)
    .set('Idempotency-Key', randomUUID())
    .set('If-Match', `"${String(version)}"`)
    .send(body);
const del = (path: string, token: string, version: number, reason: string) =>
  auth(request(app).delete(`${API_PREFIX}${path}`), token)
    .set('Idempotency-Key', randomUUID())
    .set('If-Match', `"${String(version)}"`)
    .send({ reason });
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

/** A stored file (the bytes are not needed: attachments only reference the row). */
async function newFile(name: string): Promise<string> {
  const res = await owner.query<{ id: string }>(
    `INSERT INTO files.file_object (tenant_id, company_id, bucket, object_key, sha256, size_bytes, mime_type, original_name, created_by)
     VALUES ($1, $2, 'memory', $3, $4, 1000, 'image/jpeg', $5, $6) RETURNING id`,
    [f.tenantA, f.companyA1, `test/${randomUUID()}`, 'a'.repeat(64), name, f.userA],
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
    ...crud('people.document_requirement'),
  ]);
  await grantKeys(f.tenantA, ids.viewer, ['people.document.read']);

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
    storage: new MemoryStorageAdapter(),
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
      });
      modules.register(people.manifest);
      modules.register(createFilesModule({ uow, registry, permissions, files, attachables }));
      modules.mount(api);
      for (const attachable of modules.attachables()) attachables.register(attachable);
    },
  });

  alice = await signIn(slugA, 'alice');
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

async function newDoc(token: string, payload: Json): Promise<Doc> {
  const res = await post('/documents', token, payload);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Doc;
}

describe('document types and requirements', () => {
  it('seeds the eight standard types once, with the owner-approved requirements', async () => {
    expect(await seedDocumentTypes(owner, f.tenantA, f.companyA1)).toBe(8);
    expect(await seedDocumentTypes(owner, f.tenantA, f.companyA1)).toBe(0);

    const res = await get('/document-types?pageSize=50', carol);
    expect(res.status).toBe(200);
    const items = (res.body as { items: { id: string; code: string; appliesTo: string }[] }).items;
    for (const t of items) types[t.code] = t.id;
    expect(Object.keys(types).sort()).toEqual([
      'agreement',
      'driving_licence',
      'food_handling',
      'health_card',
      'insurance',
      'istimara',
      'passport',
      'qid',
    ]);
    expect(items.find((t) => t.code === 'istimara')?.appliesTo).toBe('vehicle');

    const reqs = await owner.query<{ code: string; condition_expr: string | null }>(
      `SELECT t.code, r.condition_expr FROM people.document_requirement r
         JOIN people.document_type t ON t.id = r.document_type_id
        WHERE r.company_id = $1 ORDER BY t.code`,
      [f.companyA1],
    );
    expect(reqs.rows).toEqual([
      { code: 'agreement', condition_expr: 'sponsorship == "outside"' },
      { code: 'driving_licence', condition_expr: null },
      { code: 'food_handling', condition_expr: null },
      { code: 'health_card', condition_expr: null },
      { code: 'insurance', condition_expr: null },
      { code: 'passport', condition_expr: null },
      { code: 'qid', condition_expr: null },
    ]);
  });

  it('keeps standard types, lets admins add their own and checks requirement formulas', async () => {
    const qid = await get(`/document-types/${types.qid ?? ''}`, carol);
    const refused = await del(`/document-types/${types.qid ?? ''}`, carol, item(qid).version, 'x');
    expect(refused.status).toBe(409);
    expect(codeOf(refused)).toBe('system_document_type');

    const renamed = await patch(`/document-types/${types.qid ?? ''}`, carol, item(qid).version, {
      name: { en: 'Qatar ID', bn: 'কাতার আইডি' },
      alertWindows: [7, 30, 30],
    });
    expect(renamed.status).toBe(200);
    expect(item(renamed).alertWindows).toEqual([30, 7]);
    const back = await patch(`/document-types/${types.qid ?? ''}`, carol, item(renamed).version, {
      alertWindows: null,
    });
    expect(item(back).alertWindows).toBeNull();

    const own = await post('/document-types', carol, {
      code: 'trade_licence',
      name: { en: 'Trade licence' },
      appliesTo: 'company',
    });
    expect(own.status).toBe(201);
    expect(item(own).isSystem).toBe(false);
    types.trade_licence = item(own).id;
    const tmp = await post('/document-types', carol, {
      code: 'gym_card',
      name: { en: 'Gym card' },
      appliesTo: 'party',
      hasExpiry: false,
    });
    expect((await del(`/document-types/${item(tmp).id}`, carol, 1, 'Not used')).status).toBe(204);

    const bad = await post('/document-requirements', carol, {
      documentTypeId: types.agreement,
      conditionExpr: 'sponsorship ==',
    });
    expect(bad.status).toBe(400);
    const notBool = await post('/document-requirements', carol, {
      documentTypeId: types.agreement,
      conditionExpr: 'sponsorship',
    });
    expect(notBool.status).toBe(400);
    const vehicleType = await post('/document-requirements', carol, {
      documentTypeId: types.istimara,
    });
    expect(fieldCodes(vehicleType)).toContain('unknown_document_type');
    const ok = await post('/document-requirements', carol, {
      documentTypeId: types.food_handling,
      conditionExpr: 'profession == "rider" && nationality != "QA"',
      appliesToProfession: 'rider',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });
});

describe('documents', () => {
  it('seals the number: ciphertext in the database, the mask in lists, reveal is audited', async () => {
    const doc = await newDoc(carol, {
      ownerType: 'party',
      ownerId: ids.rahim,
      documentTypeId: types.qid,
      number: '2900-1234 5678',
      issueDate: inDays(-300),
      expiryDate: inDays(400),
    });
    expect(doc.status).toBe('valid');
    expect(doc.numberMasked).toBe('********5678');
    expect(JSON.stringify(doc)).not.toContain('29001234');

    // Raw database read: no column holds the plain number.
    const raw = await owner.query<{ row: string; enc: Buffer; hash: string; masked: string }>(
      `SELECT row_to_json(d)::text AS row, number_encrypted AS enc, number_hash AS hash,
              number_masked AS masked
         FROM people.document d WHERE id = $1`,
      [doc.id],
    );
    const r = raw.rows[0];
    expect(r?.row).not.toContain('290012345678');
    expect(r?.enc.toString('utf8')).not.toContain('290012345678');
    expect(r?.enc.toString('hex')).not.toContain(Buffer.from('290012345678').toString('hex'));
    expect(r?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r?.masked).toBe('********5678');

    const list = await get(`/documents?ownerType=party&ownerId=${ids.rahim}`, dave);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain('290012345678');

    expect((await post(`/documents/${doc.id}/reveal`, carol)).status).toBe(403);
    expect((await post(`/documents/${doc.id}/reveal`, dave)).status).toBe(403);
    const revealed = await post(`/documents/${doc.id}/reveal`, alice);
    expect(revealed.status).toBe(200);
    expect(revealed.body).toEqual({ value: '290012345678' });
    const audit = await owner.query<{ action: string; actor: string | null }>(
      `SELECT action, user_id AS actor FROM audit.audit_log
        WHERE entity_type = 'people.document' AND entity_id = $1 ORDER BY at`,
      [doc.id],
    );
    expect(audit.rows.map((a) => a.action)).toEqual(['create', 'reveal']);
    expect(audit.rows[1]?.actor).toBe(f.userA);
  });

  it('derives the status from the expiry date and the type windows, never from the body', async () => {
    const soon = await newDoc(carol, {
      ownerType: 'party',
      ownerId: ids.karim,
      documentTypeId: types.passport,
      number: 'TP7000001',
      expiryDate: inDays(10),
    });
    expect(soon.status).toBe('expiring');
    const old = await newDoc(carol, {
      ownerType: 'party',
      ownerId: ids.karim,
      documentTypeId: types.health_card,
      number: 'HC-55001',
      expiryDate: inDays(-3),
    });
    expect(old.status).toBe('expired');

    // A type with its own 30-day window: 20 days left is expiring.
    const ins = await get(`/document-types/${types.insurance ?? ''}`, alice);
    await patch(`/document-types/${types.insurance ?? ''}`, alice, item(ins).version, {
      alertWindows: [30],
    });
    const insured = await newDoc(carol, {
      ownerType: 'party',
      ownerId: ids.karim,
      documentTypeId: types.insurance,
      number: 'INS 9001',
      expiryDate: inDays(20),
    });
    expect(insured.status).toBe('expiring');

    // Moving the expiry date recomputes the status; a status in the body is refused.
    const moved = await patch(`/documents/${soon.id}`, carol, soon.version, {
      expiryDate: inDays(200),
    });
    expect(moved.status).toBe(200);
    expect(item(moved).status).toBe('valid');
    expect(
      (await patch(`/documents/${soon.id}`, carol, item(moved).version, { status: 'valid' }))
        .status,
    ).toBe(400);
  });

  it('applies the type rules: owner kind, number, expiry, one current document', async () => {
    const base = { ownerType: 'party', ownerId: ids.salma };
    const noExpiry = await post('/documents', carol, {
      ...base,
      documentTypeId: types.passport,
      number: 'TP7000002',
    });
    expect(fieldCodes(noExpiry)).toContain('expiry_required');
    const agreementNumber = await post('/documents', carol, {
      ...base,
      documentTypeId: types.agreement,
      number: 'AG-1',
      expiryDate: inDays(300),
    });
    expect(fieldCodes(agreementNumber)).toContain('number_not_used');
    const wrongOwner = await post('/documents', carol, {
      ...base,
      documentTypeId: types.istimara,
      number: 'IS-1',
      expiryDate: inDays(300),
    });
    expect(fieldCodes(wrongOwner)).toContain('wrong_owner_type');
    const vehicle = await post('/documents', carol, {
      ownerType: 'vehicle',
      ownerId: randomUUID(),
      documentTypeId: types.istimara,
      expiryDate: inDays(300),
    });
    expect(codeOf(vehicle)).toBe('owner_type_unavailable');
    const nobody = await post('/documents', carol, {
      ...base,
      ownerId: randomUUID(),
      customName: 'Gym pass',
    });
    expect(fieldCodes(nobody)).toContain('unknown_owner');

    const company = await newDoc(carol, {
      ownerType: 'company',
      ownerId: f.companyA1,
      documentTypeId: types.trade_licence,
      number: 'CR 12345',
      expiryDate: inDays(90),
    });
    expect(company.status).toBe('valid');

    const first = await newDoc(carol, {
      ...base,
      documentTypeId: types.driving_licence,
      number: 'DL-1001',
      expiryDate: inDays(300),
    });
    const second = await post('/documents', carol, {
      ...base,
      documentTypeId: types.driving_licence,
      number: 'DL-1002',
      expiryDate: inDays(600),
    });
    expect(second.status).toBe(409);
    expect(codeOf(second)).toBe('document_exists');
    expect(item(second).currentId).toBe(first.id);
  });

  it('takes custom documents by name, one current per name', async () => {
    const gym = await newDoc(carol, {
      ownerType: 'party',
      ownerId: ids.salma,
      customName: 'Gym pass',
      expiryDate: inDays(60),
    });
    expect(gym.numberMasked).toBeNull();
    const again = await post('/documents', carol, {
      ownerType: 'party',
      ownerId: ids.salma,
      customName: 'GYM PASS',
    });
    expect(codeOf(again)).toBe('document_exists');
    const both = await post('/documents', carol, {
      ownerType: 'party',
      ownerId: ids.salma,
      customName: 'X',
      documentTypeId: types.qid,
    });
    expect(both.status).toBe(400);
    const rename = await patch(`/documents/${gym.id}`, carol, gym.version, {
      customName: 'Gym membership',
    });
    expect(rename.status).toBe(200);
  });

  it('renews: the old document is kept as replaced and the new one points back', async () => {
    const old = await newDoc(carol, {
      ownerType: 'party',
      ownerId: ids.salma,
      documentTypeId: types.food_handling,
      number: 'FH-100',
      expiryDate: inDays(5),
    });
    expect(old.status).toBe('expiring');
    expect((await post(`/documents/${old.id}/renew`, carol, {})).status).toBe(428);
    const renewed = await postIf(`/documents/${old.id}/renew`, carol, old.version, {
      number: 'FH-200',
      issueDate: inDays(0),
      expiryDate: inDays(365),
    });
    expect(renewed.status, JSON.stringify(renewed.body)).toBe(201);
    expect(item(renewed).replacesId).toBe(old.id);
    expect(item(renewed).status).toBe('valid');
    expect(item(renewed).numberMasked).toBe('*H200');

    const kept = await get(`/documents/${old.id}`, carol);
    expect(item(kept).status).toBe('replaced');
    expect(item(kept).numberMasked).toBe('*H100');
    // A replaced document stays replaced when corrected.
    const corrected = await patch(`/documents/${old.id}`, carol, item(kept).version, {
      expiryDate: inDays(6),
    });
    expect(item(corrected).status).toBe('replaced');
    const twice = await postIf(`/documents/${old.id}/renew`, carol, item(corrected).version, {
      expiryDate: inDays(400),
    });
    expect(codeOf(twice)).toBe('already_renewed');

    const current = await get(
      `/documents?ownerId=${ids.salma}&documentTypeId=${types.food_handling ?? ''}`,
      dave,
    );
    const statuses = (current.body as { items: Doc[] }).items.map((d) => d.status).sort();
    expect(statuses).toEqual(['replaced', 'valid']);
  });

  it('stores scans through the files module: pages, versions, single-page rule', async () => {
    const card = await newDoc(carol, {
      ownerType: 'party',
      ownerId: ids.rahim,
      documentTypeId: types.health_card,
      number: 'HC-77001',
      expiryDate: inDays(100),
    });
    const scan1 = await newFile('health-front.jpg');
    const scan2 = await newFile('health-rescan.jpg');
    const page = await post(`/documents/${card.id}/files`, carol, { fileObjectId: scan1 });
    expect(page.status, JSON.stringify(page.body)).toBe(201);
    expect(item(page).versionNo).toBe(1);
    const second = await post(`/documents/${card.id}/files`, carol, { fileObjectId: scan2 });
    expect(codeOf(second)).toBe('single_page_document');
    const version = await post(`/documents/${card.id}/files`, carol, {
      fileObjectId: scan2,
      replacesAttachmentId: item(page).id,
    });
    expect(version.status).toBe(201);
    expect(item(version).versionNo).toBe(2);
    expect(item(version).supersedesId).toBe(item(page).id);
    const stale = await post(`/documents/${card.id}/files`, carol, {
      fileObjectId: scan1,
      replacesAttachmentId: item(page).id,
    });
    expect(codeOf(stale)).toBe('not_latest_version');

    // A multi-page type (QID) takes front and back as two pages.
    const qid = (
      await get(`/documents?ownerId=${ids.rahim}&documentTypeId=${types.qid ?? ''}`, carol)
    ).body as { items: Doc[] };
    const qidId = qid.items[0]?.id ?? '';
    for (const name of ['qid-front.jpg', 'qid-back.jpg']) {
      const res = await post(`/documents/${qidId}/files`, carol, {
        fileObjectId: await newFile(name),
        label: name,
      });
      expect(res.status).toBe(201);
    }
    // Another document's page cannot be replaced through this one.
    const foreign = await post(`/documents/${qidId}/files`, carol, {
      fileObjectId: await newFile('x.jpg'),
      replacesAttachmentId: item(version).id,
    });
    expect(foreign.status).toBe(404);
    // The viewer cannot add files.
    expect((await post(`/documents/${card.id}/files`, dave, { fileObjectId: scan1 })).status).toBe(
      403,
    );
  });

  it('enforces the vault, type-or-name and one-current rules in the database itself', async () => {
    const insert = (cols: string, values: string) =>
      owner.query(
        `INSERT INTO people.document (tenant_id, company_id, owner_type, owner_id, ${cols})
         VALUES ($1, $2, 'party', $3, ${values})`,
        [f.tenantA, f.companyA1, ids.karim],
      );
    await expect(insert('custom_name', 'NULL')).rejects.toThrow(/document_type_or_custom_ck/);
    await expect(
      insert('document_type_id, custom_name', `'${types.qid ?? ''}', 'Both'`),
    ).rejects.toThrow(/document_type_or_custom_ck/);
    // A plain number in the mask column is refused.
    await expect(
      insert(
        'custom_name, number_encrypted, number_hash, number_masked',
        `'Plain', '\\x00', '${'b'.repeat(64)}', 'TP7000001'`,
      ),
    ).rejects.toThrow(/number_masked/);
    await expect(insert('custom_name, number_masked', `'Half', '****0001'`)).rejects.toThrow(
      /document_number_vault_ck/,
    );
    await expect(
      insert('document_type_id, status', `'${types.passport ?? ''}', 'valid'`),
    ).rejects.toThrow(/document_one_current/);
    await expect(
      owner.query(
        `INSERT INTO people.document (tenant_id, company_id, owner_type, owner_id, custom_name)
         VALUES ($1, $2, 'company', $3, 'Wrong company')`,
        [f.tenantA, f.companyA1, f.companyA2],
      ),
    ).rejects.toThrow(/document_company_owner_ck/);
  });

  it('hides documents from other tenants, lets the viewer only read, and deletes softly', async () => {
    const doc = await newDoc(carol, {
      ownerType: 'party',
      ownerId: ids.karim,
      customName: 'Visa copy',
    });
    expect((await get(`/documents/${doc.id}`, bob)).status).toBe(404);
    expect((await post(`/documents/${doc.id}/reveal`, bob)).status).toBe(404);
    expect((await get(`/documents/${doc.id}`, dave)).status).toBe(200);
    expect(
      (await post('/documents', dave, { ownerType: 'party', ownerId: ids.karim, customName: 'X' }))
        .status,
    ).toBe(403);

    expect((await del(`/documents/${doc.id}`, carol, doc.version, 'Entered twice')).status).toBe(
      204,
    );
    expect((await get(`/documents/${doc.id}`, carol)).status).toBe(404);
    const row = await owner.query<{ deleted_at: Date | null; version: number }>(
      `SELECT deleted_at, version FROM people.document WHERE id = $1`,
      [doc.id],
    );
    expect(row.rows[0]?.deleted_at).not.toBeNull();
    const restored = await postIf(`/documents/${doc.id}/restore`, carol, row.rows[0]?.version ?? 0);
    expect(restored.status).toBe(200);
  });
});
