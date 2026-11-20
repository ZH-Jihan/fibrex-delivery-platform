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
import { PartyService, PartyVault } from '../../src/modules/party/index.js';
import { createEmployeeImportTarget } from '../../src/modules/people/employee-import.js';
import { createEmployeeRepository } from '../../src/modules/people/employee-router.js';
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
  const parties = new PartyService(
    new PartyVault(new SecretBox(env.DATA_ENCRYPTION_KEY), env.DATA_ENCRYPTION_KEY),
  );
  const repository = createEmployeeRepository({ parties, numbering: new NumberingService() });
  target = createEmployeeImportTarget({ parties, repository });
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
    expect(fields[0]).toMatchObject({ key: 'displayName', required: true });
    expect(fields.map((x) => x.key)).toEqual(
      expect.arrayContaining(['qid', 'passport', 'phones', 'joiningDate', 'sponsorship']),
    );
  });

  it('creates an employee with a sealed QID and rolls it back', async () => {
    const values = { displayName: 'Import One', qid: '29100000001', phones: '+97455560001' };
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
    await run(() => target.create({ displayName: 'Import Two', qid: '29100000002' }, f.companyA1));
    const issues = await run(() =>
      target.validate({ displayName: 'Someone Else', qid: '29100000002' }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'already_employee' });
    expect(issues[0]?.message).toMatch(/E\d+/);
  });

  it('links a person already on file with the same QID instead of making a second one', async () => {
    // The first import created the person, then it was rolled back: the party stays.
    const id = await run(() =>
      target.create({ displayName: 'Import Three', qid: '29100000003' }, f.companyA1),
    );
    await run(() => target.remove(id, 'Import rolled back: test'));
    const [before] = await owner
      .query<{ n: string }>(
        `SELECT count(*) AS n FROM party.party WHERE company_id = $1 AND display_name = 'Import Three'`,
        [f.companyA1],
      )
      .then((r) => r.rows);
    const again = await run(() =>
      target.create({ displayName: 'Import Three', qid: '29100000003' }, f.companyA1),
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
      target.create({ displayName: 'Phone Owner', phones: '+97455560010' }, f.companyA1),
    );
    // Same phone, different name (family): allowed, a new person is made.
    await run(() =>
      target.create({ displayName: 'Phone Cousin', phones: '+97455560010' }, f.companyA1),
    );
    expect(await live('Phone Cousin')).toHaveLength(1);
    // Same phone and name as an existing employee: refused.
    const issues = await run(() =>
      target.validate({ displayName: 'Phone Owner', phones: '+97455560010' }),
    );
    expect(issues[0]).toMatchObject({ code: 'already_employee' });
  });

  it('reports row problems without touching the database', async () => {
    const issues = await run(() => target.validate({ displayName: 'Bad Phone', phones: '12' }));
    expect(issues.map((i) => i.path)).toEqual(['phones']);
    expect(await live('Bad Phone')).toHaveLength(0);
  });
});
