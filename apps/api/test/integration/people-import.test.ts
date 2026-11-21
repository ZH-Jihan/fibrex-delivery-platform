/**
 * Employee import, row 3.8, against real PostgreSQL: the `people.employee` import target
 * checks rows, matches people already on file by QID or phone, creates employees through the
 * employee repository (identifiers sealed by the party vault) and rolls them back.
 * Everything is invented; tenant A, company A1.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/kernel/config/env.js';
import { SecretBox } from '../../src/kernel/crypto/secret-box.js';
import { createPool, type Pool } from '../../src/kernel/db/pool.js';
import { createPrisma } from '../../src/kernel/db/prisma.js';
import { UnitOfWork, type DbContext } from '../../src/kernel/db/unit-of-work.js';
import type { ImportTarget } from '../../src/kernel/imports/import-targets.js';
import { NumberingService } from '../../src/kernel/numbering/numbering-service.js';
import type { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import { StateService, StateTargets } from '../../src/kernel/states/state-service.js';
import { PartyService, PartyVault } from '../../src/modules/party/index.js';
import { createEmployeeImportTarget } from '../../src/modules/people/employee-import.js';
import { createEmployeeRepository } from '../../src/modules/people/employee-router.js';
import {
  createEmployeeStateTarget,
  seedEmployeeStatus,
} from '../../src/modules/people/employee-status.js';
import { seedClientPlatforms } from '../../src/modules/performance/platform-seed.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

let owner: pg.Client;
let pool: Pool;
let f: Fixture;
let uow: UnitOfWork;
let target: ImportTarget;
let ctx: DbContext;
const run = <T>(fn: () => Promise<T>) => uow.runAs(ctx, fn);

beforeAll(async () => {
  owner = await connect('owner');
  f = await createFixture(owner);
  const db = testDatabase();
  pool = createPool(connectionUrl(db, db.app), 4);
  uow = new UnitOfWork(createPrisma(pool));
  const env = loadEnv({
    DATABASE_URL: 'postgresql://unused@localhost:1/x',
    REDIS_URL: 'redis://localhost:1',
    ...TEST_AUTH_ENV,
  });
  const vault = new PartyVault(new SecretBox(env.DATA_ENCRYPTION_KEY), env.DATA_ENCRYPTION_KEY);
  const parties = new PartyService(vault);
  const repository = createEmployeeRepository({ parties, numbering: new NumberingService() });
  // The real state service and the real employee machine; only the permission check is
  // replaced (this test has no users and roles; the caller's rights are tested elsewhere).
  await seedEmployeeStatus(owner, f.tenantA);
  await seedClientPlatforms(owner, f.tenantA, f.companyA1);
  const targets = new StateTargets(() => {
    throw new Error('no custom records in this test');
  });
  targets.register('people.employee', createEmployeeStateTarget(repository));
  const states = new StateService({
    permissions: { require: () => Promise.resolve() } as unknown as PermissionService,
    targets,
  });
  target = createEmployeeImportTarget({ parties, repository, vault, states });
  ctx = { tenantId: f.tenantA, companyIds: [f.companyA1], userId: f.userA };
});

afterAll(async () => {
  await pool.end();
  await owner.end();
});

const live = async (name: string) =>
  (
    await owner.query<{ id: string; party_id: string }>(
      `SELECT e.id, e.party_id FROM people.employee e JOIN party.party p ON p.id = e.party_id
       WHERE e.company_id = $1 AND p.display_name = $2 AND e.deleted_at IS NULL`,
      [f.companyA1, name],
    )
  ).rows;

describe('employee import target', () => {
  it('lists the template fields with the English name required', async () => {
    const fields = await target.fields();
    expect(fields[0]).toMatchObject({ key: 'display_name', required: true });
    expect(fields.map((x) => x.key)).toEqual(
      expect.arrayContaining([
        'qid',
        'passport',
        'phones',
        'joining_date',
        'sponsorship',
        'falcon_id',
        'status',
      ]),
    );
    // The template download carries both new columns in its example row.
    expect(target.templateExample).toMatchObject({ falcon_id: '100200', status: 'active' });
  });

  it('creates an employee with a sealed QID and rolls it back', async () => {
    const values = { display_name: 'Import One', qid: '29100000001', phones: '+97455560001' };
    expect(await run(() => target.validate(values))).toEqual([]);
    const id = await run(() => target.create(values, f.companyA1));
    expect(await live('Import One')).toHaveLength(1);

    // The QID is stored sealed, hashed and masked; never in plain text.
    const stored = await owner.query<{ value_masked: string; value_plain: string | null }>(
      `SELECT i.value_masked, i.value_plain FROM party.party_identifier i
       JOIN people.employee e ON e.party_id = i.party_id WHERE e.id = $1 AND i.type = 'qid'`,
      [id],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.value_plain).toBeNull();
    expect(stored.rows[0]?.value_masked).not.toContain('29100000001');

    await run(() => target.remove(id, 'Import rolled back: test'));
    expect(await live('Import One')).toHaveLength(0);
  });

  it('refuses a row whose QID already belongs to an employee, naming the code', async () => {
    await run(() => target.create({ display_name: 'Import Two', qid: '29100000002' }, f.companyA1));
    const issues = await run(() =>
      target.validate({ display_name: 'Someone Else', qid: '29100000002' }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'already_employee' });
    expect(issues[0]?.message).toMatch(/E\d+/);
  });

  it('links a person already on file with the same QID instead of making a second one', async () => {
    // The first import created the person, then it was rolled back: the party stays.
    const id = await run(() =>
      target.create({ display_name: 'Import Three', qid: '29100000003' }, f.companyA1),
    );
    await run(() => target.remove(id, 'Import rolled back: test'));
    const [before] = await owner
      .query<{ n: string }>(
        `SELECT count(*) AS n FROM party.party WHERE company_id = $1 AND display_name = 'Import Three'`,
        [f.companyA1],
      )
      .then((r) => r.rows);
    const again = await run(() =>
      target.create({ display_name: 'Import Three', qid: '29100000003' }, f.companyA1),
    );
    const after = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM party.party WHERE company_id = $1 AND display_name = 'Import Three'`,
      [f.companyA1],
    );
    expect(again).not.toBe(id);
    expect(after.rows[0]?.n).toBe(before?.n);
    expect(await live('Import Three')).toHaveLength(1);
  });

  it('links by phone for the same name and creates a new person for a shared phone', async () => {
    await run(() =>
      target.create({ display_name: 'Phone Owner', phones: '+97455560010' }, f.companyA1),
    );
    // Same phone, different name (family): allowed, a new person is made.
    await run(() =>
      target.create({ display_name: 'Phone Cousin', phones: '+97455560010' }, f.companyA1),
    );
    expect(await live('Phone Cousin')).toHaveLength(1);
    // Same phone and name as an existing employee: refused.
    const issues = await run(() =>
      target.validate({ display_name: 'Phone Owner', phones: '+97455560010' }),
    );
    expect(issues[0]).toMatchObject({ code: 'already_employee' });
  });

  it('reports row problems without touching the database', async () => {
    const issues = await run(() => target.validate({ display_name: 'Bad Phone', phones: '12' }));
    expect(issues.map((i) => i.path)).toEqual(['phones']);
    expect(await live('Bad Phone')).toHaveLength(0);
  });
});

describe('employee import: Falcon ID and status (row 3.13)', () => {
  const falconRows = (employeeId: string) =>
    owner.query<{ value_plain: string; platform: string }>(
      `SELECT i.value_plain, cp.code AS platform FROM party.party_identifier i
         JOIN people.employee e ON e.party_id = i.party_id
         JOIN performance.client_platform cp ON cp.id = i.client_platform_id
        WHERE e.id = $1 AND i.type = 'falcon_id' AND i.deleted_at IS NULL`,
      [employeeId],
    );
  const placementCount = async (employeeId: string) =>
    Number(
      (
        await owner.query<{ n: string }>(
          `SELECT count(*) AS n FROM people.employee_placement WHERE employee_id = $1`,
          [employeeId],
        )
      ).rows[0]?.n,
    );
  const statusOf = async (employeeId: string) =>
    (
      await owner.query<{ status_code: string }>(
        `SELECT status_code FROM people.employee WHERE id = $1`,
        [employeeId],
      )
    ).rows[0]?.status_code;

  it('links the Falcon ID to Snoonu and moves the status with the note Imported', async () => {
    const values = {
      display_name: 'Falcon Rider',
      qid: '29100000101',
      profession: 'rider',
      falcon_id: 'FX1001',
      status: 'Blocked',
    };
    expect(await run(() => target.validate(values))).toEqual([]);
    const id = await run(() => target.create(values, f.companyA1));
    expect((await falconRows(id)).rows).toEqual([{ value_plain: 'FX1001', platform: 'snoonu' }]);
    expect(await statusOf(id)).toBe('blocked');
    const history = await owner.query<{ to_code: string; note: string | null }>(
      `SELECT to_code, note FROM cfg.state_history WHERE entity_id = $1 ORDER BY id`,
      [id],
    );
    expect(history.rows.at(-1)).toEqual({ to_code: 'blocked', note: 'Imported' });
  });

  it('imports office staff with no Falcon ID, no profession and no status', async () => {
    const values = { display_name: 'Office Olivia', qid: '29100000102' };
    expect(await run(() => target.validate(values))).toEqual([]);
    const id = await run(() => target.create(values, f.companyA1));
    expect((await falconRows(id)).rows).toEqual([]);
    expect(await placementCount(id)).toBe(0);
    expect(await statusOf(id)).toBe('active');
  });

  it('refuses a Falcon ID another person holds and never reassigns it', async () => {
    const values = { display_name: 'Second Claimant', qid: '29100000103', falcon_id: 'fx1001' };
    const issues = await run(() => target.validate(values));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: 'falcon_id', code: 'falcon_id_in_use' });
    expect(issues[0]?.message).toContain('Falcon Rider');
    await expect(run(() => target.create(values, f.companyA1))).rejects.toMatchObject({
      code: 'falcon_id_in_use',
    });
    expect(await live('Second Claimant')).toHaveLength(0);
    const [holder] = await live('Falcon Rider');
    expect((await falconRows(holder?.id ?? '')).rows).toHaveLength(1);
  });

  it('accepts the same person already holding the Falcon ID (re-import after a rollback)', async () => {
    const [holder] = await live('Falcon Rider');
    await run(() => target.remove(holder?.id ?? '', 'Import rolled back: test'));
    const values = { display_name: 'Falcon Rider', qid: '29100000101', falcon_id: 'FX1001' };
    expect(await run(() => target.validate(values))).toEqual([]);
    const id = await run(() => target.create(values, f.companyA1));
    expect((await falconRows(id)).rows).toHaveLength(1);
  });

  it('checks the status and Falcon ID text, and a Falcon ID repeated inside one file', async () => {
    const bad = await run(() =>
      target.validate({ display_name: 'Bad Status', status: 'retired', falcon_id: 'a b' }),
    );
    expect(bad.map((i) => i.path).sort()).toEqual(['falcon_id', 'status']);

    const check = target.newPreviewValidator?.();
    if (check === undefined) throw new Error('the employee target has a preview validator');
    const first = await run(() =>
      check({ display_name: 'File One', qid: '29100000111', falcon_id: 'FX2000' }),
    );
    const second = await run(() =>
      check({ display_name: 'File Two', qid: '29100000112', falcon_id: 'fx2000' }),
    );
    expect(first).toEqual([]);
    expect(second.map((i) => i.code)).toEqual(['duplicate_in_file']);
  });
});
