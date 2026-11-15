/**
 * Numbering sequences API (phase 2 plan row 2.2): the settings behind `L0001`-style numbers.
 *
 *   /number-sequences                CRUD (kernel CRUD factory), current company
 *   POST /number-sequences/preview   render a sample from settings typed in the form
 *   GET  /number-sequences/{id}/next what the next allocation would give (not consumed)
 *
 * Rules enforced here on top of the plain permission, and why (SPEC 2.12: numbers are never
 * reused):
 *   1. `nextValue` can be raised (to skip a block of numbers) but never lowered.
 *   2. A key whose sequence sits in the recycle bin cannot be created again: restore the
 *      deleted one instead, so its counter carries on. Restoring is refused by the unique
 *      index when a live row with the key exists meanwhile (409 unique_conflict).
 *   3. The pattern and reset policy are checked together on every write (shared rules), so
 *      a yearly sequence always carries the year in its numbers.
 *
 * Depends on: express, zod, @fibrex/shared numbering, kernel/db (repository, unit of
 * work), kernel/http (CRUD factory, errors, OpenAPI), kernel/permissions, ./numbering-service.
 * Used by: src/main.ts, the recycle bin (sequence repository).
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  MAX_PADDING,
  patternProblem,
  renderNumber,
  RESET_POLICIES,
  sequenceKeyPattern,
  type ResetPolicy,
} from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/prisma.js';
import { createRepository, type Repository } from '../db/repository.js';
import { currentUnit, type UnitOfWork } from '../db/unit-of-work.js';
import { createCrudRouter } from '../http/crud-router.js';
import { ConflictError, UnprocessableError, ValidationError } from '../http/errors.js';
import { problemSchema, registerRoute } from '../http/openapi.js';
import type { PermissionService } from '../permissions/permission-service.js';
import type { NumberingService } from './numbering-service.js';

export type NumberSequenceRow = NonNullable<
  Awaited<ReturnType<Db['numberSequence']['findFirst']>>
>;

const fields = {
  prefix: z.string().trim().max(20),
  format: z.string().trim().min(1).max(100),
  padding: z.number().int().min(1).max(MAX_PADDING),
  resetPolicy: z.enum(RESET_POLICIES),
  nextValue: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
};
const patternIssue = (format: string, resetPolicy: ResetPolicy) => {
  const problem = patternProblem(format, resetPolicy);
  if (problem !== null) {
    throw new ValidationError([{ path: 'format', message: problem, code: 'invalid_pattern' }]);
  }
};
const sequenceCreate = z.strictObject({
  key: z
    .string()
    .trim()
    .regex(sequenceKeyPattern, 'lower-case letters, digits and _, up to 50 characters'),
  prefix: fields.prefix.default(''),
  format: fields.format.default('{prefix}{number}'),
  padding: fields.padding.default(4),
  resetPolicy: fields.resetPolicy.default('never'),
  nextValue: fields.nextValue.default(1),
});
/** The key is the identity of a sequence (modules allocate by it), so it never changes. */
const sequenceUpdate = z.strictObject(fields).partial();
const sequenceItem = z
  .object({
    id: z.uuid(),
    key: z.string(),
    prefix: z.string(),
    format: z.string(),
    padding: z.number().int(),
    resetPolicy: z.enum(RESET_POLICIES),
    nextValue: z.number().int(),
    lastResetAt: z.iso.datetime().nullable(),
    /** The number the next allocation gives, rendered for today. */
    sample: z.string(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'NumberSequence' });

const previewBody = sequenceCreate.omit({ key: true });
const previewResult = z.object({ sample: z.string() }).meta({ id: 'NumberPreview' });

function sampleOf(row: NumberSequenceRow, date = new Date()): string {
  try {
    return renderNumber(row.format, {
      prefix: row.prefix,
      padding: row.padding,
      value: row.nextValue,
      date,
    });
  } catch {
    // A row written before the rules changed: show nothing rather than fail the list.
    return '';
  }
}

export function toSequenceItem(row: NumberSequenceRow) {
  return {
    id: row.id,
    key: row.key,
    prefix: row.prefix,
    format: row.format,
    padding: row.padding,
    resetPolicy: row.resetPolicy as ResetPolicy,
    nextValue: Number(row.nextValue),
    lastResetAt: row.lastResetAt?.toISOString() ?? null,
    sample: sampleOf(row),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

/** The repository behind `/number-sequences` and the recycle bin; adds rules 1 to 3. */
export function createNumberSequenceRepository(): Repository<NumberSequenceRow> {
  const base = createRepository<NumberSequenceRow>({ model: 'numberSequence', scope: 'company' });
  return {
    ...base,
    create: async (data) => {
      const body = data as z.infer<typeof sequenceCreate> & { companyId?: string };
      patternIssue(body.format, body.resetPolicy);
      const { db, context } = currentUnit();
      const companyId =
        body.companyId ?? (context.companyIds.length === 1 ? context.companyIds[0] : undefined);
      // Rule 2: the counter of a deleted sequence must carry on, not start again.
      const deleted = await db.numberSequence.findFirst({
        where: { companyId, key: body.key, deletedAt: { not: null } },
        select: { id: true },
      });
      if (deleted !== null) {
        throw new ConflictError(
          'key_in_recycle_bin',
          `A deleted sequence "${body.key}" exists; restore it from the recycle bin instead.`,
          { deletedId: deleted.id },
        );
      }
      return base.create({ ...data, nextValue: BigInt(body.nextValue) });
    },
    update: async (id, version, changes) => {
      const body = changes as z.infer<typeof sequenceUpdate>;
      const current = await base.get(id);
      patternIssue(
        body.format ?? current.format,
        body.resetPolicy ?? (current.resetPolicy as ResetPolicy),
      );
      // Rule 1: moving the counter back would hand out a number already in use.
      if (body.nextValue !== undefined && BigInt(body.nextValue) < current.nextValue) {
        throw new UnprocessableError(
          'next_value_lowered',
          `The next value is ${String(current.nextValue)} and can only be raised.`,
        );
      }
      const data: Record<string, unknown> = { ...changes };
      if (body.nextValue !== undefined) data.nextValue = BigInt(body.nextValue);
      return base.update(id, version, data);
    },
  };
}

export interface NumberingRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  numbering: NumberingService;
}

export function createNumberingRouter(deps: NumberingRouterDeps): Router {
  const { uow, registry, permissions, numbering } = deps;
  const router = Router();
  const repository = createNumberSequenceRepository();
  const idParams = z.object({ id: z.uuid() });

  // Registered before the CRUD routes so "preview" is not read as an id.
  router.post('/number-sequences/preview', async (req, res) => {
    const body = previewBody.parse(req.body);
    patternIssue(body.format, body.resetPolicy);
    await uow.run(() => permissions.require('platform.number_sequence.read'));
    res.json({
      sample: renderNumber(body.format, {
        prefix: body.prefix,
        padding: body.padding,
        value: body.nextValue,
        date: new Date(),
      }),
    });
  });

  router.get('/number-sequences/:id/next', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const sample = await uow.run(async () => {
      await permissions.require('platform.number_sequence.read');
      const row = await repository.get(id);
      return numbering.peek(row.key, { companyId: row.companyId });
    });
    res.json({ sample });
  });

  router.use(
    createCrudRouter<NumberSequenceRow>(
      { uow, authorize: permissions.authorize, registry },
      {
        path: '/number-sequences',
        resource: 'platform.number_sequence',
        tag: 'Numbering sequences',
        repository,
        schemas: { create: sequenceCreate, update: sequenceUpdate, item: sequenceItem },
        toItem: toSequenceItem,
      },
    ),
  );

  // ---- OpenAPI ------------------------------------------------------------------------
  const problem = (description: string) => ({
    description,
    content: { 'application/problem+json': { schema: problemSchema } },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/number-sequences/preview',
    tags: ['Numbering sequences'],
    summary: 'Render a sample number from settings (nothing is stored)',
    request: { body: { content: { 'application/json': { schema: previewBody } } } },
    responses: {
      200: { description: 'Sample', content: { 'application/json': { schema: previewResult } } },
      400: problem('The pattern is invalid or does not fit the reset policy'),
    },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/number-sequences/{id}/next',
    tags: ['Numbering sequences'],
    summary: 'The number the next allocation would give, without consuming it',
    request: { params: idParams },
    responses: {
      200: { description: 'Sample', content: { 'application/json': { schema: previewResult } } },
      404: problem('Not found'),
    },
  });

  return router;
}
