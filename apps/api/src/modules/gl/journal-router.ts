/**
 * Journals API (phase 2 row 2.15a; PLAN 5.11). Journals are written only by the posting
 * service, so this API reads them and reverses them; there is no create, edit or delete.
 *
 *   GET  /journals                 newest first (filters from, to, eventKey, sourceType,
 *                                  sourceId, accountId; page, pageSize)
 *   GET  /journals/{id}            the journal with its lines and its reversal, if any
 *   POST /journals/{id}/reverse    post the reversal (reason, optional entryDate; default today)
 *
 * Amounts are decimal text with 4 decimals, as stored (NUMERIC(18,4)).
 *
 * Depends on: express, zod, kernel/db, kernel/http, kernel/permissions, ./posting-service.ts.
 * Used by: ./index.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { Router } from 'express';
import { z } from 'zod';
import { MAX_PAGE_SIZE } from '../../kernel/db/repository.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { NotFoundError } from '../../kernel/http/errors.js';
import { problemSchema, registerRoute } from '../../kernel/http/openapi.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import {
  isoDay,
  toDay,
  type JournalLineRecord,
  type JournalRecord,
  type PostingService,
} from './posting-service.js';

const day = z.iso.date();
const money = z.string();

const lineItem = z
  .object({
    id: z.uuid(),
    lineNo: z.number().int(),
    accountId: z.uuid(),
    debit: money,
    credit: money,
    currency: z.string(),
    fxRate: z.string(),
    baseDebit: money,
    baseCredit: money,
    partyId: z.uuid().nullable(),
    employeePartyId: z.uuid().nullable(),
    vehicleId: z.uuid().nullable(),
    clientPlatformId: z.uuid().nullable(),
    branchId: z.uuid().nullable(),
    costCentreId: z.uuid().nullable(),
    payPeriodId: z.uuid().nullable(),
    loanId: z.uuid().nullable(),
    sourceDocType: z.string().nullable(),
    sourceDocId: z.uuid().nullable(),
    taxCodeId: z.uuid(),
    memo: z.string().nullable(),
  })
  .meta({ id: 'JournalLine' });

const journalItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    number: z.string(),
    entryDate: day,
    fiscalPeriodId: z.uuid(),
    eventKey: z.string(),
    postingRuleId: z.uuid().nullable(),
    sourceType: z.string().nullable(),
    sourceId: z.uuid().nullable(),
    description: z.string(),
    lineCount: z.number().int(),
    reversalOfId: z.uuid().nullable(),
    reversedById: z.uuid().nullable(),
    reason: z.string().nullable(),
    postedBy: z.uuid().nullable(),
    postedAt: z.iso.datetime(),
  })
  .meta({ id: 'Journal' });
const journalDetail = journalItem
  .extend({ lines: z.array(lineItem), replayed: z.boolean().optional() })
  .meta({ id: 'JournalDetail' });

const listQuery = z.object({
  from: day.optional(),
  to: day.optional(),
  eventKey: z.string().max(100).optional(),
  sourceType: z.string().max(100).optional(),
  sourceId: z.uuid().optional(),
  accountId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
});
const idParams = z.object({ id: z.uuid() });
const reverseBody = z.strictObject({
  reason: z.string().trim().min(3).max(500),
  entryDate: day.optional(),
});

export const toJournalLineItem = (l: JournalLineRecord) => ({
  id: l.id,
  lineNo: l.lineNo,
  accountId: l.accountId,
  debit: l.debit.toFixed(4),
  credit: l.credit.toFixed(4),
  currency: l.currency,
  fxRate: l.fxRate.toFixed(8),
  baseDebit: l.baseDebit.toFixed(4),
  baseCredit: l.baseCredit.toFixed(4),
  partyId: l.partyId,
  employeePartyId: l.employeePartyId,
  vehicleId: l.vehicleId,
  clientPlatformId: l.clientPlatformId,
  branchId: l.branchId,
  costCentreId: l.costCentreId,
  payPeriodId: l.payPeriodId,
  loanId: l.loanId,
  sourceDocType: l.sourceDocType,
  sourceDocId: l.sourceDocId,
  taxCodeId: l.taxCodeId,
  memo: l.memo,
});

export const toJournalItem = (j: JournalRecord, reversedById: string | null) => ({
  id: j.id,
  companyId: j.companyId,
  number: j.number,
  entryDate: isoDay(j.entryDate),
  fiscalPeriodId: j.fiscalPeriodId,
  eventKey: j.eventKey,
  postingRuleId: j.postingRuleId,
  sourceType: j.sourceType,
  sourceId: j.sourceId,
  description: j.description,
  lineCount: j.lineCount,
  reversalOfId: j.reversalOfId,
  reversedById,
  reason: j.reason,
  postedBy: j.postedBy,
  postedAt: j.postedAt.toISOString(),
});

export interface JournalRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  posting: PostingService;
}

export function createJournalRouter(deps: JournalRouterDeps): Router {
  const { uow, registry, permissions, posting } = deps;
  const router = Router();

  /** Which of these journals were reversed, and by which journal. */
  async function reversals(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await currentUnit().db.glJournal.findMany({
      where: { reversalOfId: { in: ids } },
      select: { id: true, reversalOfId: true },
    });
    return new Map(rows.map((r) => [r.reversalOfId ?? '', r.id]));
  }

  router.get('/journals', async (req, res) => {
    const q = listQuery.parse(req.query);
    const result = await uow.run(async () => {
      await permissions.require('gl.journal.read');
      const { db } = currentUnit();
      const entryDate =
        q.from === undefined && q.to === undefined
          ? undefined
          : {
              ...(q.from === undefined ? {} : { gte: toDay(q.from) }),
              ...(q.to === undefined ? {} : { lte: toDay(q.to) }),
            };
      const where = {
        ...(entryDate === undefined ? {} : { entryDate }),
        ...(q.eventKey === undefined ? {} : { eventKey: q.eventKey }),
        ...(q.sourceType === undefined ? {} : { sourceType: q.sourceType }),
        ...(q.sourceId === undefined ? {} : { sourceId: q.sourceId }),
        ...(q.accountId === undefined ? {} : { lines: { some: { accountId: q.accountId } } }),
      };
      const [rows, total] = await Promise.all([
        db.glJournal.findMany({
          where,
          orderBy: [{ entryDate: 'desc' }, { id: 'desc' }],
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
        db.glJournal.count({ where }),
      ]);
      const reversedBy = await reversals(rows.map((r) => r.id));
      return { rows, total, reversedBy };
    });
    res.json({
      items: result.rows.map((j) => toJournalItem(j, result.reversedBy.get(j.id) ?? null)),
      total: result.total,
      page: q.page,
      pageSize: q.pageSize,
    });
  });

  router.get('/journals/:id', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const detail = await uow.run(async () => {
      await permissions.require('gl.journal.read');
      const journal = await currentUnit().db.glJournal.findFirst({ where: { id } });
      if (journal === null) throw new NotFoundError('No such journal.');
      const lines = await posting.linesOf(journal);
      const reversedBy = await reversals([journal.id]);
      return {
        ...toJournalItem(journal, reversedBy.get(journal.id) ?? null),
        lines: lines.map(toJournalLineItem),
      };
    });
    res.json(detail);
  });

  router.post('/journals/:id/reverse', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const body = reverseBody.parse(req.body ?? {});
    const posted = await uow.run(async () => {
      await permissions.require('gl.journal.reverse');
      return posting.reverse(id, {
        reason: body.reason,
        ...(body.entryDate === undefined ? {} : { entryDate: body.entryDate }),
      });
    });
    res.status(201).json({
      ...toJournalItem(posted.journal, null),
      lines: posted.lines.map(toJournalLineItem),
    });
  });

  const problem = (description: string) => ({
    description,
    content: { 'application/problem+json': { schema: problemSchema } },
  });
  const tags = ['Journals'];
  registerRoute(registry, {
    method: 'get',
    path: '/journals',
    tags,
    summary: 'Posted journals, newest first',
    request: { query: listQuery },
    responses: {
      200: {
        description: 'One page of journals',
        content: {
          'application/json': {
            schema: z.object({
              items: z.array(journalItem),
              total: z.number().int(),
              page: z.number().int(),
              pageSize: z.number().int(),
            }),
          },
        },
      },
      403: problem('Missing permission'),
    },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/journals/{id}',
    tags,
    summary: 'One journal with its lines',
    request: { params: idParams },
    responses: {
      200: {
        description: 'The journal',
        content: { 'application/json': { schema: journalDetail } },
      },
      404: problem('No such journal'),
    },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/journals/{id}/reverse',
    tags,
    summary:
      'Reverse a journal: same lines, sides swapped, on entryDate (default today); once only',
    request: {
      params: idParams,
      body: { content: { 'application/json': { schema: reverseBody } } },
    },
    responses: {
      201: {
        description: 'The reversal journal',
        content: { 'application/json': { schema: journalDetail } },
      },
      403: problem('Missing permission'),
      404: problem('No such journal'),
      409: problem('Already reversed'),
      422: problem('A reversal, a date before the original, or a closed period'),
    },
  });

  return router;
}
