/**
 * Formulas API (phase 2 plan row 2.9a; PLAN 5.9 "Formulas").
 *
 *   /formulas                               CRUD: key, purpose, return type, input schema
 *   /formula-versions                       CRUD: expressions; filter formulaId, status
 *   POST /formula-versions/{id}/test        run the stored (or given) test cases
 *   POST /formula-versions/{id}/activate    put a draft in force from its valid_from
 *   POST /formulas/evaluate                 preview with the "how was this calculated" trace
 *
 * The plan names the versions route `/formulas/:id/versions`; versions are served flat
 * (`/formula-versions?formulaId=`), as template versions are, so the one CRUD factory gives
 * them the same behaviour as every other resource.
 *
 * Rules on top of the plain permissions, and why:
 *   1. A formula's key and return type never change: modules look formulas up by key and
 *      store results of the type they were written for.
 *   2. The input schema may change only if every version still compiles against it, so a
 *      past month can still be recomputed with the version that was in force then.
 *   3. A version's expression must compile (syntax, allowed calls, declared inputs, return
 *      type) on every save; its checksum is the SHA-256 of the expression.
 *   4. Only a draft can be edited or deleted; active and retired versions are frozen because
 *      stored results name them.
 *   5. Activation needs at least one test case and every test case must pass. The new
 *      version must start after the version now in force; that one is closed the day before
 *      (valid_to) and retired. Date ranges therefore never overlap.
 *   6. A formula with live versions is not deleted until they are.
 *   7. rate("<table>", {...}) reads the rates in force on the evaluation day (`date`, default
 *      today); test cases and activation read them on the version's start date.
 *
 * Depends on: express, zod, @fibrex/formula, @fibrex/shared (formula schemas), kernel/db,
 * kernel/http, kernel/permissions, ./formula-service.
 * Used by: src/main.ts, the recycle bin.
 */
import { createHash } from 'node:crypto';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { compileFormula, runTestCases, type InputSchema, type TestCase } from '@fibrex/formula';
import {
  FORMULA_PURPOSES,
  FORMULA_RETURN_TYPES,
  FORMULA_VERSION_STATUSES,
  formulaInputSchemaSchema,
  formulaKeySchema,
  formulaTestCasesSchema,
  type FormulaReturnType,
} from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import { VersionConflictError } from '../db/optimistic-lock.js';
import { createRepository, type Repository } from '../db/repository.js';
import { currentUnit, type UnitOfWork } from '../db/unit-of-work.js';
import { createCrudRouter, parseIfMatch } from '../http/crud-router.js';
import { ConflictError, UnprocessableError, ValidationError } from '../http/errors.js';
import { problemSchema, registerRoute } from '../http/openapi.js';
import type { PermissionService } from '../permissions/permission-service.js';
import type { FormulaService } from './formula-service.js';
import { formulaProblem, type FormulaRow, type FormulaVersionRow } from './formula-service.js';

const day = z.iso.date();

const formulaCreate = z.strictObject({
  key: formulaKeySchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().default(null),
  purpose: z.enum(FORMULA_PURPOSES),
  returnType: z.enum(FORMULA_RETURN_TYPES),
  inputSchema: formulaInputSchemaSchema.default({}),
});
const formulaUpdate = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).nullable(),
    purpose: z.enum(FORMULA_PURPOSES),
    inputSchema: formulaInputSchemaSchema,
  })
  .partial();
const formulaItem = z
  .object({
    id: z.uuid(),
    key: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    purpose: z.enum(FORMULA_PURPOSES),
    returnType: z.enum(FORMULA_RETURN_TYPES),
    inputSchema: z.record(z.string(), z.unknown()),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Formula' });
const formulaFilter = z.object({ purpose: z.enum(FORMULA_PURPOSES).optional() });

const versionCreate = z.strictObject({
  formulaId: z.uuid(),
  expression: z.string().min(1).max(5000),
  validFrom: day.optional(),
  testCases: formulaTestCasesSchema.default([]),
});
const versionUpdate = z
  .strictObject({
    expression: z.string().min(1).max(5000),
    validFrom: day,
    testCases: formulaTestCasesSchema,
  })
  .partial();
const versionItem = z
  .object({
    id: z.uuid(),
    formulaId: z.uuid(),
    versionNo: z.number().int(),
    language: z.literal('cel'),
    expression: z.string(),
    validFrom: day,
    validTo: day.nullable(),
    status: z.enum(FORMULA_VERSION_STATUSES),
    testCases: z.array(z.unknown()),
    checksum: z.string(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'FormulaVersion' });
const versionFilter = z.object({
  formulaId: z.uuid().optional(),
  status: z.enum(FORMULA_VERSION_STATUSES).optional(),
});

const testBody = z.strictObject({ testCases: formulaTestCasesSchema.optional() });
const testResult = z
  .object({
    passed: z.boolean(),
    results: z.array(
      z.object({
        name: z.string(),
        passed: z.boolean(),
        expected: z.union([z.string(), z.boolean()]),
        actual: z.unknown().optional(),
        error: z.object({ code: z.string(), message: z.string() }).optional(),
      }),
    ),
  })
  .meta({ id: 'FormulaTestResult' });

/**
 * Three ways to preview: a formula key on a date (the version in force then), one version by
 * id (drafts too), or an unsaved expression with its own input schema and return type.
 */
const evaluateBody = z
  .strictObject({
    formulaKey: formulaKeySchema.optional(),
    date: day.optional(),
    versionId: z.uuid().optional(),
    expression: z.string().min(1).max(5000).optional(),
    inputSchema: formulaInputSchemaSchema.optional(),
    returnType: z.enum(FORMULA_RETURN_TYPES).optional(),
    inputs: z.record(z.string(), z.unknown()).default({}),
    explain: z.boolean().default(true),
  })
  .refine(
    (b) => [b.formulaKey, b.versionId, b.expression].filter((v) => v !== undefined).length === 1,
    'Give exactly one of formulaKey, versionId or expression.',
  )
  .refine(
    (b) => b.expression === undefined || b.returnType !== undefined,
    'An expression needs a returnType.',
  );
const traceStep = z.object({ expression: z.string(), value: z.unknown() });
const evaluateResult = z
  .object({
    value: z.unknown(),
    inputs: z.record(z.string(), z.unknown()),
    trace: z.array(traceStep).optional(),
    rates: z
      .array(
        z.object({
          table: z.string(),
          dims: z.record(z.string(), z.string()),
          value: z.string(),
          currency: z.string().optional(),
          rowId: z.string().optional(),
        }),
      )
      .optional(),
    formulaVersionId: z.uuid().nullable(),
    versionNo: z.number().int().nullable(),
    checksum: z.string().nullable(),
  })
  .meta({ id: 'FormulaEvaluation' });

export function toFormulaItem(row: FormulaRow) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    purpose: row.purpose,
    returnType: row.returnType,
    inputSchema: row.inputSchema as Record<string, unknown>,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export function toFormulaVersionItem(row: FormulaVersionRow) {
  return {
    id: row.id,
    formulaId: row.formulaId,
    versionNo: row.versionNo,
    language: 'cel' as const,
    expression: row.expression,
    validFrom: isoDay(row.validFrom),
    validTo: row.validTo === null ? null : isoDay(row.validTo),
    status: row.status,
    testCases: row.testCases as unknown[],
    checksum: row.checksum,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

const invalid = (path: string, message: string, code: string) =>
  new ValidationError([{ path, message, code }]);

const checksumOf = (expression: string) => createHash('sha256').update(expression).digest('hex');

/** Rule 3: compile against the formula's own inputs and return type. */
function checkExpression(formula: FormulaRow, expression: string): void {
  try {
    compileFormula(
      expression,
      formula.inputSchema as unknown as InputSchema,
      formula.returnType as FormulaReturnType,
    );
  } catch (err) {
    throw formulaProblem(err, 'expression');
  }
}

async function liveFormula(id: string): Promise<FormulaRow> {
  const formula = await currentUnit().db.formula.findFirst({ where: { id, deletedAt: null } });
  if (formula === null)
    throw invalid('formulaId', 'This formula does not exist.', 'unknown_formula');
  return formula;
}

/** The repository behind `/formulas` and the recycle bin; adds rules 1, 2 and 6. */
export function createFormulaRepository(): Repository<FormulaRow> {
  const base = createRepository<FormulaRow>({ model: 'formula', scope: 'tenant' });
  return {
    ...base,
    update: async (id, version, changes) => {
      const body = changes as z.infer<typeof formulaUpdate>;
      if (body.inputSchema !== undefined) {
        const current = await base.get(id);
        const versions = await currentUnit().db.formulaVersion.findMany({
          where: { formulaId: id, deletedAt: null },
          orderBy: { versionNo: 'asc' },
        });
        // Rule 2: every version must still compile with the new inputs.
        for (const v of versions) {
          try {
            compileFormula(v.expression, body.inputSchema, current.returnType as FormulaReturnType);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw invalid(
              'inputSchema',
              `Version ${String(v.versionNo)} would no longer work: ${message}`,
              'formula_inputs_in_use',
            );
          }
        }
      }
      return base.update(id, version, body);
    },
    softDelete: async (id, version, reason) => {
      const versions = await currentUnit().db.formulaVersion.count({
        where: { formulaId: id, deletedAt: null },
      });
      if (versions > 0) {
        throw new ConflictError(
          'formula_has_versions',
          'Delete the versions of this formula first.',
          {
            versions,
          },
        );
      }
      return base.softDelete(id, version, reason);
    },
  };
}

/** The repository behind `/formula-versions` and the recycle bin; adds rules 3 and 4. */
export function createFormulaVersionRepository(): Repository<FormulaVersionRow> {
  const base = createRepository<FormulaVersionRow>({ model: 'formulaVersion', scope: 'tenant' });
  const frozen = () =>
    new UnprocessableError(
      'formula_version_frozen',
      'Only a draft can be changed or deleted; make a new version instead.',
    );
  return {
    ...base,
    create: async (data) => {
      const body = data as z.infer<typeof versionCreate>;
      const formula = await liveFormula(body.formulaId);
      checkExpression(formula, body.expression);
      const { db } = currentUnit();
      // The number counts deleted drafts too, so a number never names two expressions. Raw
      // SQL because the soft-delete extension hides deleted rows from Prisma reads (aggregate
      // included), which would hand out the number of a deleted draft again.
      const highest = await db.$queryRaw<{ n: number }[]>`
        SELECT coalesce(max(version_no), 0)::int AS n FROM cfg.formula_version
         WHERE formula_id = ${formula.id}::uuid`;
      return base.create({
        formulaId: formula.id,
        versionNo: (highest[0]?.n ?? 0) + 1,
        expression: body.expression,
        checksum: checksumOf(body.expression),
        testCases: body.testCases,
        status: 'draft',
        ...(body.validFrom === undefined ? {} : { validFrom: new Date(body.validFrom) }),
      });
    },
    update: async (id, version, changes) => {
      const current = await base.get(id);
      if (current.status !== 'draft') throw frozen();
      const body = changes as z.infer<typeof versionUpdate>;
      if (body.expression !== undefined) {
        checkExpression(await liveFormula(current.formulaId), body.expression);
      }
      return base.update(id, version, {
        ...body,
        ...(body.expression === undefined ? {} : { checksum: checksumOf(body.expression) }),
        ...(body.validFrom === undefined ? {} : { validFrom: new Date(body.validFrom) }),
      });
    },
    softDelete: async (id, version, reason) => {
      const current = await base.get(id);
      if (current.status !== 'draft') throw frozen();
      return base.softDelete(id, version, reason);
    },
  };
}

export interface FormulaRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  formulas: FormulaService;
}

export function createFormulaRouter(deps: FormulaRouterDeps): Router {
  const { uow, registry, permissions, formulas } = deps;
  const router = Router();
  const crud = { uow, authorize: permissions.authorize, registry };
  const versions = createFormulaVersionRepository();
  const idParams = z.object({ id: z.uuid() });
  const tags = ['Formulas'];

  // Declared before the CRUD routes so `evaluate` is not taken for an id.
  router.post('/formulas/evaluate', async (req, res) => {
    const body = evaluateBody.parse(req.body);
    const result = await uow.run(async () => {
      await permissions.require('platform.formula.evaluate');
      const options = { explain: body.explain };
      // Rates (rate()) are read as they were on this day; versions and drafts use it too.
      const onDate = new Date(body.date ?? isoDay(new Date()));
      try {
        if (body.formulaKey !== undefined) {
          return await formulas.evaluate(body.formulaKey, onDate, body.inputs, options);
        }
        if (body.versionId !== undefined) {
          const version = await versions.get(body.versionId);
          const formula = await liveFormula(version.formulaId);
          return {
            ...(await formulas.run(
              formulas.compile(formula, version),
              onDate,
              body.inputs,
              options,
            )),
            formulaVersionId: version.id,
            versionNo: version.versionNo,
            checksum: version.checksum,
          };
        }
        const compiled = compileFormula(
          body.expression ?? '',
          body.inputSchema ?? {},
          body.returnType ?? 'decimal',
        );
        return {
          ...(await formulas.run(compiled, onDate, body.inputs, options)),
          formulaVersionId: null,
          versionNo: null,
          checksum: null,
        };
      } catch (err) {
        throw formulaProblem(err, body.expression === undefined ? 'inputs' : 'expression');
      }
    });
    res.json({
      value: result.value,
      inputs: result.inputs,
      ...(result.trace === undefined ? {} : { trace: result.trace }),
      ...(result.rates === undefined ? {} : { rates: result.rates }),
      formulaVersionId: result.formulaVersionId,
      versionNo: result.versionNo,
      checksum: result.checksum,
    });
  });

  router.use(
    createCrudRouter<FormulaRow>(crud, {
      path: '/formulas',
      resource: 'platform.formula',
      tag: 'Formulas',
      repository: createFormulaRepository(),
      schemas: {
        create: formulaCreate,
        update: formulaUpdate,
        item: formulaItem,
        filter: formulaFilter,
      },
      toItem: toFormulaItem,
      toWhere: (filter) => filter,
    }),
  );
  router.use(
    createCrudRouter<FormulaVersionRow>(crud, {
      path: '/formula-versions',
      resource: 'platform.formula_version',
      tag: 'Formulas',
      repository: versions,
      schemas: {
        create: versionCreate,
        update: versionUpdate,
        item: versionItem,
        filter: versionFilter,
      },
      toItem: toFormulaVersionItem,
      toWhere: (filter) => filter,
    }),
  );

  router.post('/formula-versions/:id/test', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const body = testBody.parse(req.body ?? {});
    const results = await uow.run(async () => {
      await permissions.require('platform.formula_version.test');
      const version = await versions.get(id);
      const formula = await liveFormula(version.formulaId);
      const cases = (body.testCases ?? (version.testCases as unknown)) as TestCase[];
      // Test cases read the rates in force on the version's start date.
      const compiled = formulas.compile(formula, version);
      return runTestCases(compiled, cases, await formulas.ratesFor(compiled, version.validFrom));
    });
    res.json({ passed: results.every((r) => r.passed), results });
  });

  router.post('/formula-versions/:id/activate', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const expected = parseIfMatch(req.get('If-Match'));
    try {
      const row = await uow.run(async () => {
        await permissions.require('platform.formula_version.activate');
        const current = await versions.get(id);
        if (current.status !== 'draft') {
          throw new UnprocessableError(
            'formula_version_not_draft',
            'Only a draft can be activated.',
          );
        }
        // Rule 5, step 1: the test cases are the proof the formula does what it should.
        const cases = current.testCases as unknown as TestCase[];
        if (cases.length === 0) {
          throw new UnprocessableError(
            'formula_no_test_cases',
            'Add at least one test case before activating.',
          );
        }
        const formula = await liveFormula(current.formulaId);
        const compiled = formulas.compile(formula, current);
        const failed = runTestCases(
          compiled,
          cases,
          await formulas.ratesFor(compiled, current.validFrom),
        ).filter((r) => !r.passed);
        if (failed.length > 0) {
          throw new UnprocessableError(
            'formula_tests_failed',
            `Test cases failing: ${failed.map((r) => r.name).join(', ')}.`,
          );
        }
        // Rule 5, step 2: close the version in force the day before the new one starts.
        const { db } = currentUnit();
        const inForce = await db.formulaVersion.findFirst({
          where: { formulaId: current.formulaId, status: 'active', deletedAt: null },
        });
        if (inForce !== null) {
          if (current.validFrom <= inForce.validFrom) {
            throw new UnprocessableError(
              'formula_version_starts_too_early',
              `The new version must start after ${isoDay(inForce.validFrom)}, when version ${String(inForce.versionNo)} started.`,
            );
          }
          await db.formulaVersion.update({
            where: { id: inForce.id },
            data: {
              status: 'retired',
              validTo: new Date(current.validFrom.getTime() - 86_400_000),
            },
          });
        }
        return versions.update(id, expected, { status: 'active' });
      });
      res
        .status(200)
        .setHeader('ETag', `"${String(row.version)}"`)
        .json(toFormulaVersionItem(row));
    } catch (err) {
      if (err instanceof VersionConflictError) {
        throw err.presentedWith((r) => toFormulaVersionItem(r as unknown as FormulaVersionRow));
      }
      throw err;
    }
  });

  const problem = (description: string) => ({
    description,
    content: { 'application/problem+json': { schema: problemSchema } },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/formulas/evaluate',
    tags,
    summary: 'Evaluate a formula (by key and date, by version, or unsaved) with its trace',
    request: { body: { content: { 'application/json': { schema: evaluateBody } } } },
    responses: {
      200: {
        description: 'The result',
        content: { 'application/json': { schema: evaluateResult } },
      },
      400: problem('The formula or its inputs are not valid'),
      404: problem('No such formula or no version in force'),
    },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/formula-versions/{id}/test',
    tags,
    summary: 'Run the test cases of a version (stored ones unless given)',
    request: { params: idParams, body: { content: { 'application/json': { schema: testBody } } } },
    responses: {
      200: {
        description: 'Results per case',
        content: { 'application/json': { schema: testResult } },
      },
      404: problem('No such version'),
    },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/formula-versions/{id}/activate',
    tags,
    summary: 'Activate a draft from its valid_from and retire the version it replaces (If-Match)',
    request: { params: idParams },
    responses: {
      200: {
        description: 'The active version',
        content: { 'application/json': { schema: versionItem } },
      },
      404: problem('No such version'),
      409: problem('Version conflict'),
      422: problem('Not a draft, no or failing test cases, or starts too early'),
    },
  });

  return router;
}
