/**
 * Party and files (Phase 1, commit 8), end to end over HTTP against real PostgreSQL and
 * Redis, with the in-memory storage stub standing in for the object store.
 *
 * People (all invented), tenant A, company A1:
 *   alice  super_admin: every permission
 *   carol  clerk: works with parties, requests bank accounts, may approve (but not her own)
 *   dave   viewer: reads parties, downloads files
 * Tenant B: bob, super_admin (for the isolation checks).
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { MemoryStorageAdapter } from '../../src/adapters/storage/memory.js';
import { API_PREFIX, createApp } from '../../src/app.js';
import { createAuditRouter } from '../../src/kernel/audit/audit-router.js';
import { createAuditService } from '../../src/kernel/audit/audit-service.js';
import { RecycleBin } from '../../src/kernel/audit/recycle-bin.js';
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
import { createLogger } from '../../src/kernel/observability/logger.js';
import {
  KERNEL_PERMISSIONS,
  syncPermissionCatalogue,
} from '../../src/kernel/permissions/catalogue.js';
import { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import { ModuleRegistry, createModuleRouter } from '../../src/kernel/module-registry/index.js';
import {
  AttachableRegistry,
  FILES_PERMISSIONS,
  FilesService,
  createFilesModule,
} from '../../src/modules/files/index.js';
import {
  PARTY_PERMISSIONS,
  PartyReferenceRegistry,
  PartyVault,
  createPartyModule,
} from '../../src/modules/party/index.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-8-1';

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let uow: UnitOfWork;
let files: FilesService;
let storage: MemoryStorageAdapter;
let slugA: string;
let slugB: string;
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
};

type Json = Record<string, unknown>;
type Body = Json & { id: string; version: number };
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
const del = (path: string, token: string, version: number, reason = 'test cleanup') =>
  auth(request(app).delete(`${API_PREFIX}${path}`), token)
    .set('Idempotency-Key', randomUUID())
    .set('If-Match', `"${String(version)}"`)
    .send({ reason });
const codeOf = (res: request.Response) => (res.body as { code?: string }).code;
const body = (res: request.Response) => res.body as Body;

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
    `INSERT INTO iam.credential (tenant_id, user_id, kind, hash) VALUES ($1, $2, 'password', $3)`,
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

const crud = (resource: string, actions: readonly string[]) =>
  actions.map((a) => `${resource}.${a}`);

beforeAll(async () => {
  owner = await connect('owner');
  f = await createFixture(owner);
  const db = testDatabase();
  pool = createPool(connectionUrl(db, db.app), 3);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-party-files');
  const prisma = createPrisma(pool);
  await syncPermissionCatalogue(prisma, [
    ...KERNEL_PERMISSIONS,
    ...PARTY_PERMISSIONS,
    ...FILES_PERMISSIONS,
  ]);

  const slugs = await owner.query<{ id: string; slug: string }>(
    `SELECT id, slug FROM platform.tenant WHERE id IN ($1, $2)`,
    [f.tenantA, f.tenantB],
  );
  slugA = slugs.rows.find((r) => r.id === f.tenantA)?.slug ?? '';
  slugB = slugs.rows.find((r) => r.id === f.tenantB)?.slug ?? '';

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
    ...crud('party.party', ['read', 'create', 'update', 'delete', 'restore']),
    ...crud('party.contact', ['read', 'create', 'update']),
    ...crud('party.role', ['read', 'create', 'update']),
    ...crud('party.identifier', ['read', 'create', 'update']),
    ...crud('party.bank_account', ['read', 'create', 'update', 'approve']),
    'party.duplicate.read',
    'files.file.upload',
    'files.file.download',
    ...crud('files.attachment', ['read', 'create', 'update']),
  ]);
  await grantKeys(f.tenantA, ids.viewer, [
    'party.party.read',
    'files.file.download',
    'files.attachment.read',
  ]);

  await addUser(f.userA, f.tenantA, 'alice');
  await addUser(f.userB, f.tenantB, 'bob');
  await addUser(ids.carol, f.tenantA, 'carol');
  await addUser(ids.dave, f.tenantA, 'dave');
  await addMembership(f.tenantA, f.userA, f.companyA1, ids.superAdmin);
  await addMembership(f.tenantA, ids.carol, f.companyA1, ids.clerk);
  await addMembership(f.tenantA, ids.dave, f.companyA1, ids.viewer);
  await addMembership(f.tenantB, f.userB, f.companyB1, ids.superAdminB);

  const env = loadEnv({
    DATABASE_URL: 'postgresql://unused@localhost:1/x',
    REDIS_URL: 'redis://localhost:1',
    ...TEST_AUTH_ENV,
    RATE_LIMIT_ANONYMOUS: '10000',
    RATE_LIMIT_AUTHENTICATED: '10000',
    AUTH_RATE_LIMIT: '10000',
  });
  const logger = createLogger({ level: 'silent', pretty: false, serviceName: 'test' });
  uow = new UnitOfWork(prisma);
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
  storage = new MemoryStorageAdapter();
  const attachables = new AttachableRegistry();
  files = new FilesService({
    storage,
    permissions,
    audit,
    attachables,
    tokenSecret: env.AUTH_TOKEN_SECRET,
    maxBytes: 1024 * 1024,
    uploadTtlSeconds: 900,
    downloadTtlSeconds: 300,
  });
  const references = new PartyReferenceRegistry();
  references.register({
    schema: 'iam',
    table: 'user_account',
    column: 'party_id',
    label: 'Login accounts',
  });
  references.register({
    schema: 'files',
    table: 'file_attachment',
    column: 'entity_id',
    label: 'Attached files',
    where: "entity_type = 'party.party'",
  });
  const recycleBin = new RecycleBin();
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
      // Wired the same way as main.ts: manifests into the registry, registry onto the app.
      const modules = new ModuleRegistry({ kernelPermissions: KERNEL_PERMISSIONS });
      modules.register(
        createPartyModule({
          uow,
          registry,
          permissions,
          audit,
          vault: new PartyVault(new SecretBox(env.DATA_ENCRYPTION_KEY), env.DATA_ENCRYPTION_KEY),
          references,
        }),
      );
      modules.register(createFilesModule({ uow, registry, permissions, files, attachables }));
      for (const attachable of modules.attachables()) attachables.register(attachable);
      for (const type of modules.recycleTypes()) recycleBin.register(type);
      modules.mount(api);
      api.use(createModuleRouter({ registry, modules }));
      api.use(
        createAuditRouter({
          uow,
          registry,
          authorize: permissions.authorize,
          audit,
          recycleBin,
        }),
      );
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

async function newParty(
  token: string,
  displayName: string,
  extra: Json = {},
  kind = 'person',
): Promise<Body> {
  const res = await post('/parties', token, { kind, displayName, ...extra });
  expect(res.status).toBe(201);
  return body(res);
}

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('synthetic test document')]);

/** Declares, "uploads" and completes a file; returns the recorded file. */
async function uploadFile(token: string, bytes = PDF, name = 'doc.pdf', mime = 'application/pdf') {
  const target = await post('/files/upload-url', token, {
    originalName: name,
    mimeType: mime,
    sizeBytes: bytes.length,
    sha256: sha(bytes),
  });
  expect(target.status).toBe(200);
  const { uploadToken, url } = target.body as { uploadToken: string; url: string };
  storage.put(url.replace('memory://upload/', '').split('?')[0] ?? '', bytes);
  const done = await post('/files/complete', token, { uploadToken });
  expect(done.status).toBe(201);
  return body(done);
}

describe('module registry', () => {
  it('lists the registered modules with their menu entries, and only to signed-in users', async () => {
    const res = await get('/modules', bob);
    expect(res.status).toBe(200);
    const body = res.body as {
      items: { key: string; permissions: string[]; nav: { path: string; permission: string }[] }[];
    };
    expect(body.items.map((m) => m.key)).toEqual(['party', 'files']);
    const party = body.items[0];
    expect(party?.permissions).toContain('party.party.merge');
    expect(party?.nav).toEqual([
      {
        path: '/people',
        labelKey: 'nav.people',
        groupKey: 'nav.people.group',
        permission: 'party.party.read',
      },
    ]);
    expect((await request(app).get(`${API_PREFIX}/modules`)).status).toBe(401);
    // Routes mounted through the registry are in the OpenAPI document like any other.
    const doc = (await request(app).get(`${API_PREFIX}/openapi.json`)).body as {
      paths: Record<string, unknown>;
    };
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/modules', '/parties', '/attachments']),
    );
  });
});

describe('parties', () => {
  it('creates, finds, updates with version checks, deletes with a reason and restores', async () => {
    const created = await post('/parties', carol, {
      kind: 'person',
      displayName: 'Hamad Test Al-Kuwari',
      names: { en: 'Hamad Test Al-Kuwari', ar: 'حمد' },
      dateOfBirth: '1990-04-12',
      nationalityCode: 'QA',
    });
    expect(created.status).toBe(201);
    expect(created.headers.etag).toBe('"1"');
    const party = body(created);

    const found = await get('/parties?q=kuwari', carol);
    expect((found.body as { items: Body[] }).items.map((p) => p.id)).toContain(party.id);

    const updated = await patch(`/parties/${party.id}`, carol, 1, { gender: 'male' });
    expect(updated.status).toBe(200);
    expect(body(updated).version).toBe(2);
    const stale = await patch(`/parties/${party.id}`, carol, 1, { gender: 'other' });
    expect(stale.status).toBe(409);
    expect(codeOf(stale)).toBe('version_conflict');

    expect((await del(`/parties/${party.id}`, carol, 2, '')).status).toBe(400);
    expect((await del(`/parties/${party.id}`, carol, 2)).status).toBe(204);
    expect((await get(`/parties/${party.id}`, carol)).status).toBe(404);
    const restored = await postIf(`/parties/${party.id}/restore`, carol, 3);
    expect(restored.status).toBe(200);
  });

  it('refuses people without the permission, and other tenants see nothing', async () => {
    const party = await newParty(alice, 'Private Person One');
    expect((await post('/parties', dave, { kind: 'person', displayName: 'X Y' })).status).toBe(403);
    expect((await get(`/parties/${party.id}`, dave)).status).toBe(200);
    expect((await get(`/parties/${party.id}`, bob)).status).toBe(404);
    const list = await get('/parties?q=Private%20Person', bob);
    expect((list.body as { total: number }).total).toBe(0);
  });

  it('gives every change an audit row with the field diff', async () => {
    const party = await newParty(alice, 'Audited Person');
    await patch(`/parties/${party.id}`, alice, 1, { gender: 'female' });
    const rows = await owner.query<{ action: string }>(
      `SELECT action FROM audit.audit_log WHERE entity_id = $1 ORDER BY at`,
      [party.id],
    );
    expect(rows.rows.map((r) => r.action)).toEqual(['create', 'update']);
  });
});

describe('contacts and roles', () => {
  it('stores phones in international form and keeps one primary per kind', async () => {
    const party = await newParty(carol, 'Contact Person');
    const first = await post('/party-contacts', carol, {
      partyId: party.id,
      kind: 'phone',
      value: '+974 5555-1234',
      isPrimary: true,
    });
    expect(first.status).toBe(201);
    expect(body(first).value).toBe('+97455551234');
    const second = await post('/party-contacts', carol, {
      partyId: party.id,
      kind: 'phone',
      value: '+97455559999',
      isPrimary: true,
    });
    expect(second.status).toBe(201);
    const list = await get(`/party-contacts?partyId=${party.id}&kind=phone`, carol);
    const items = (list.body as { items: { value: string; isPrimary: boolean }[] }).items;
    expect(items.filter((c) => c.isPrimary).map((c) => c.value)).toEqual(['+97455559999']);

    const bad = await post('/party-contacts', carol, {
      partyId: party.id,
      kind: 'phone',
      value: '55551234',
    });
    expect(bad.status).toBe(400);
    const byPhone = await get('/parties?q=%2B97455559999', carol);
    expect((byPhone.body as { items: Body[] }).items.map((p) => p.id)).toContain(party.id);
  });

  it('refuses the same role twice over the same days, and a role can be closed', async () => {
    const party = await newParty(carol, 'Role Person');
    const role = await post('/party-roles', carol, {
      partyId: party.id,
      roleType: 'rider',
      validFrom: '2026-01-01',
    });
    expect(role.status).toBe(201);
    const overlap = await post('/party-roles', carol, {
      partyId: party.id,
      roleType: 'rider',
      validFrom: '2026-06-01',
    });
    expect(overlap.status).toBe(409);
    expect(codeOf(overlap)).toBe('role_overlap');
    const closed = await patch(`/party-roles/${body(role).id}`, carol, 1, {
      validTo: '2026-03-31',
      status: 'ended',
    });
    expect(closed.status).toBe(200);
    const again = await post('/party-roles', carol, {
      partyId: party.id,
      roleType: 'rider',
      validFrom: '2026-06-01',
    });
    expect(again.status).toBe(201);
  });
});

describe('identifiers', () => {
  it('hides sensitive values, finds by exact lookup, and reveals only with permission, audited', async () => {
    const party = await newParty(carol, 'Identifier Person');
    const res = await post('/party-identifiers', carol, {
      partyId: party.id,
      type: 'qid',
      value: '2900-1234-5678',
    });
    expect(res.status).toBe(201);
    const item = body(res);
    expect(item.valueMasked).toBe('********5678');
    expect(item.valuePlain).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('29001234');

    const row = await owner.query<{ value_plain: string | null; enc: boolean }>(
      `SELECT value_plain, position('\\x32393030'::bytea in value_encrypted) > 0 AS enc
         FROM party.party_identifier WHERE id = $1`,
      [item.id],
    );
    expect(row.rows[0]?.value_plain).toBeNull();
    expect(row.rows[0]?.enc).toBe(false);

    const lookup = await get('/party-identifiers/lookup?type=qid&value=2900%201234%205678', carol);
    expect((lookup.body as { items: { partyId: string }[] }).items[0]?.partyId).toBe(party.id);
    const none = await get('/party-identifiers/lookup?type=qid&value=000000', carol);
    expect((none.body as { items: unknown[] }).items).toHaveLength(0);

    expect((await post(`/party-identifiers/${item.id}/reveal`, carol)).status).toBe(403);
    const shown = await post(`/party-identifiers/${item.id}/reveal`, alice);
    expect((shown.body as { value: string }).value).toBe('290012345678');
    const audit = await owner.query(
      `SELECT 1 FROM audit.audit_log WHERE entity_id = $1 AND action = 'reveal'`,
      [item.id],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('keeps platform ids readable, and one id cannot have two holders at once', async () => {
    const a = await newParty(carol, 'Rider One');
    const b = await newParty(carol, 'Rider Two');
    const first = await post('/party-identifiers', carol, {
      partyId: a.id,
      type: 'falcon_id',
      value: 'FX-100200',
      validFrom: '2026-01-01',
    });
    expect(first.status).toBe(201);
    expect(body(first).valuePlain).toBe('FX100200');
    const clash = await post('/party-identifiers', carol, {
      partyId: b.id,
      type: 'falcon_id',
      value: 'fx 100200',
      validFrom: '2026-03-01',
    });
    expect(clash.status).toBe(409);
    expect(codeOf(clash)).toBe('identifier_in_use');
    // The id moves: the first holder's period ends, the second starts afterwards.
    const ended = await patch(`/party-identifiers/${body(first).id}`, carol, 1, {
      validTo: '2026-02-28',
    });
    expect(ended.status).toBe(200);
    const moved = await post('/party-identifiers', carol, {
      partyId: b.id,
      type: 'falcon_id',
      value: 'FX100200',
      validFrom: '2026-03-01',
    });
    expect(moved.status).toBe(201);
    const asOf = await get(
      '/party-identifiers/lookup?type=falcon_id&value=FX100200&asOf=2026-02-01',
      carol,
    );
    expect((asOf.body as { items: { partyId: string }[] }).items.map((i) => i.partyId)).toEqual([
      a.id,
    ]);
  });
});

describe('bank accounts', () => {
  it('needs a second person, and any change sends it back to pending', async () => {
    const party = await newParty(carol, 'Payee Person');
    const created = await post('/party-bank-accounts', carol, {
      partyId: party.id,
      kind: 'bank',
      bankName: 'Synthetic Bank',
      number: 'QA00 TEST 0000 1234 5678 9012 3',
      accountName: 'Payee Person',
    });
    expect(created.status).toBe(201);
    const account = body(created);
    expect(account.status).toBe('pending');
    expect(account.numberMasked).toBe('*'.repeat(21) + '0123');
    expect(JSON.stringify(created.body)).not.toContain('00001234');

    // The requester cannot approve their own request.
    const self = await postIf(`/party-bank-accounts/${account.id}/approve`, carol, 1);
    expect(self.status).toBe(403);
    // Another person can.
    const ok = await postIf(`/party-bank-accounts/${account.id}/approve`, alice, 1);
    expect(ok.status).toBe(200);
    expect(body(ok).status).toBe('verified');
    expect(body(ok).approvedBy).toBe(f.userA);

    // Changing the number takes the approval away.
    const changed = await patch(`/party-bank-accounts/${account.id}`, carol, body(ok).version, {
      number: 'QA00 TEST 0000 9999 8888 7777 6',
    });
    expect(changed.status).toBe(200);
    expect(body(changed).status).toBe('pending');
    expect(body(changed).approvedBy).toBeNull();
    expect(body(changed).requestedBy).toBe(ids.carol);
    // Typing the same details again changes nothing.
    const same = await patch(`/party-bank-accounts/${account.id}`, carol, body(changed).version, {
      accountName: 'Payee Person',
    });
    expect(body(same).version).toBe(body(changed).version);

    const reveal = await post(`/party-bank-accounts/${account.id}/reveal`, alice);
    expect((reveal.body as { value: string }).value).toBe('QA00TEST0000999988887777' + '6');
  });

  it('wants the proof checked before approval, and the database refuses a self-approval', async () => {
    const party = await newParty(carol, 'Proof Person');
    const proof = await uploadFile(carol);
    const created = body(
      await post('/party-bank-accounts', carol, {
        partyId: party.id,
        kind: 'wallet',
        walletProvider: 'Synthetic Wallet',
        number: '+97455550000',
        accountName: 'Proof Person',
        proofFileId: proof.id,
      }),
    );
    const early = await postIf(`/party-bank-accounts/${created.id}/approve`, alice, 1);
    expect(early.status).toBe(422);
    expect(codeOf(early)).toBe('proof_not_checked');
    const checked = await postIf(`/party-bank-accounts/${created.id}/verify`, alice, 1);
    expect(checked.status).toBe(200);
    const approved = await postIf(`/party-bank-accounts/${created.id}/approve`, alice, 2);
    expect(approved.status).toBe(200);

    // Even raw SQL cannot make the requester the approver.
    await expect(
      owner.query(`UPDATE party.party_bank_account SET approved_by = requested_by WHERE id = $1`, [
        created.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('duplicates and merge', () => {
  it('flags a likely duplicate, and a dismissed pair stays dismissed', async () => {
    const a = await newParty(carol, 'Mohammed Abdullah Rahman', { dateOfBirth: '1988-02-02' });
    const b = await newParty(carol, 'Mohamed Abdullah Rahman', { dateOfBirth: '1988-02-02' });
    const list = await get(`/party-duplicates?partyId=${a.id}`, carol);
    const items = (list.body as { items: (Body & { score: number })[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.score).toBeGreaterThanOrEqual(0.9);
    expect(
      (await post(`/party-duplicates/${items[0]?.id ?? ''}/dismiss`, carol, { version: 1 })).status,
    ).toBe(403);
    const dismissed = await post(`/party-duplicates/${items[0]?.id ?? ''}/dismiss`, alice, {
      version: 1,
    });
    expect(dismissed.status).toBe(204);
    await post(`/parties/${b.id}/detect-duplicates`, alice);
    const after = await get(`/party-duplicates?partyId=${a.id}`, carol);
    expect((after.body as { items: unknown[] }).items).toHaveLength(0);
  });

  it('flags a shared phone number', async () => {
    const a = await newParty(carol, 'Zaid Karim Nasser');
    await post('/party-contacts', carol, { partyId: a.id, kind: 'phone', value: '+97450001111' });
    const b = await newParty(carol, 'Completely Different Name');
    await post('/party-contacts', carol, { partyId: b.id, kind: 'phone', value: '+97450001111' });
    await post(`/parties/${b.id}/detect-duplicates`, alice);
    const list = await get(`/party-duplicates?partyId=${b.id}`, carol);
    const found = (list.body as { items: { reasons: { code: string }[] }[] }).items;
    expect(found[0]?.reasons.map((r) => r.code)).toContain('same_contact');
  });

  it('merges one party into another, keeps history, and cannot be repeated or undone', async () => {
    const survivor = await newParty(alice, 'Survivor Person', { dateOfBirth: null });
    const merged = await newParty(alice, 'Merged Person', {
      dateOfBirth: '1991-05-05',
      gender: 'male',
    });
    await post('/party-contacts', alice, {
      partyId: merged.id,
      kind: 'phone',
      value: '+97460001111',
      isPrimary: true,
    });
    await post('/party-contacts', alice, {
      partyId: survivor.id,
      kind: 'phone',
      value: '+97460002222',
      isPrimary: true,
    });
    await post('/party-roles', alice, {
      partyId: merged.id,
      roleType: 'driver',
      validFrom: '2026-01-01',
    });
    await post('/party-identifiers', alice, {
      partyId: merged.id,
      type: 'passport',
      value: 'P1234567',
    });
    await post('/party-bank-accounts', alice, {
      partyId: merged.id,
      kind: 'bank',
      number: 'QA11 TEST 0000 4444',
      accountName: 'Merged Person',
    });
    const userId = randomUUID();
    await addUser(userId, f.tenantA, `login-${userId.slice(0, 8)}`);
    await owner.query(`UPDATE iam.user_account SET party_id = $1 WHERE id = $2`, [
      merged.id,
      userId,
    ]);
    const file = await uploadFile(alice);
    const attached = await post('/attachments', alice, {
      entityType: 'party.party',
      entityId: merged.id,
      fileObjectId: file.id,
      purpose: 'photo',
    });
    expect(attached.status).toBe(201);

    const payload = { survivorId: survivor.id, mergedId: merged.id };
    expect((await post('/party-merges/preview', carol, payload)).status).toBe(403);
    const preview = await post('/party-merges/preview', alice, payload);
    expect(preview.status).toBe(200);
    const counts = preview.body as {
      moves: Record<string, number>;
      references: Record<string, number>;
    };
    expect(counts.moves).toMatchObject({ roles: 1, identifiers: 1, contacts: 1, bankAccounts: 1 });
    expect(counts.references).toEqual({ 'Login accounts': 1, 'Attached files': 1 });

    expect((await post('/party-merges', alice, { ...payload, reason: 'x' })).status).toBe(400);
    const done = await post('/party-merges', alice, {
      ...payload,
      reason: 'Same person, checked QID',
    });
    expect(done.status).toBe(201);

    // The survivor now holds everything; the merged party is gone from view but kept.
    expect((await get(`/parties/${merged.id}`, alice)).status).toBe(404);
    const survivorNow = await get(`/parties/${survivor.id}`, alice);
    expect(body(survivorNow).dateOfBirth).toBe('1991-05-05');
    const contacts = await get(`/party-contacts?partyId=${survivor.id}`, alice);
    const phones = (contacts.body as { items: { value: string; isPrimary: boolean }[] }).items;
    expect(phones.map((c) => c.value).sort()).toEqual(['+97460001111', '+97460002222']);
    // The survivor's own primary phone was not displaced.
    expect(phones.find((c) => c.isPrimary)?.value).toBe('+97460002222');
    const login = await owner.query<{ party_id: string }>(
      `SELECT party_id FROM iam.user_account WHERE id = $1`,
      [userId],
    );
    expect(login.rows[0]?.party_id).toBe(survivor.id);
    const attachments = await get(
      `/attachments?entityType=party.party&entityId=${survivor.id}`,
      alice,
    );
    expect((attachments.body as { items: unknown[] }).items).toHaveLength(1);
    const record = await owner.query<{ snapshot: { party: { displayName: string } } }>(
      `SELECT snapshot FROM party.party_merge WHERE merged_id = $1`,
      [merged.id],
    );
    expect(record.rows[0]?.snapshot.party.displayName).toBe('Merged Person');
    const snapshotText = JSON.stringify(record.rows[0]?.snapshot);
    expect(snapshotText).not.toContain('P1234567');
    const event = await owner.query(
      `SELECT 1 FROM audit.audit_log WHERE entity_id = $1 AND action = 'merge'`,
      [survivor.id],
    );
    expect(event.rowCount).toBe(1);

    // Repeating the merge, or restoring the merged party from the recycle bin, is refused.
    expect((await post('/party-merges', alice, { ...payload, reason: 'again' })).status).toBe(404);
    const restore = await postIf(`/parties/${merged.id}/restore`, alice, 4);
    expect(restore.status).toBe(409);
    expect(codeOf(restore)).toBe('merged_party');
    // The merge record is insert-only.
    await expect(
      owner.query(`DELETE FROM party.party_merge WHERE merged_id = $1`, [merged.id]),
    ).rejects.toBeDefined();
  });

  it('refuses to merge a person with an organisation, or a party with itself', async () => {
    const person = await newParty(alice, 'Some Person');
    const company = await newParty(alice, 'Some Trading Company', {}, 'organisation');
    const kinds = await post('/party-merges/preview', alice, {
      survivorId: person.id,
      mergedId: company.id,
    });
    expect(kinds.status).toBe(422);
    expect(codeOf(kinds)).toBe('different_kind');
    const self = await post('/party-merges/preview', alice, {
      survivorId: person.id,
      mergedId: person.id,
    });
    expect(codeOf(self)).toBe('same_party');
  });
});

describe('files', () => {
  it('accepts a stored file that matches its promise, once', async () => {
    const file = await uploadFile(carol);
    expect(file.sizeBytes).toBe(PDF.length);
    expect(file.sha256).toBe(sha(PDF));
    const rows = await owner.query(`SELECT 1 FROM files.file_object WHERE id = $1`, [file.id]);
    expect(rows.rowCount).toBe(1);
    // Rows are immutable.
    await expect(
      owner.query(`UPDATE files.file_object SET original_name = 'x' WHERE id = $1`, [file.id]),
    ).rejects.toBeDefined();
  });

  it('refuses a file that is missing, altered, mislabelled, forged or not allowed', async () => {
    const declare = (bytes: Buffer, mime = 'application/pdf') =>
      post('/files/upload-url', carol, {
        originalName: 'x.pdf',
        mimeType: mime,
        sizeBytes: bytes.length,
        sha256: sha(bytes),
      });
    const keyOf = (url: string) => url.replace('memory://upload/', '').split('?')[0] ?? '';

    const missing = (await declare(PDF)).body as { uploadToken: string };
    const m = await post('/files/complete', carol, { uploadToken: missing.uploadToken });
    expect(codeOf(m)).toBe('upload_missing');

    const other = Buffer.concat([
      Buffer.from('%PDF-1.7\n'),
      Buffer.from('synthetic test DOCUMENT'),
    ]);
    const altered = (await declare(PDF)).body as { uploadToken: string; url: string };
    storage.put(keyOf(altered.url), other);
    expect(codeOf(await post('/files/complete', carol, { uploadToken: altered.uploadToken }))).toBe(
      'checksum_mismatch',
    );

    const exe = Buffer.from('MZ-this-is-not-a-pdf-at-all');
    const fake = (await declare(exe)).body as { uploadToken: string; url: string };
    storage.put(keyOf(fake.url), exe);
    expect(codeOf(await post('/files/complete', carol, { uploadToken: fake.uploadToken }))).toBe(
      'type_mismatch',
    );

    expect(
      codeOf(
        await post('/files/complete', carol, {
          uploadToken: `${'a'.repeat(30)}.${'b'.repeat(30)}`,
        }),
      ),
    ).toBe('invalid_upload_token');
    // A token cannot be used by someone else.
    const mine = (await declare(PDF)).body as { uploadToken: string; url: string };
    storage.put(keyOf(mine.url), PDF);
    expect(codeOf(await post('/files/complete', alice, { uploadToken: mine.uploadToken }))).toBe(
      'invalid_upload_token',
    );

    expect((await declare(PDF, 'application/x-msdownload')).status).toBe(400);
    const big = await post('/files/upload-url', carol, {
      originalName: 'big.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 5 * 1024 * 1024,
      sha256: sha(PDF),
    });
    expect(big.status).toBe(400);
  });

  it('attaches files to a party, keeps versions in a straight line, and follows record permissions', async () => {
    const party = await newParty(carol, 'Document Person');
    const v1 = await uploadFile(carol);
    const attached = await post('/attachments', carol, {
      entityType: 'party.party',
      entityId: party.id,
      fileObjectId: v1.id,
      purpose: 'document_page',
      label: 'Contract',
    });
    expect(attached.status).toBe(201);
    const first = body(attached);

    // Dave may read the party, so he may see its files; he may not add any.
    expect(
      (await get(`/attachments?entityType=party.party&entityId=${party.id}`, dave)).status,
    ).toBe(200);
    expect(
      (
        await post('/attachments', dave, {
          entityType: 'party.party',
          entityId: party.id,
          fileObjectId: v1.id,
          purpose: 'document_page',
        })
      ).status,
    ).toBe(403);
    // Unknown record types and other tenants' records are refused.
    expect(
      (
        await post('/attachments', carol, {
          entityType: 'iam.role',
          entityId: party.id,
          fileObjectId: v1.id,
          purpose: 'document_page',
        })
      ).status,
    ).toBe(400);
    const foreign = await get(`/attachments?entityType=party.party&entityId=${party.id}`, bob);
    expect((foreign.body as { items: unknown[] }).items).toHaveLength(0);

    const v2file = await uploadFile(
      carol,
      Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('second edition')]),
    );
    const v2 = await post(`/attachments/${first.id}/versions`, carol, { fileObjectId: v2file.id });
    expect(v2.status).toBe(201);
    expect(body(v2).versionNo).toBe(2);
    expect(body(v2).supersedesId).toBe(first.id);
    expect(body(v2).label).toBe('Contract');
    // Only the latest version is listed; replacing an old version is refused.
    const listed = await get(`/attachments?entityType=party.party&entityId=${party.id}`, carol);
    expect((listed.body as { items: Body[] }).items.map((a) => a.id)).toEqual([body(v2).id]);
    const stale = await post(`/attachments/${first.id}/versions`, carol, {
      fileObjectId: v2file.id,
    });
    expect(stale.status).toBe(409);
    const chain = await get(`/attachments/${body(v2).id}/versions`, dave);
    expect(
      (chain.body as { items: { versionNo: number }[] }).items.map((a) => a.versionNo),
    ).toEqual([1, 2]);
  });

  it('gives download addresses only to people who may see the record, and audits them', async () => {
    const party = await newParty(carol, 'Download Person');
    const file = await uploadFile(carol);
    // Not attached anywhere: only the uploader.
    expect((await get(`/files/${file.id}/download-url`, carol)).status).toBe(200);
    expect((await get(`/files/${file.id}/download-url`, dave)).status).toBe(404);
    await post('/attachments', carol, {
      entityType: 'party.party',
      entityId: party.id,
      fileObjectId: file.id,
      purpose: 'photo',
    });
    const viaRecord = await get(`/files/${file.id}/download-url`, dave);
    expect(viaRecord.status).toBe(200);
    expect((viaRecord.body as { url: string }).url).toContain('memory://download/');
    expect((await get(`/files/${file.id}/download-url`, bob)).status).toBe(404);
    const audited = await owner.query(
      `SELECT 1 FROM audit.audit_log WHERE entity_id = $1 AND action = 'download'`,
      [file.id],
    );
    expect(audited.rowCount).toBeGreaterThanOrEqual(2);
  });

  it('keeps raw inputs, insert-only', async () => {
    const context = { tenantId: f.tenantA, companyIds: [f.companyA1], userId: f.userA };
    const raw = await uow.runAs(context, () =>
      files.recordRawInput({
        kind: 'webhook',
        source: 'synthetic-provider',
        sha256: sha(Buffer.from('payload')),
        meta: { event: 'test' },
      }),
    );
    const row = await owner.query<{ kind: string }>(
      `SELECT kind FROM files.raw_input WHERE id = $1`,
      [raw.id],
    );
    expect(row.rows[0]?.kind).toBe('webhook');
    await expect(
      owner.query(`UPDATE files.raw_input SET source = 'x' WHERE id = $1`, [raw.id]),
    ).rejects.toBeDefined();
  });
});
