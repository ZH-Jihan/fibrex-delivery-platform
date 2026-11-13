/**
 * Synthetic tenants, companies and users for isolation tests.
 *
 * Inserted as the owner role (RLS is not forced for the owner), so the fixture can create
 * rows in several tenants at once. All data is invented (CLAUDE.md safety rules).
 *
 * Layout:
 *   tenant A: companies A1 and A2, one branch each, user ua
 *   tenant B: company B1, one branch, user ub
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export interface Fixture {
  tenantA: string;
  tenantB: string;
  companyA1: string;
  companyA2: string;
  companyB1: string;
  branchA1: string;
  branchA2: string;
  branchB1: string;
  userA: string;
  userB: string;
}

export async function createFixture(owner: pg.Client): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const f: Fixture = {
    tenantA: randomUUID(),
    tenantB: randomUUID(),
    companyA1: randomUUID(),
    companyA2: randomUUID(),
    companyB1: randomUUID(),
    branchA1: randomUUID(),
    branchA2: randomUUID(),
    branchB1: randomUUID(),
    userA: randomUUID(),
    userB: randomUUID(),
  };

  await owner.query(
    `INSERT INTO platform.currency (code, name) VALUES ('QAR', 'Qatari Riyal') ON CONFLICT (code) DO NOTHING`,
  );
  await owner.query(
    `INSERT INTO platform.tenant (id, name, slug) VALUES ($1, 'Tenant A', $3), ($2, 'Tenant B', $4)`,
    [f.tenantA, f.tenantB, `tenant-a-${suffix}`, `tenant-b-${suffix}`],
  );
  await owner.query(
    `INSERT INTO platform.company (id, tenant_id, legal_name, country_code, base_currency) VALUES
       ($1, $4, 'Alpha One Trading', 'QA', 'QAR'),
       ($2, $4, 'Alpha Two Services', 'QA', 'QAR'),
       ($3, $5, 'Beta Logistics', 'QA', 'QAR')`,
    [f.companyA1, f.companyA2, f.companyB1, f.tenantA, f.tenantB],
  );
  await owner.query(
    `INSERT INTO platform.branch (id, tenant_id, company_id, code, name) VALUES
       ($1, $4, $5, 'HQ', 'A1 head office'),
       ($2, $4, $6, 'HQ', 'A2 head office'),
       ($3, $7, $8, 'HQ', 'B1 head office')`,
    [
      f.branchA1,
      f.branchA2,
      f.branchB1,
      f.tenantA,
      f.companyA1,
      f.companyA2,
      f.tenantB,
      f.companyB1,
    ],
  );
  await owner.query(
    `INSERT INTO iam.user_account (id, tenant_id, username, display_name) VALUES
       ($1, $3, 'alice', 'Alice Test'), ($2, $4, 'bob', 'Bob Test')`,
    [f.userA, f.userB, f.tenantA, f.tenantB],
  );
  return f;
}
