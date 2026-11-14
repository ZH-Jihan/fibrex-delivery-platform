/**
 * Soft-delete Prisma extension (SPEC 2.1: no physical deletes through the app).
 *
 * Purpose: applied to the one shared Prisma client, so every module gets these two rules
 * without writing them and cannot switch them off:
 *
 *   1. `delete` and `deleteMany` always throw. Rows are removed by setting `deleted_at`
 *      through the repository (kernel/db/repository.ts), which also checks the version.
 *      (The fibrex_app role has no DELETE grant either; this fails earlier and explains why.)
 *   2. On every model that has a `deletedAt` column, reads and bulk updates see only live
 *      rows: `deletedAt: null` is added to the top-level `where`.
 *
 * Opting out: a query whose top-level `where` already states `deletedAt` (for example
 * `{ deletedAt: { not: null } }` for the recycle bin, or a restore) is left as written.
 * `deletedAt: undefined` does not count, so a forgotten variable cannot expose deleted rows.
 *
 * Limits, on purpose: rows loaded through `include`/nested `select` are not filtered (a
 * live document may still need to show the deleted party it points at), and `upsert` and
 * single-row `update` are untouched; modules write through the repository instead.
 *
 * Depends on: the generated Prisma namespace. Used by: kernel/db/prisma.ts.
 */
import { Prisma } from '../../generated/prisma/client.js';

/** Operations that would physically remove rows. */
const DELETE_OPERATIONS: ReadonlySet<string> = new Set(['delete', 'deleteMany']);

/** Operations whose top-level `where` is narrowed to live rows. */
const FILTERED_OPERATIONS: ReadonlySet<string> = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'updateManyAndReturn',
]);

/**
 * Models that have a `deletedAt` column, read from the generated field lists so a new
 * table is covered as soon as it is added to the schema.
 */
export function findSoftDeleteModels(): ReadonlySet<string> {
  const namespace = Prisma as unknown as Record<string, Record<string, string> | undefined>;
  const models = new Set<string>();
  for (const model of Object.values(Prisma.ModelName)) {
    const fields = namespace[`${model}ScalarFieldEnum`];
    if (fields !== undefined && 'deletedAt' in fields) models.add(model);
  }
  return models;
}

export class PhysicalDeleteError extends Error {
  constructor(model: string, operation: string) {
    super(
      `${model}.${operation} is not allowed: rows are never physically deleted. ` +
        'Use the repository softDelete() instead.',
    );
    this.name = 'PhysicalDeleteError';
  }
}

/**
 * Returns the arguments to run for one model operation, or throws for a physical delete.
 * Pure, so the rules can be unit-tested without a database.
 */
export function applySoftDeleteRules(
  softDeleteModels: ReadonlySet<string>,
  model: string,
  operation: string,
  args: unknown,
): unknown {
  if (DELETE_OPERATIONS.has(operation)) throw new PhysicalDeleteError(model, operation);
  if (!softDeleteModels.has(model) || !FILTERED_OPERATIONS.has(operation)) return args;

  const given = (args ?? {}) as { where?: Record<string, unknown> };
  // The caller said which rows it wants (deleted, or both): respect it.
  if (given.where?.deletedAt !== undefined) return given;
  return { ...given, where: { ...given.where, deletedAt: null } };
}

export function softDeleteExtension(softDeleteModels = findSoftDeleteModels()) {
  return Prisma.defineExtension({
    name: 'fibrex-soft-delete',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          const next = applySoftDeleteRules(softDeleteModels, model, operation, args);
          return query(next as typeof args);
        },
      },
    },
  });
}
