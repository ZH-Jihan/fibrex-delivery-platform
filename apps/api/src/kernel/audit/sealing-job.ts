/**
 * Audit sealing job: extends every tenant's tamper-evidence hash chain.
 *
 * Purpose: audit rows are written unsealed so business transactions never wait on the
 * chain. This job calls the database function audit.seal_pending(), which numbers the new
 * rows of each tenant and hashes them into the chain (the migration
 * 20261114000000_audit explains the algorithm). Running it twice, or twice at once, is
 * safe: the function takes a per-tenant lock and only ever touches unsealed rows.
 *
 * It runs outside a unit of work on purpose: it serves all tenants, and the SQL function
 * is the only thing it may call. Run it every minute or so; the job scheduler (commit 9)
 * owns the schedule.
 *
 * Depends on: ../db/prisma.ts. Used by: the job scheduler, tests.
 */
import type { PrismaDb } from '../db/prisma.js';

export interface SealResult {
  tenantId: string;
  fromSeq: number;
  toSeq: number;
}

/** Rows hashed into one seal; larger backlogs produce several seals in one run. */
export const DEFAULT_SEAL_BATCH = 5_000;

export async function sealAuditLog(
  prisma: PrismaDb,
  batchSize: number = DEFAULT_SEAL_BATCH,
): Promise<SealResult[]> {
  const rows = await prisma.$queryRaw<
    { sealed_tenant_id: string; sealed_from_seq: bigint; sealed_to_seq: bigint }[]
  >`SELECT sealed_tenant_id::text AS sealed_tenant_id, sealed_from_seq, sealed_to_seq
      FROM audit.seal_pending(${batchSize}::integer)`;
  return rows.map((row) => ({
    tenantId: row.sealed_tenant_id,
    fromSeq: Number(row.sealed_from_seq),
    toSeq: Number(row.sealed_to_seq),
  }));
}
