/**
 * People, row 3.1: employees, placements and employment periods, end to end over HTTP
 * against real PostgreSQL and Redis.
 *
 * People (all invented), tenant A, company A1:
 *   alice  super_admin: every permission
 *   carol  hr clerk: employees, placements and periods, no status change
 *   dave   viewer: reads employees
 * Tenant B: bob, super_admin (isolation checks).
 *
 * Every QID, passport and phone number below is made up.
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
import { ModuleRegistry } from '../../src/kernel/module-registry/index.js';
import { NumberingService } from '../../src/kernel/numbering/numbering-service.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import {
  KERNEL_PERMISSIONS,
  syncPermissionCatalogue,
} from '../../src/kernel/permissions/catalogue.js';
import { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import { createStateRouter } from '../../src/kernel/states/state-router.js';
import { StateService, StateTargets } from '../../src/kernel/states/state-service.js';
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
import { AttachableRegistry } from '../../src/modules/files/index.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-3-1';

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
  zone: randomUUID(),
  team: randomUUID(),
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
const del = (path: string, token: string, version: number, reason?: string) =>
  auth(request(app).delete(`${API_PREFIX}${path}`), token)
    .set('Idempotency-Key', randomUUID())
    .set('If-Match', `"${String(version)}"`)
    .send(reason === undefined ? {} : { reason });
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

const crud = (resource: string) =>
  ['read', 'create', 'update', 'delete', 'restore'].map((a) => `${resource}.${a}`);

beforeAll(async () => {
  owner = await connect('owner');
  f = await createFixture(owner);
  const db = testDatabase();
  pool = createPool(connectionUrl(db, db.app), 3);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-people');
  const prisma = createPrisma(pool);
  await syncPermissionCatalogue(prisma, [
    ...KERNEL_PERMISSIONS,
    ...PARTY_PERMISSIONS,
    ...PEOPLE_PERMISSIONS,
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
    ...crud('people.employee'),
    ...crud('people.placement'),
    ...crud('people.employment_period'),
    'platform.state.read',
  ]);
  await grantKeys(f.tenantA, ids.viewer, ['people.employee.read']);

  await addUser(f.userA, f.tenantA, 'alice');
  await addUser(f.userB, f.tenantB, 'bob');
  await addUser(ids.carol, f.tenantA, 'carol');
  await addUser(ids.dave, f.tenantA, 'dave');
  await addMembership(f.tenantA, f.userA, f.companyA1, ids.superAdmin);
  await addMembership(f.tenantA, ids.carol, f.companyA1, ids.clerk);
  await addMembership(f.tenantA, ids.dave, f.companyA1, ids.viewer);
  await addMembership(f.tenantB, f.userB, f.companyB1, ids.superAdminB);

  // The employee status machine in tenant A only; tenant B shows the fallback.
  expect(await seedEmployeeStatus(owner, f.tenantA)).toBe(true);
  expect(await seedEmployeeStatus(owner, f.tenantA)).toBe(false);
  await owner.query(
    `INSERT INTO platform.org_unit (id, tenant_id, company_id, kind, code, name) VALUES
       ($1, $3, $4, 'zone', 'NORTH', 'North zone'), ($2, $3, $4, 'team', 'T1', 'Team one')`,
    [ids.zone, ids.team, f.tenantA, f.companyA1],
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
  const targets = new StateTargets(() => {
    throw new Error('no custom records in this test');
  });
  const states = new StateService({ permissions, targets });
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
        attachables: new AttachableRegistry(),
        states,
      });
      targets.register(EMPLOYEE_ENTITY, people.employeeStateTarget);
      modules.register(people.manifest);
      for (const type of modules.recycleTypes()) recycleBin.register(type);
      modules.mount(api);
      api.use(createStateRouter({ uow, registry, permissions, states }));
      api.use(
        createAuditRouter({ uow, registry, authorize: permissions.authorize, audit, recycleBin }),
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

interface Employee extends Body {
  partyId: string;
  displayName: string;
  employeeCode: string;
  statusCode: string;
  sponsorship: string;
  sponsorPartyId: string | null;
}

let seq = 0;
/** A unique made-up person: QID 2900000000N, passport TP000000N, phone +9745500000N. */
function person(name: string, extra: Json = {}): Json {
  seq += 1;
  const n = String(seq).padStart(4, '0');
  return {
    displayName: name,
    qid: `2900000${n}`,
    passport: `TP00${n}`,
    phones: [`+974 5500 ${n}`],
    ...extra,
  };
}

async function newEmployee(token: string, payload: Json): Promise<Employee> {
  const res = await post('/employees', token, payload);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Employee;
}

describe('employee create', () => {
  it('creates the person, role, contacts, sealed identifiers, code, status, period and placement in one go', async () => {
    const created = await newEmployee(carol, {
      person: person('Rahim Example', { whatsapp: '+97455009999', nationalityCode: 'BD' }),
      joiningDate: '2026-11-01',
      placement: { profession: 'rider', orgUnitId: ids.zone, teamId: ids.team },
    });
    expect(created.employeeCode).toMatch(/^E\d{4}$/);
    expect(created.statusCode).toBe('active');
    expect(created.displayName).toBe('Rahim Example');
    expect(created.sponsorship).toBe('company');

    const role = await owner.query<{ valid_from: string }>(
      `SELECT valid_from::text FROM party.party_role WHERE party_id = $1 AND role_type = 'employee'`,
      [created.partyId],
    );
    expect(role.rows[0]?.valid_from).toBe('2026-11-01');
    const contacts = await owner.query<{ kind: string; value: string; is_primary: boolean }>(
      `SELECT kind, value, is_primary FROM party.party_contact WHERE party_id = $1 ORDER BY kind`,
      [created.partyId],
    );
    expect(contacts.rows.map((c) => c.kind)).toEqual(['phone', 'whatsapp']);
    expect(contacts.rows[0]?.value).toMatch(/^\+97455\d{6}$/);

    // QID and passport: ciphertext, hash and mask only; never the plain number.
    const idRows = await owner.query<{
      type: string;
      value_plain: string | null;
      value_masked: string;
      value_encrypted: Buffer;
    }>(
      `SELECT type, value_plain, value_masked, value_encrypted FROM party.party_identifier
        WHERE party_id = $1 ORDER BY type`,
      [created.partyId],
    );
    expect(idRows.rows.map((r) => r.type)).toEqual(['passport', 'qid']);
    for (const r of idRows.rows) {
      expect(r.value_plain).toBeNull();
      expect(r.value_masked).toMatch(/^\*+\w{4}$/);
      expect(r.value_encrypted.toString('utf8')).not.toContain('2900000');
    }

    const periods = await get(`/employees/${created.id}/employment-periods`, carol);
    expect((periods.body as { items: Json[] }).items).toMatchObject([
      { startDate: '2026-11-01', endDate: null, rehireEligible: true },
    ]);
    const placements = await get(`/employees/${created.id}/placements`, carol);
    expect((placements.body as { items: Json[] }).items).toMatchObject([
      { profession: 'rider', validFrom: '2026-11-01', orgUnitId: ids.zone, teamId: ids.team },
    ]);

    // The first state history row starts with the record.
    const history = await get(`/state-history/${EMPLOYEE_ENTITY}/${created.id}`, alice);
    expect((history.body as { items: Json[] }).items).toMatchObject([
      { fromCode: null, toCode: 'active' },
    ]);
  });

  it('numbers employees E0001, E0002 ... per company', async () => {
    const a = await newEmployee(alice, { person: person('Numbered One') });
    const b = await newEmployee(alice, { person: person('Numbered Two') });
    expect(Number(b.employeeCode.slice(1))).toBe(Number(a.employeeCode.slice(1)) + 1);
    const sequence = await owner.query<{ format: string }>(
      `SELECT format FROM platform.number_sequence WHERE company_id = $1 AND key = 'employee'`,
      [f.companyA1],
    );
    expect(sequence.rows[0]?.format).toBe('E{0000}');
  });

  it('refuses the same QID or passport, and warns on the same phone until acknowledged', async () => {
    const first = person('Original Holder');
    const original = await newEmployee(alice, { person: first });

    const sameQid = await post('/employees', alice, {
      person: { displayName: 'Copy By QID', qid: first.qid },
    });
    expect([sameQid.status, codeOf(sameQid)]).toEqual([409, 'identity_in_use']);
    expect((sameQid.body as { matches: Json[] }).matches).toMatchObject([
      { partyId: original.partyId, reasons: ['qid'], employeeCode: original.employeeCode },
    ]);
    // Formatting does not hide a passport: spaces and case are normalised before hashing.
    const passport = String(first.passport);
    const samePassport = await post('/employees', alice, {
      person: { displayName: 'Copy By Passport', passport: ` ${passport.toLowerCase()} ` },
    });
    expect([samePassport.status, codeOf(samePassport)]).toEqual([409, 'identity_in_use']);

    const phones = first.phones as string[];
    const samePhone = { displayName: 'Brother Sharing Phone', phones };
    const warned = await post('/employees', alice, { person: samePhone });
    expect([warned.status, codeOf(warned)]).toEqual([409, 'possible_duplicate']);
    expect((warned.body as { matches: Json[] }).matches).toMatchObject([
      { partyId: original.partyId, reasons: ['phone'] },
    ]);
    // Nothing was left behind by the refused attempts.
    const parties = await owner.query(
      `SELECT 1 FROM party.party WHERE company_id = $1 AND display_name LIKE 'Copy By%'`,
      [f.companyA1],
    );
    expect(parties.rowCount).toBe(0);
    await newEmployee(alice, { person: samePhone, acknowledgeDuplicates: true });

    const check = await post('/employees/duplicate-check', carol, {
      qid: first.qid,
      phones,
    });
    expect(check.status).toBe(200);
    const matches = (check.body as { matches: { partyId: string; reasons: string[] }[] }).matches;
    expect(matches.find((m) => m.partyId === original.partyId)?.reasons.sort()).toEqual([
      'phone',
      'qid',
    ]);
    expect(matches).toHaveLength(2);
    expect((await post('/employees/duplicate-check', dave, { phones })).status).toBe(403);
  });

  it('links an existing person once, and never an organisation', async () => {
    const party = await post('/parties', alice, { kind: 'person', displayName: 'Existing Person' });
    expect(party.status).toBe(201);
    const linked = await newEmployee(alice, { partyId: body(party).id });
    expect(linked.partyId).toBe(body(party).id);
    expect(linked.displayName).toBe('Existing Person');
    const again = await post('/employees', alice, { partyId: body(party).id });
    expect([again.status, codeOf(again)]).toEqual([409, 'already_employee']);

    const org = await post('/parties', alice, { kind: 'organisation', displayName: 'Some Org' });
    const refused = await post('/employees', alice, { partyId: body(org).id });
    expect([refused.status, codeOf(refused)]).toEqual([422, 'not_a_person']);
    const both = await post('/employees', alice, {
      partyId: body(party).id,
      person: person('Both Given'),
    });
    expect(both.status).toBe(400);
  });

  it('never takes a status from the body, and keeps sponsorship consistent', async () => {
    const withStatus = await post('/employees', alice, {
      person: person('Status Smuggler'),
      statusCode: 'blocked',
    });
    expect(withStatus.status).toBe(400);

    const sponsor = body(
      await post('/parties', alice, { kind: 'person', displayName: 'Outside Sponsor' }),
    );
    const companyWithSponsor = await post('/employees', alice, {
      person: person('Wrong Sponsor'),
      sponsorPartyId: sponsor.id,
    });
    expect(companyWithSponsor.status).toBe(400);
    const outside = await newEmployee(alice, {
      person: person('Outside Sponsored'),
      sponsorship: 'outside',
      sponsorPartyId: sponsor.id,
    });
    expect(outside.sponsorPartyId).toBe(sponsor.id);
    const back = await patch(`/employees/${outside.id}`, alice, outside.version, {
      sponsorship: 'company',
    });
    expect(back.status).toBe(200);
    expect((back.body as Employee).sponsorPartyId).toBeNull();
    const sponsorAgain = await patch(`/employees/${outside.id}`, alice, body(back).version, {
      sponsorPartyId: sponsor.id,
    });
    expect([sponsorAgain.status, codeOf(sponsorAgain)]).toEqual([422, 'sponsor_needs_outside']);
  });
});

describe('employee status', () => {
  it('moves through the state machine with history and its own permission', async () => {
    const e = await newEmployee(alice, { person: person('Status Mover') });
    const denied = await post(`/transitions/${EMPLOYEE_ENTITY}/${e.id}`, carol, {
      toCode: 'inactive',
    });
    expect(denied.status).toBe(403);
    const moved = await post(`/transitions/${EMPLOYEE_ENTITY}/${e.id}`, alice, {
      toCode: 'inactive',
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const after = body(await get(`/employees/${e.id}`, alice)) as Employee;
    expect(after.statusCode).toBe('inactive');
    // Terminating needs a reason; then a rehire brings the person back.
    const noReason = await post(`/transitions/${EMPLOYEE_ENTITY}/${e.id}`, alice, {
      toCode: 'terminated',
    });
    expect(noReason.status).toBe(400);
    const terminated = await post(`/transitions/${EMPLOYEE_ENTITY}/${e.id}`, alice, {
      toCode: 'terminated',
      note: 'Contract ended',
    });
    expect(terminated.status).toBe(200);
    const history = await get(`/state-history/${EMPLOYEE_ENTITY}/${e.id}`, alice);
    expect(
      (history.body as { items: { toCode: string }[] }).items.map((h) => h.toCode).sort(),
    ).toEqual(['active', 'inactive', 'terminated']);
  });

  it('starts as active without a machine (tenant B)', async () => {
    const e = await newEmployee(bob, { person: person('Tenant B Worker') });
    expect(e.statusCode).toBe('active');
    expect(e.employeeCode).toBe('E0001');
  });
});

describe('placements and employment periods', () => {
  it('keeps one placement per day, checks zone and team, and scopes rows to the employee', async () => {
    const e = await newEmployee(carol, {
      person: person('Placed Worker'),
      joiningDate: '2026-01-01',
      placement: { profession: 'driver' },
    });
    const other = await newEmployee(carol, { person: person('Other Worker') });
    const list = await get(`/employees/${e.id}/placements`, carol);
    const first = (list.body as { items: Body[] }).items[0];
    if (first === undefined) throw new Error('no placement');

    const overlap = await post(`/employees/${e.id}/placements`, carol, {
      profession: 'rider',
      validFrom: '2026-06-01',
    });
    expect([overlap.status, codeOf(overlap)]).toEqual([409, 'placement_overlap']);
    const closed = await patch(`/employees/${e.id}/placements/${first.id}`, carol, first.version, {
      validTo: '2026-05-31',
    });
    expect(closed.status).toBe(200);
    const next = await post(`/employees/${e.id}/placements`, carol, {
      profession: 'rider',
      validFrom: '2026-06-01',
      orgUnitId: ids.zone,
    });
    expect(next.status).toBe(201);

    const wrongKind = await post(`/employees/${other.id}/placements`, carol, {
      profession: 'rider',
      orgUnitId: ids.team,
    });
    expect([wrongKind.status, codeOf(wrongKind)]).toEqual([422, 'unknown_zone']);
    // Another employee's placement is not found under this employee's path.
    expect((await get(`/employees/${other.id}/placements/${first.id}`, carol)).status).toBe(404);

    const period = await post(`/employees/${e.id}/employment-periods`, carol, {
      startDate: '2026-03-01',
    });
    expect([period.status, codeOf(period)]).toEqual([409, 'period_overlap']);
    expect(
      (await post(`/employees/${e.id}/placements`, dave, { profession: 'rider' })).status,
    ).toBe(403);
  });
});

describe('isolation, audit, delete and restore', () => {
  it('hides employees from other tenants and lets the viewer only read', async () => {
    const e = await newEmployee(alice, { person: person('Private Employee') });
    expect((await get(`/employees/${e.id}`, dave)).status).toBe(200);
    expect((await get(`/employees/${e.id}`, bob)).status).toBe(404);
    const search = await get('/employees?q=Private%20Employee', bob);
    expect((search.body as { total: number }).total).toBe(0);
    const found = await get('/employees?q=private%20employee', dave);
    expect((found.body as { items: Employee[] }).items.map((i) => i.id)).toEqual([e.id]);
    expect((await post('/employees', dave, { person: person('Not Allowed') })).status).toBe(403);
  });

  it('audits changes, needs a reason to delete, and restores from the recycle bin', async () => {
    const e = await newEmployee(alice, { person: person('Audited Employee') });
    const changed = await patch(`/employees/${e.id}`, alice, e.version, {
      customFields: { shirt_size: 'L' },
    });
    expect(changed.status).toBe(200);
    expect((await del(`/employees/${e.id}`, alice, body(changed).version)).status).toBe(400);
    const deleted = await del(`/employees/${e.id}`, alice, body(changed).version, 'Entered twice');
    expect(deleted.status).toBe(204);
    expect((await get(`/employees/${e.id}`, alice)).status).toBe(404);
    const gone = await owner.query<{ version: number }>(
      `SELECT version FROM people.employee WHERE id = $1`,
      [e.id],
    );
    const restored = await postIf(`/employees/${e.id}/restore`, alice, gone.rows[0]?.version ?? 0);
    expect(restored.status).toBe(200);
    const rows = await owner.query<{ action: string }>(
      `SELECT action FROM audit.audit_log WHERE entity_id = $1 ORDER BY at`,
      [e.id],
    );
    expect(rows.rows.map((r) => r.action)).toEqual(['create', 'update', 'delete', 'restore']);
  });

  it('refuses a second live employee row for one person at the database', async () => {
    const e = await newEmployee(alice, { person: person('Unique Person') });
    const err = await owner
      .query(
        `INSERT INTO people.employee (tenant_id, company_id, party_id, employee_code)
         VALUES ($1, $2, $3, 'X-DUP')`,
        [f.tenantA, f.companyA1, e.partyId],
      )
      .catch((error: unknown) => error as { code?: string });
    expect((err as { code?: string }).code).toBe('23505');
    const app = await connect('app');
    try {
      // The app role cannot physically delete.
      const denied = await app
        .query(`DELETE FROM people.employee WHERE id = $1`, [e.id])
        .catch((error: unknown) => error as { code?: string });
      expect((denied as { code?: string }).code).toBe('42501');
    } finally {
      await app.end();
    }
  });
});
