/**
 * Templates (phase 2 row 2.7a) against real PostgreSQL and Redis: template and version CRUD,
 * numbering, draft/publish/frozen rules, preview, resolution by language/company/date, safe
 * rendering, append-only generated_document.
 *
 * People (all invented), tenant A, company A1: alice super_admin, dave "user" with no
 * permissions.
 */
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
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
  createTemplateRepository,
  createTemplateRouter,
  createTemplateVersionRepository,
} from '../../src/kernel/templates/template-router.js';
import { TemplateService } from '../../src/kernel/templates/template-service.js';
import { syncPermissionCatalogue } from '../../src/kernel/permissions/catalogue.js';
import { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-tpl-1';

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let uow: UnitOfWork;
const templates = new TemplateService();
let slugA = '';
const ids = { dave: randomUUID(), superAdmin: randomUUID(), user: randomUUID() };

type Json = Record<string, unknown>;
const auth = (req: request.Test, token: string) => req.set('Authorization', `Bearer ${token}`);
const get = (path: string, token: string) => auth(request(app).get(`${API_PREFIX}${path}`), token);
const post = (path: string, token: string, body: Json = {}) =>
  auth(request(app).post(`${API_PREFIX}${path}`), token)
    .set('Idempotency-Key', randomUUID())
    .send(body);
const patch = (path: string, token: string, version: number, body: Json) =>
  auth(request(app).patch(`${API_PREFIX}${path}`), token)
    .set('Idempotency-Key', randomUUID())
    .set('If-Match', `"${String(version)}"`)
    .send(body);
const del = (path: string, token: string, version: number) =>
  auth(request(app).delete(`${API_PREFIX}${path}`), token)
    .set('Idempotency-Key', randomUUID())
    .set('If-Match', `"${String(version)}"`)
    .send({ reason: 'test clean-up' });

async function signIn(identifier: string): Promise<string> {
  const res = await request(app)
    .post(`${API_PREFIX}/auth/login`)
    .send({ tenant: slugA, identifier, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.body as { accessToken: string }).accessToken;
}

async function addUser(id: string, username: string, roleId: string) {
  await owner.query(
    `INSERT INTO iam.user_account (id, tenant_id, username, display_name, must_change_password)
     VALUES ($1, $2, $3, $4, false)
     ON CONFLICT (id) DO UPDATE SET must_change_password = false`,
    [id, f.tenantA, username, `${username} test`],
  );
  await owner.query(
    `INSERT INTO iam.credential (tenant_id, user_id, kind, hash) VALUES ($1, $2, 'password', $3)`,
    [f.tenantA, id, await hashPassword(PASSWORD)],
  );
  const membershipId = randomUUID();
  await owner.query(
    `INSERT INTO iam.company_membership (id, tenant_id, user_id, company_id, is_default)
     VALUES ($1, $2, $3, $4, true)`,
    [membershipId, f.tenantA, id, f.companyA1],
  );
  await owner.query(
    `INSERT INTO iam.membership_role (tenant_id, membership_id, role_id) VALUES ($1, $2, $3)`,
    [f.tenantA, membershipId, roleId],
  );
}

beforeAll(async () => {
  owner = await connect('owner');
  f = await createFixture(owner);
  const db = testDatabase();
  // Six connections so the concurrency test really runs transactions side by side.
  pool = createPool(connectionUrl(db, db.app), 6);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-templates');
  const prisma = createPrisma(pool);
  await syncPermissionCatalogue(prisma);
  const slug = await owner.query<{ slug: string }>(
    `SELECT slug FROM platform.tenant WHERE id = $1`,
    [f.tenantA],
  );
  slugA = slug.rows[0]?.slug ?? '';

  await owner.query(
    `INSERT INTO iam.role (id, tenant_id, key, name, is_builtin) VALUES
       ($1, $3, 'super_admin', 'Super Admin', true), ($2, $3, 'user', 'User', true)`,
    [ids.superAdmin, ids.user, f.tenantA],
  );
  await owner.query(
    `INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
     SELECT $1, $2, id FROM iam.permission`,
    [f.tenantA, ids.superAdmin],
  );
  await addUser(f.userA, 'alice', ids.superAdmin);
  await addUser(ids.dave, 'dave', ids.user);

  const env = loadEnv({
    DATABASE_URL: 'postgresql://unused@localhost:1/x',
    REDIS_URL: 'redis://localhost:1',
    ...TEST_AUTH_ENV,
    RATE_LIMIT_ANONYMOUS: '10000',
    RATE_LIMIT_AUTHENTICATED: '10000',
    AUTH_RATE_LIMIT: '10000',
    WEB_BASE_URL: 'https://app.example.test',
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
  const recycleBin = new RecycleBin();
  recycleBin.register({
    entityType: 'platform.template',
    moduleKey: 'platform',
    label: 'Template',
    repository: createTemplateRepository(),
    describe: (t) => t.key,
  });
  recycleBin.register({
    entityType: 'platform.template_version',
    moduleKey: 'platform',
    label: 'Template version',
    repository: createTemplateVersionRepository(),
    describe: (v) => String(v.versionNo),
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
      api.use(createTemplateRouter({ uow, registry, permissions }));
      api.use(
        createAuditRouter({
          uow,
          registry,
          authorize: permissions.authorize,
          audit: createAuditService(),
          recycleBin,
        }),
      );
    },
  });
});

afterAll(async () => {
  const counters = await redis.keys('rl:*');
  if (counters.length > 0) await redis.del(...counters);
  await redis.quit();
  await pool.end();
  await owner.end();
});

interface TemplateItem {
  id: string;
  key: string;
  kind: string;
  version: number;
}
interface VersionItem {
  id: string;
  versionNo: number;
  status: string;
  language: string;
  companyId: string | null;
  version: number;
}
interface Problem {
  code: string;
}

const unique = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8).replaceAll('-', '')}`;
const asAlice = () => ({
  tenantId: f.tenantA,
  companyIds: [f.companyA1, f.companyA2],
  userId: f.userA,
});

async function makeTemplate(token: string, kind = 'pdf'): Promise<TemplateItem> {
  const res = await post('/templates', token, { key: unique('doc'), kind, name: 'Test letter' });
  expect(res.status).toBe(201);
  return res.body as TemplateItem;
}
const makeVersion = (token: string, templateId: string, extra: Json = {}) =>
  post('/template-versions', token, {
    templateId,
    language: 'en',
    subject: 'Hello {{name}}',
    body: '<p>Dear {{name}}</p>',
    ...extra,
  });
const publish = (token: string, v: VersionItem) =>
  post(`/template-versions/${v.id}/publish`, token).set('If-Match', `"${String(v.version)}"`);

describe('templates API', () => {
  it('creates templates and numbers versions per language', async () => {
    const alice = await signIn('alice');
    const t = await makeTemplate(alice);
    const v1 = (await makeVersion(alice, t.id)).body as VersionItem;
    const v2 = (await makeVersion(alice, t.id)).body as VersionItem;
    const bn = (await makeVersion(alice, t.id, { language: 'bn' })).body as VersionItem;
    expect([v1.versionNo, v2.versionNo, bn.versionNo]).toEqual([1, 2, 1]);
    expect(v1.status).toBe('draft');
    const dup = await post('/templates', alice, { key: t.key, kind: 'pdf', name: 'Again' });
    expect(dup.status).toBe(409);
  });

  it('refuses broken syntax and a CSS that closes the style element', async () => {
    const alice = await signIn('alice');
    const t = await makeTemplate(alice);
    const bad = await makeVersion(alice, t.id, { body: '{{#if}}oops' });
    expect(bad.status).toBe(400);
    const css = await makeVersion(alice, t.id, { css: 'a{}</style><script>x</script>' });
    expect(css.status).toBe(400);
  });

  it('publishes a draft, freezes it and retires the one it replaces', async () => {
    const alice = await signIn('alice');
    const t = await makeTemplate(alice);
    const v1 = (await makeVersion(alice, t.id)).body as VersionItem;
    const p1 = (await publish(alice, v1)).body as VersionItem;
    expect(p1.status).toBe('published');
    const frozen = await patch(`/template-versions/${v1.id}`, alice, p1.version, { body: 'x' });
    expect(frozen.status).toBe(422);
    expect((frozen.body as Problem).code).toBe('template_version_frozen');
    expect((await del(`/template-versions/${v1.id}`, alice, p1.version)).status).toBe(422);
    const v2 = (await makeVersion(alice, t.id, { body: '<p>Hi {{name}}</p>' })).body as VersionItem;
    expect((await publish(alice, v2)).status).toBe(200);
    const old = (await get(`/template-versions/${v1.id}`, alice)).body as VersionItem;
    expect(old.status).toBe('retired');
    // Only a draft can be published; a template with live versions cannot be deleted.
    const again = (await get(`/template-versions/${v2.id}`, alice)).body as VersionItem;
    expect((await publish(alice, again)).status).toBe(422);
    const full = (await get(`/templates/${t.id}`, alice)).body as TemplateItem;
    expect((await del(`/templates/${t.id}`, alice, full.version)).status).toBe(409);
  });

  it('previews with sample data and escapes merge values in HTML kinds', async () => {
    const alice = await signIn('alice');
    const t = await makeTemplate(alice);
    const v = (await makeVersion(alice, t.id, { css: 'p{color:red}', paper: 'A5' }))
      .body as VersionItem;
    const res = await post(`/template-versions/${v.id}/preview`, alice, {
      data: { name: '<b>Ali</b>' },
    });
    expect(res.status).toBe(200);
    const out = res.body as { subject: string; body: string; html: string };
    expect(out.body).toBe('<p>Dear &lt;b&gt;Ali&lt;/b&gt;</p>');
    expect(out.subject).toBe('Hello <b>Ali</b>');
    expect(out.html).toContain('size: A5');
    expect(out.html).toContain('p{color:red}');
  });

  it('does not let a template reach prototypes or partials', async () => {
    const alice = await signIn('alice');
    const t = await makeTemplate(alice, 'sms');
    const v = (
      await makeVersion(alice, t.id, {
        subject: null,
        body: '[{{constructor.name}}][{{__proto__}}]',
      })
    ).body as VersionItem;
    const res = await post(`/template-versions/${v.id}/preview`, alice, { data: {} });
    expect((res.body as { body: string }).body).toBe('[][]');
    const p = (await makeVersion(alice, t.id, { subject: null, body: '{{> secret}}' }))
      .body as VersionItem;
    const bad = await post(`/template-versions/${p.id}/preview`, alice, { data: {} });
    expect(bad.status).toBe(422);
  });

  it('needs permissions and stays inside the tenant', async () => {
    const alice = await signIn('alice');
    const dave = await signIn('dave');
    expect((await get('/templates', dave)).status).toBe(403);
    expect((await post('/templates', dave, { key: 'x', kind: 'pdf', name: 'x' })).status).toBe(403);
    const t = await makeTemplate(alice);
    const v = (await makeVersion(alice, t.id)).body as VersionItem;
    expect((await post(`/template-versions/${v.id}/preview`, dave, {})).status).toBe(403);
    const other = await owner.query(
      `INSERT INTO cfg.template (tenant_id, key, kind, name) VALUES ($1, 'foreign', 'pdf', 'F') RETURNING id`,
      [f.tenantB],
    );
    const id = (other.rows[0] as { id: string }).id;
    expect((await get(`/templates/${id}`, alice)).status).toBe(404);
  });
});

describe('template service and generated documents', () => {
  it('resolves language, company and date in the documented order', async () => {
    const alice = await signIn('alice');
    const t = await makeTemplate(alice);
    const mk = async (extra: Json) => {
      const v = (await makeVersion(alice, t.id, extra)).body as VersionItem;
      return (await publish(alice, v)).body as VersionItem;
    };
    const en = await mk({ body: 'en wide' });
    const bn = await mk({ language: 'bn', body: 'bn wide' });
    const bnCompany = await mk({ language: 'bn', companyId: f.companyA1, body: 'bn A1' });
    const future = await mk({
      language: 'bn',
      companyId: f.companyA1,
      validFrom: '2999-01-01',
      body: 'bn future',
    });
    const resolve = (language: string, companyId: string, onDate?: Date) =>
      uow.runAs(
        asAlice(),
        async () =>
          (
            await templates.resolve(t.key, {
              language,
              companyId,
              ...(onDate === undefined ? {} : { onDate }),
            })
          ).version.id,
      );
    expect(await resolve('bn', f.companyA1)).toBe(bnCompany.id);
    expect(await resolve('bn', f.companyA2)).toBe(bn.id);
    expect(await resolve('ur', f.companyA1)).toBe(en.id);
    expect(await resolve('bn', f.companyA1, new Date('3000-01-01'))).toBe(future.id);
    await expect(
      uow.runAs(asAlice(), () =>
        templates.resolve('nope.missing', { language: 'en', companyId: f.companyA1 }),
      ),
    ).rejects.toThrow(/No template/);
  });

  it('keeps generated documents insert-only', async () => {
    const alice = await signIn('alice');
    const t = await makeTemplate(alice);
    const v = (await makeVersion(alice, t.id)).body as VersionItem;
    const ins = await owner.query(
      `INSERT INTO cfg.generated_document (tenant_id, company_id, template_version_id, data_hash)
       SELECT tenant_id, $2, id, repeat('a', 64) FROM cfg.template_version WHERE id = $1 RETURNING id`,
      [v.id, f.companyA1],
    );
    const id = (ins.rows[0] as { id: string }).id;
    await expect(
      owner.query(`UPDATE cfg.generated_document SET data_hash = repeat('b', 64) WHERE id = $1`, [
        id,
      ]),
    ).rejects.toThrow(/append-only/);
  });
});
