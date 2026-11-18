/**
 * Manual journals API (phase 2 row 2.15b; PLAN 3.9 `manual_journal`, PLAN 5.11): journals an
 * accountant writes by hand, kept as drafts until posted.
 *
 *   /manual-journals                   CRUD (filters status, from, to); only drafts change
 *   POST /manual-journals/{id}/post    post the draft through the posting service (If-Match)
 *
 * Rules, and why:
 *   1. A draft gets its number (gapless sequence `gl.manual_journal`, default MJ-YYYY-00001,
 *      yearly by entry date) when it is created, so people can refer to it while it is being
 *      written. A deleted draft keeps its number; it is never handed out again.
 *   2. A draft's lines are checked for shape only (shared `manualJournalLineSchema`): it may be
 *      unbalanced or name a missing rate while someone is still working on it.
 *   3. Posting runs every check of the posting service (accounts, dimensions, tax codes, rates
 *      and base amounts, balance, open period) and writes the journal with event key
 *      `gl.manual_journal`, source = this manual journal. The idempotency key is the manual
 *      journal's id, so the same draft can never become two journals, even if two people press
 *      Post together (the second one gets a version conflict or the first journal back).
 *   4. A posted manual journal never changes and cannot be deleted (also a database trigger);
 *      the correction is a reversal of its journal (POST /journals/{id}/reverse).
 *   5. Status `submitted` is reserved for an approval step bound later through the workflow
 *      engine; this API moves draft -> posted only.
 *
 * Depends on: express, zod, @fibrex/shared (manual journal shapes), kernel/db, kernel/http,
 * kernel/numbering, kernel/permissions, ./posting-service.ts, ./journal-router.ts (output
 * shape). Used by: ./index.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { MANUAL_JOURNAL_STATUSES, manualJournalLinesSchema } from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import { VersionConflictError } from '../../kernel/db/optimistic-lock.js';
import { createRepository, type Repository } from '../../kernel/db/repository.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { createCrudRouter, parseIfMatch } from '../../kernel/http/crud-router.js';
import { BadRequestError, UnprocessableError } from '../../kernel/http/errors.js';
import { problemSchema, registerRoute } from '../../kernel/http/openapi.js';
import { NumberingService } from '../../kernel/numbering/numbering-service.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import type { Db } from '../../kernel/db/prisma.js';
import { toJournalItem, toJournalLineItem } from './journal-router.js';
import { isoDay, toDay, type PostingLineInput, type PostingService } from './posting-service.js';

export type ManualJournalRecord = NonNullable<
  Awaited<ReturnType<Db['glManualJournal']['findFirst']>>
>;

/** Event key and source type of every journal posted from a manual journal. */
export const MANUAL_JOURNAL_EVENT = 'gl.manual_journal';

const day = z.iso.date();

const mjCreate = z.strictObject({
  /** Needed only when the session spans several companies. */
  companyId: z.uuid().optional(),
  entryDate: day,
  description: z.string().trim().min(1).max(500),
  lines: manualJournalLinesSchema.default([]),
});
const mjUpdate = z
  .strictObject({
    entryDate: day,
    description: z.string().trim().min(1).max(500),
    lines: manualJournalLinesSchema,
  })
  .partial();
const mjFilter = z.object({
  status: z.enum(MANUAL_JOURNAL_STATUSES).optional(),
  from: day.optional(),
  to: day.optional(),
});
const mjItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    number: z.string(),
    entryDate: day,
    description: z.string(),
    lines: z.array(z.record(z.string(), z.unknown())),
    status: z.enum(MANUAL_JOURNAL_STATUSES),
    journalId: z.uuid().nullable(),
    postedAt: z.iso.datetime().nullable(),
    postedBy: z.uuid().nullable(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'ManualJournal' });

export const toManualJournalItem = (row: ManualJournalRecord) => ({
  id: row.id,
  companyId: row.companyId,
  number: row.number,
  entryDate: isoDay(row.entryDate),
  description: row.description,
  lines: row.lines as Record<string, unknown>[],
  status: row.status as (typeof MANUAL_JOURNAL_STATUSES)[number],
  journalId: row.journalId,
  postedAt: row.postedAt?.toISOString() ?? null,
  postedBy: row.postedBy,
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  deletedAt: row.deletedAt?.toISOString() ?? null,
});

function companyFor(requested: string | undefined): string {
  const { context } = currentUnit();
  const companyId =
    requested ?? (context.companyIds.length === 1 ? context.companyIds[0] : undefined);
  if (companyId === undefined || !context.companyIds.includes(companyId)) {
    throw new BadRequestError(
      'company_required',
      'State which of your companies this journal is for.',
    );
  }
  return companyId;
}

const notDraft = () =>
  new UnprocessableError(
    'gl_manual_journal_not_draft',
    'Only a draft manual journal can be changed or deleted; reverse its journal instead.',
  );

/** The repository behind `/manual-journals` and the recycle bin; adds rules 1, 2 and 4. */
export function createManualJournalRepository(
  numbering = new NumberingService(),
): Repository<ManualJournalRecord> {
  const base = createRepository<ManualJournalRecord>({
    model: 'glManualJournal',
    scope: 'company',
  });
  return {
    ...base,
    list: (options) =>
      base.list({
        ...options,
        orderBy: options.orderBy ?? [{ entryDate: 'desc' }, { number: 'desc' }],
      }),
    create: async (data) => {
      const body = data as z.infer<typeof mjCreate>;
      const companyId = companyFor(body.companyId);
      const entryDate = toDay(body.entryDate);
      // Rule 1: the number is taken in this transaction (gapless).
      const { number } = await numbering.allocate('gl.manual_journal', {
        companyId,
        date: entryDate,
        defaults: { format: 'MJ-{YYYY}-{00000}', resetPolicy: 'yearly' },
      });
      return base.create({
        companyId,
        number,
        entryDate,
        description: body.description,
        lines: body.lines,
        status: 'draft',
      });
    },
    update: async (id, version, changes) => {
      const current = await base.get(id);
      if (current.status !== 'draft') throw notDraft();
      const body = changes as z.infer<typeof mjUpdate>;
      return base.update(id, version, {
        ...body,
        ...(body.entryDate === undefined ? {} : { entryDate: toDay(body.entryDate) }),
      });
    },
    softDelete: async (id, version, reason) => {
      const current = await base.get(id);
      if (current.status === 'posted') throw notDraft();
      return base.softDelete(id, version, reason);
    },
  };
}

export interface ManualJournalRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  posting: PostingService;
}

export function createManualJournalRouter(deps: ManualJournalRouterDeps): Router {
  const { uow, registry, permissions, posting } = deps;
  const router = Router();
  const journals = createManualJournalRepository();
  const base = createRepository<ManualJournalRecord>({
    model: 'glManualJournal',
    scope: 'company',
  });
  const idParams = z.object({ id: z.uuid() });

  router.use(
    createCrudRouter<ManualJournalRecord>(
      { uow, authorize: permissions.authorize, registry },
      {
        path: '/manual-journals',
        resource: 'gl.manual_journal',
        tag: 'Manual journals',
        repository: journals,
        schemas: { create: mjCreate, update: mjUpdate, item: mjItem, filter: mjFilter },
        toItem: toManualJournalItem,
        toWhere: (filter) => {
          const f = filter as z.infer<typeof mjFilter>;
          const entryDate =
            f.from === undefined && f.to === undefined
              ? undefined
              : {
                  ...(f.from === undefined ? {} : { gte: toDay(f.from) }),
                  ...(f.to === undefined ? {} : { lte: toDay(f.to) }),
                };
          return {
            ...(f.status === undefined ? {} : { status: f.status }),
            ...(entryDate === undefined ? {} : { entryDate }),
          };
        },
      },
    ),
  );

  // Rule 3.
  router.post('/manual-journals/:id/post', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const expected = parseIfMatch(req.get('If-Match'));
    try {
      const result = await uow.run(async () => {
        await permissions.require('gl.manual_journal.post');
        const current = await base.get(id);
        if (current.status === 'posted') {
          throw new UnprocessableError(
            'gl_manual_journal_posted',
            `Manual journal ${current.number} is already posted.`,
          );
        }
        if (current.version !== expected) throw new VersionConflictError(expected, current, []);
        // Stored lines were checked on save; parse again so a hand-edited row cannot slip by.
        const lines = manualJournalLinesSchema.parse(current.lines) as PostingLineInput[];
        const posted = await posting.post({
          companyId: current.companyId,
          entryDate: isoDay(current.entryDate),
          eventKey: MANUAL_JOURNAL_EVENT,
          description: `${current.number}: ${current.description}`.slice(0, 500),
          lines,
          source: { type: MANUAL_JOURNAL_EVENT, id: current.id },
          idempotencyKey: `${MANUAL_JOURNAL_EVENT}:${current.id}`,
        });
        const row = await base.update(id, expected, {
          status: 'posted',
          journalId: posted.journal.id,
        });
        return { row, posted };
      });
      res.setHeader('ETag', `"${String(result.row.version)}"`).json({
        ...toManualJournalItem(result.row),
        journal: {
          ...toJournalItem(result.posted.journal, null),
          lines: result.posted.lines.map(toJournalLineItem),
        },
      });
    } catch (err) {
      if (err instanceof VersionConflictError) {
        throw err.presentedWith((r) => toManualJournalItem(r as unknown as ManualJournalRecord));
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
    path: '/manual-journals/{id}/post',
    tags: ['Manual journals'],
    summary:
      'Post a draft manual journal through the posting service (If-Match required); it is then frozen',
    request: { params: idParams },
    responses: {
      200: {
        description: 'The posted manual journal with its journal',
        content: {
          'application/json': {
            schema: mjItem.extend({ journal: z.record(z.string(), z.unknown()) }),
          },
        },
      },
      403: problem('Missing permission'),
      404: problem('No such manual journal'),
      409: problem('Version conflict'),
      422: problem('Already posted, or the posting service refused it (balance, period, rate ...)'),
    },
  });

  return router;
}
