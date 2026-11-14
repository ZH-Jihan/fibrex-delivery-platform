/**
 * Prisma client.
 *
 * Purpose: build the one typed database client of the process on top of the shared pg
 * pool (kernel/db/pool.ts), so Prisma, readiness checks and raw queries share one bounded
 * set of connections, all logged in as the restricted `fibrex_app` role. The soft-delete
 * extension is applied here, so no module can obtain a client without it.
 *
 * The client itself carries no tenant. Module code never queries it directly: it goes
 * through the unit of work (kernel/db/unit-of-work.ts), which opens a transaction and sets
 * the row-level security context. A query made outside a unit of work has no context and
 * therefore sees no tenant rows (policies fail closed).
 *
 * The pool is owned by src/main.ts; `$disconnect()` leaves it open.
 *
 * Depends on: @prisma/adapter-pg, the generated client, ./soft-delete.ts.
 * Used by: kernel/db/unit-of-work.ts, src/main.ts.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';
import type { Pool } from './pool.js';
import { softDeleteExtension } from './soft-delete.js';

export function createPrisma(pool: Pool) {
  return new PrismaClient({ adapter: new PrismaPg(pool) }).$extends(softDeleteExtension());
}

/** The process-wide client (extended). */
export type PrismaDb = ReturnType<typeof createPrisma>;

/**
 * The client a unit of work hands out: the same models, bound to one transaction, without
 * the methods that would open or close connections or start another transaction.
 */
export type Db = Omit<
  PrismaDb,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
