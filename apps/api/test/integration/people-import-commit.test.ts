/**
 * Row 3.14: the employee import committed the way the app does it. The commit runs in the
 * import queue's worker, which has no HTTP request; row 3.13 made the employee target move
 * the status through the state machine, whose permission check read the request context and
 * failed with "No request context: called outside a request". The earlier tests missed it
 * because they stub the permission service and call the target directly.
 *
 * This test uses the real app, the real permission service, the real import routes
 * (create the job, preview, commit) and the real BullMQ worker, then checks the employees,
 * their Falcon IDs and statuses, and that the audit rows name the user who started the
 * import. Everything is invented: tenant A, company A1, user alice (super admin).
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { MemoryStorageAdapter } from '../../src/adapters/storage/memory.js';
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
import { NotFoundError } from '../../src/kernel/http/errors.js';
import { ExportService } from '../../src/kernel/imports/export-service.js';
import { ImportQueue } from '../../src/kernel/imports/import-queue.js';
import { createImportRouter } from '../../src/kernel/imports/import-router.js';
import { ImportService } from '../../src/kernel/imports/import-service.js';
import { ImportTargets } from '../../src/kernel/imports/import-targets.js';
import { ModuleRegistry } from '../../src/kernel/module-registry/index.js';
import { NumberingService } from '../../src/kernel/numbering/numbering-service.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import {
  KERNEL_PERMISSIONS,
  syncPermissionCatalogue,
} from '../../src/kernel/permissions/catalogue.js';
import { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import { StateService, StateTargets } from '../../src/kernel/states/state-service.js';
import { AttachableRegistry } from '../../src/modules/files/index.js';
import {
  PARTY_PERMISSIONS,
  PartyReferenceRegistry,
  PartyService,
  PartyVault,
  createPartyModule,
} from '../../src/modules/party/index.js';
import {
  EMPLOYEE_ENTITY,
  PEOPLE_PERMISSIONS,
  createPeopleModule,
  seedEmployeeStatus,
} from '../../src/modules/people/index.js';
import { seedClientPlatforms } from '../../src/modules/performance/platform-seed.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-3-14';

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let queue: ImportQueue;
let storage: MemoryStorageAdapter;
let alice: string;
const roleId = randomUUID();

type Json = Record<string, unknown>;
const auth = (req: request.Test) => req.set('Authorization', `Bearer ${alice}`);
const get = (path: string) => auth(request(app).get(`${API_PREFIX}${path}`));
const post = (path: string, body: Json = {}) =>
  auth(request(app).post(`${API_PREFIX}${path}`))
    .set('Idempotency-Key', randomUUID())
    .send(body);

beforeAll(async () => {
  owner = await connect('owner');
  f = await createFixture(owner);
  const db = testDatabase();
  pool = createPool(connectionUrl(db, db.app), 4);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-people-import-commit');
  const prisma = createPrisma(pool);
  await syncPermissionCatalogue(prisma, [
    ...KERNEL_PERMISSIONS,
    ...PARTY_PERMISSIONS,
    ...PEOPLE_PERMISSIONS,
  ]);
  const slug =
    (
      await owner.query<{ slug: string }>(`SELECT slug FROM platform.tenant WHERE id = $1`, [
        f.tenantA,
      ])
    ).rows[0]?.slug ?? '';

  // alice: super admin in company A1 (every permission, so the real checks pass).
  await owner.query(
    `INSERT INTO iam.role (id, tenant_id, key, name, is_builtin)
     VALUES ($1, $2, 'super_admin', 'Super Admin', true)`,
    [roleId, f.tenantA],
  );
  await owner.query(
    `INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
     SELECT $1, $2, id FROM iam.permission`,
    [f.tenantA, roleId],
  );
  await owner.query(
    `INSERT INTO iam.user_account (id, tenant_id, username, display_name, must_change_password)
     VALUES ($1, $2, 'alice', 'alice test', false)
     ON CONFLICT (id) DO UPDATE SET must_change_password = false`,
    [f.userA, f.tenantA],
  );
  await owner.query(
    `INSERT INTO iam.credential (tenant_id, user_id, kind, hash) VALUES ($1, $2, 'password', $3)`,
    [f.tenantA, f.userA, await hashPassword(PASSWORD)],
  );
  const membershipId = randomUUID();
  await owner.query(
    `INSERT INTO iam.company_membership (id, tenant_id, user_id, company_id, is_default)
     VALUES ($1, $2, $3, $4, true)`,
    [membershipId, f.tenantA, f.userA, f.companyA1],
  );
  await owner.query(
    `INSERT INTO iam.membership_role (tenant_id, membership_id, role_id) VALUES ($1, $2, $3)`,
    [f.tenantA, membershipId, roleId],
  );
  await seedEmployeeStatus(owner, f.tenantA);
  await seedClientPlatforms(owner, f.tenantA, f.companyA1);

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
  const stateTargets = new StateTargets(() => {
    throw new Error('no custom records in this test');
  });
  const states = new StateService({ permissions, targets: stateTargets });
  storage = new MemoryStorageAdapter();
  const importTargets = new ImportTargets(() => Promise.reject(new NotFoundError()));
  const importService = new ImportService({ uow, storage, permissions, targets: importTargets });
  queue = new ImportQueue({ redisUrl: inject('redisUrl'), service: importService, logger });
  // The real worker: the commit runs from the queue, as in main.ts.
  queue.startWorker();

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
        attachables: new AttachableRegistry(),
        states,
        importTargets,
      });
      stateTargets.register(EMPLOYEE_ENTITY, people.employeeStateTarget);
      modules.register(people.manifest);
      modules.mount(api);
      api.use(
        createImportRouter({
          uow,
          registry,
          permissions,
          service: importService,
          exports: new ExportService({ storage, permissions, targets: importTargets }),
          queue,
          targets: importTargets,
        }),
      );
    },
  });

  const login = await request(app)
    .post(`${API_PREFIX}/auth/login`)
    .send({ tenant: slug, identifier: 'alice', password: PASSWORD });
  expect(login.status).toBe(200);
  alice = (login.body as { accessToken: string }).accessToken;
});

afterAll(async () => {
  await queue.close();
  const counters = await redis.keys('rl:*');
  if (counters.length > 0) await redis.del(...counters);
  await redis.quit();
  await pool.end();
  await owner.end();
});

/** Puts a CSV in storage and a file_object row for it, as the signed upload would. */
async function upload(csv: string): Promise<string> {
  const bytes = Buffer.from(csv, 'utf8');
  const key = `${f.tenantA}/${f.companyA1}/test/${randomUUID()}`;
  storage.put(key, bytes);
  const row = await owner.query<{ id: string }>(
    `INSERT INTO files.file_object (tenant_id, company_id, bucket, object_key, sha256, size_bytes, mime_type, original_name)
     VALUES ($1, $2, 'memory', $3, $4, $5, 'text/csv', 'employees.csv') RETURNING id`,
    [f.tenantA, f.companyA1, key, createHash('sha256').update(bytes).digest('hex'), bytes.length],
  );
  return row.rows[0]?.id ?? '';
}

describe('employee import committed by the queue worker (row 3.14)', () => {
  it('imports Falcon IDs and statuses and audits the user who started it', async () => {
    const csv = [
      'Name,QID,Falcon ID,Status',
      'Commit Active,29100001401,FC1401,active',
      'Commit Blocked,29100001402,FC1402,blocked',
      'Commit NoFalcon,29100001403,,',
      '',
    ].join('\n');
    const fileObjectId = await upload(csv);

    const created = await post('/imports', { entityKey: 'people.employee', fileObjectId });
    expect(created.status).toBe(201);
    const jobId = (created.body as { id: string }).id;

    const previewed = await post(`/imports/${jobId}/preview`, {
      mapping: {
        columnMap: {
          display_name: 'Name',
          qid: 'QID',
          falcon_id: 'Falcon ID',
          status: 'Status',
        },
        transforms: {},
      },
    });
    expect(previewed.status).toBe(200);
    expect(previewed.body).toMatchObject({ stats: { valid: 3, invalid: 0 } });

    const commit = await post(`/imports/${jobId}/commit`, {});
    expect(commit.status).toBe(202);

    // The worker commits in the background: wait for the job to leave `queued`.
    let job: { status: string; stats: { error?: string; created?: number } } = {
      status: 'queued',
      stats: {},
    };
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && ['queued', 'previewed'].includes(job.status)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = (await get(`/imports/${jobId}`)).body as typeof job;
    }
    expect(job.stats.error ?? null).toBeNull();
    expect(job.status).toBe('committed');
    expect(job.stats.created).toBe(3);

    const rows = await owner.query<{
      id: string;
      display_name: string;
      status_code: string;
      falcon: string | null;
      platform: string | null;
    }>(
      `SELECT e.id, p.display_name, e.status_code,
              i.value_plain AS falcon, cp.code AS platform
         FROM people.employee e
         JOIN party.party p ON p.id = e.party_id
         LEFT JOIN party.party_identifier i
                ON i.party_id = e.party_id AND i.type = 'falcon_id' AND i.deleted_at IS NULL
         LEFT JOIN performance.client_platform cp ON cp.id = i.client_platform_id
        WHERE e.company_id = $1 AND p.display_name LIKE 'Commit %' AND e.deleted_at IS NULL
        ORDER BY p.display_name`,
      [f.companyA1],
    );
    expect(
      rows.rows.map(({ display_name, status_code, falcon, platform }) => ({
        display_name,
        status_code,
        falcon,
        platform,
      })),
    ).toEqual([
      {
        display_name: 'Commit Active',
        status_code: 'active',
        falcon: 'FC1401',
        platform: 'snoonu',
      },
      {
        display_name: 'Commit Blocked',
        status_code: 'blocked',
        falcon: 'FC1402',
        platform: 'snoonu',
      },
      { display_name: 'Commit NoFalcon', status_code: 'active', falcon: null, platform: null },
    ]);

    // The blocked move is a normal audited state change with the note "Imported".
    const blocked = rows.rows.find((r) => r.display_name === 'Commit Blocked');
    const history = await owner.query<{ to_code: string; note: string | null }>(
      `SELECT to_code, note FROM cfg.state_history WHERE entity_id = $1 ORDER BY id`,
      [blocked?.id],
    );
    expect(history.rows.at(-1)).toEqual({ to_code: 'blocked', note: 'Imported' });

    // Every audit row written by the background commit names the user who started it.
    const ids = rows.rows.map((r) => r.id);
    const audited = await owner.query<{ user_id: string | null; n: string }>(
      `SELECT user_id, count(*) AS n FROM audit.audit_log
        WHERE entity_id = ANY ($1::uuid[]) GROUP BY user_id`,
      [ids],
    );
    expect(audited.rows.length).toBeGreaterThan(0);
    expect(audited.rows.every((r) => r.user_id === f.userA)).toBe(true);
  }, 40_000);
});
