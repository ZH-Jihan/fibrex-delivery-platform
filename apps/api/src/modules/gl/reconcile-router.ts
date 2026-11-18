/**
 * Bank reconciliation API (phase 2 row 2.17b; PLAN 3.9, SPEC 2.9).
 *
 *   /bank-match-rules                       CRUD (filter active); saved rules for auto-matching
 *   /reconciliation-matches                 list, get, create (manual match), delete (unmatch)
 *   POST /bank-statements/{id}/auto-match   match what can be matched safely
 *   GET  /bank-statements/{id}/reconciliation   the lines with their match, for the screen
 *   GET  /bank-statement-lines/{id}/candidates  ledger lines a line could be matched with
 *
 * Rules, and why (money rules: never guess):
 *   1. A match pairs one statement line with one ledger (journal) line for the WHOLE signed
 *      amount, in the same currency, on the cash account of that statement's bank account
 *      (money in = a debit, money out = a credit). No partial matches. The database trigger
 *      enforces the same, so no code path can store a wrong pairing.
 *   2. The ledger is never touched: matching and unmatching write only the match row and the
 *      line's `match_status` / the statement's `status`. A difference between bank and book
 *      is fixed by posting a journal (through the posting service) and matching that.
 *   3. Auto-matching is conservative. For each unmatched line it tries the active rules in
 *      priority order and then the plain pass (same amount, within the date window, nothing
 *      else). It matches only when exactly ONE ledger line qualifies AND no other unmatched
 *      line of the statement has the same amount within twice the window (those would
 *      compete for the same entry). Anything ambiguous is left for a person.
 *   4. Unmatching is a soft delete with a reason; the line becomes unmatched again and a
 *      reconciled statement goes back to open. A match is never edited or restored: match
 *      again instead.
 *   5. A statement is `reconciled` when it has no unmatched live line.
 *
 * Depends on: express, zod, @fibrex/shared (reconcile rules), kernel/db, kernel/http,
 * kernel/permissions. Used by: ./index.ts (the gl module manifest).
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  bankMatchRuleCreateSchema,
  bankMatchRuleUpdateSchema,
  daysBetween,
  lineSatisfiesConditions,
  matchCandidatesQuerySchema,
  matchConditionsSchema,
  reconciliationMatchCreateSchema,
  reconciliationMatchUpdateSchema,
  windowDaysOf,
  type MatchConditions,
} from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../../kernel/db/prisma.js';
import { createRepository, type Repository } from '../../kernel/db/repository.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { createCrudRouter } from '../../kernel/http/crud-router.js';
import { NotFoundError, UnprocessableError, ValidationError } from '../../kernel/http/errors.js';
import { registerRoute } from '../../kernel/http/openapi.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';

export type BankMatchRuleRecord = NonNullable<
  Awaited<ReturnType<Db['glBankMatchRule']['findFirst']>>
>;
export type ReconciliationMatchRecord = NonNullable<
  Awaited<ReturnType<Db['glReconciliationMatch']['findFirst']>>
>;

const DAY_MS = 86_400_000;
const CANDIDATE_LIMIT = 50;
/** How many same-amount ledger lines are read before the matched ones are left out. */
const CANDIDATE_SCAN = 500;
const day = z.iso.date();
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const shiftDay = (d: Date, days: number) => new Date(d.getTime() + days * DAY_MS);
const invalid = (path: string, message: string, code: string) =>
  new ValidationError([{ path, message, code }]);

const stampShape = {
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
};
const stamps = (row: {
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}) => ({
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  deletedAt: row.deletedAt?.toISOString() ?? null,
});

const ruleItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    name: z.string(),
    conditions: matchConditionsSchema,
    targetAccountId: z.uuid().nullable(),
    targetPartyId: z.uuid().nullable(),
    priority: z.number().int(),
    active: z.boolean(),
    ...stampShape,
  })
  .meta({ id: 'BankMatchRule' });
const ruleFilter = z.object({
  active: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

const matchItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    statementLineId: z.uuid(),
    journalLineId: z.uuid(),
    journalLineDate: day,
    amount: z.string(),
    method: z.enum(['rule', 'manual']),
    ruleId: z.uuid().nullable(),
    matchedBy: z.uuid().nullable(),
    ...stampShape,
  })
  .meta({ id: 'ReconciliationMatch' });
const matchFilter = z.object({
  statementId: z.uuid().optional(),
  statementLineId: z.uuid().optional(),
  method: z.enum(['rule', 'manual']).optional(),
});

/** The stored conditions as the shared type; a damaged value counts as "no conditions". */
function conditionsOf(value: unknown): MatchConditions {
  const parsed = matchConditionsSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

export const toRuleItem = (row: BankMatchRuleRecord) => ({
  id: row.id,
  companyId: row.companyId,
  name: row.name,
  conditions: conditionsOf(row.conditions),
  targetAccountId: row.targetAccountId,
  targetPartyId: row.targetPartyId,
  priority: row.priority,
  active: row.active,
  ...stamps(row),
});

export const toMatchItem = (row: ReconciliationMatchRecord) => ({
  id: row.id,
  companyId: row.companyId,
  statementLineId: row.statementLineId,
  journalLineId: row.journalLineId,
  journalLineDate: isoDay(row.journalLineDate),
  amount: row.amount.toFixed(4),
  method: row.method as 'rule' | 'manual',
  ruleId: row.ruleId,
  matchedBy: row.matchedBy,
  ...stamps(row),
});

// ---------------------------------------------------------------------------
// Matching core (all inside the caller's unit of work)
// ---------------------------------------------------------------------------

interface LineContext {
  line: NonNullable<Awaited<ReturnType<Db['glBankStatementLine']['findFirst']>>>;
  /** The ledger account whose balance this statement's bank account carries. */
  cashAccountId: string;
}

/** Loads a live statement line with the cash account of its statement's bank account. */
async function loadLine(db: Db, lineId: string): Promise<LineContext> {
  const line = await db.glBankStatementLine.findFirst({
    where: { id: lineId, deletedAt: null },
    include: { statement: { include: { bankAccount: { include: { cashLocation: true } } } } },
  });
  if (line === null) throw new NotFoundError();
  if (line.statement.deletedAt !== null) throw new NotFoundError();
  return { line, cashAccountId: line.statement.bankAccount.cashLocation.accountId };
}

interface CandidateFilter {
  windowDays: number;
  targetAccountId?: string | null;
  targetPartyId?: string | null;
  limit?: number;
}

/**
 * Ledger lines the statement line could be matched with: on the cash account, same currency,
 * exactly the same amount on the right side, dated within the window, and not matched yet.
 * A rule may narrow it to entries that also touch a counter account or carry a party.
 */
async function findCandidates(db: Db, ctx: LineContext, filter: CandidateFilter) {
  const { line, cashAccountId } = ctx;
  const size = line.amount.abs().toFixed(4);
  const journalFilters: Record<string, unknown>[] = [];
  if (filter.targetAccountId)
    journalFilters.push({ lines: { some: { accountId: filter.targetAccountId } } });
  if (filter.targetPartyId)
    journalFilters.push({ lines: { some: { partyId: filter.targetPartyId } } });
  const found = await db.glJournalLine.findMany({
    where: {
      accountId: cashAccountId,
      currency: line.currency,
      entryDate: {
        gte: shiftDay(line.valueDate, -filter.windowDays),
        lte: shiftDay(line.valueDate, filter.windowDays),
      },
      // Money in is a debit on the cash account; money out is a credit.
      ...(line.amount.isPositive() ? { debit: size } : { credit: size }),
      ...(journalFilters.length > 0 ? { journal: { AND: journalFilters } } : {}),
    },
    include: { journal: { select: { id: true, number: true, description: true } } },
    orderBy: [{ entryDate: 'asc' }, { id: 'asc' }],
    take: CANDIDATE_SCAN,
  });
  // Leave out lines already matched. (The match table has no relation to the partitioned
  // journal_line, so this is a second query rather than a join.)
  const used = new Set(
    (
      await db.glReconciliationMatch.findMany({
        where: { deletedAt: null, journalLineId: { in: found.map((row) => row.id) } },
        select: { journalLineId: true },
      })
    ).map((m) => m.journalLineId),
  );
  return found.filter((row) => !used.has(row.id)).slice(0, filter.limit ?? CANDIDATE_LIMIT);
}

/** Sets a line's status and the statement's status (reconciled when nothing is open). */
async function refreshStatus(db: Db, lineId: string, statementId: string, matched: boolean) {
  await db.glBankStatementLine.updateMany({
    where: { id: lineId },
    data: { matchStatus: matched ? 'matched' : 'unmatched' },
  });
  const open = await db.glBankStatementLine.count({
    where: { statementId, deletedAt: null, matchStatus: 'unmatched' },
  });
  const status = open === 0 ? 'reconciled' : 'open';
  await db.glBankStatement.updateMany({
    where: { id: statementId, status: { not: status } },
    data: { status },
  });
}

export function createMatchRepository(): MatchRepository {
  const base = createRepository<ReconciliationMatchRecord>({
    model: 'glReconciliationMatch',
    scope: 'company',
  });

  /** Checks the pairing (rule 1) and stores it; shared by manual and automatic matching. */
  async function record(
    ctx: LineContext,
    journalLineId: string,
    method: 'rule' | 'manual',
    ruleId: string | null,
  ): Promise<ReconciliationMatchRecord> {
    const { db, context } = currentUnit();
    const { line, cashAccountId } = ctx;
    const journalLine = await db.glJournalLine.findFirst({ where: { id: journalLineId } });
    if (journalLine === null) {
      throw invalid('journalLineId', 'This ledger line does not exist.', 'unknown_journal_line');
    }
    if (journalLine.accountId !== cashAccountId) {
      throw new UnprocessableError(
        'gl_match_wrong_account',
        "This ledger line is not on the bank account's cash account.",
      );
    }
    const signed = journalLine.debit.minus(journalLine.credit);
    if (journalLine.currency !== line.currency || !signed.equals(line.amount)) {
      throw new UnprocessableError(
        'gl_match_amount',
        'The ledger line must have exactly the same amount and currency as the statement line.',
      );
    }
    const taken =
      (await db.glReconciliationMatch.count({
        where: { statementLineId: line.id, deletedAt: null },
      })) +
      (await db.glReconciliationMatch.count({
        where: { journalLineId: journalLine.id, deletedAt: null },
      }));
    if (taken > 0) {
      throw new UnprocessableError(
        'gl_match_taken',
        'The statement line or the ledger line is already matched.',
      );
    }
    const created = await base.create({
      companyId: line.companyId,
      statementLineId: line.id,
      journalLineId: journalLine.id,
      journalLineDate: journalLine.entryDate,
      amount: line.amount,
      matchedBy: context.userId ?? null,
      method,
      ruleId,
    });
    await refreshStatus(db, line.id, line.statementId, true);
    return created;
  }

  return {
    ...base,
    list: (options) =>
      base.list({ ...options, orderBy: options.orderBy ?? [{ createdAt: 'desc' }, { id: 'asc' }] }),

    create: async (data) => {
      const body = data as z.infer<typeof reconciliationMatchCreateSchema>;
      const ctx = await loadLine(currentUnit().db, body.statementLineId).catch((err: unknown) => {
        if (err instanceof NotFoundError) {
          throw invalid('statementLineId', 'This statement line does not exist.', 'unknown_line');
        }
        throw err;
      });
      return record(ctx, body.journalLineId, 'manual', null);
    },

    update: () => {
      throw new UnprocessableError(
        'gl_match_immutable',
        'A match cannot be changed; unmatch it and match again.',
      );
    },

    softDelete: async (id, version, reason) => {
      const { db } = currentUnit();
      const current = await base.get(id);
      const deleted = await base.softDelete(id, version, reason);
      const line = await db.glBankStatementLine.findFirst({
        where: { id: current.statementLineId },
        select: { id: true, statementId: true },
      });
      if (line !== null) await refreshStatus(db, line.id, line.statementId, false);
      return deleted;
    },

    restore: () => {
      throw new UnprocessableError(
        'gl_match_immutable',
        'A match cannot be restored; match the lines again.',
      );
    },
    // Used by auto-matching below, which needs `record` without the HTTP-shaped create.
    record,
  };
}

type MatchRepository = Repository<ReconciliationMatchRecord> & {
  record: (
    ctx: LineContext,
    journalLineId: string,
    method: 'rule' | 'manual',
    ruleId: string | null,
  ) => Promise<ReconciliationMatchRecord>;
};

export function createRuleRepository(): Repository<BankMatchRuleRecord> {
  const base = createRepository<BankMatchRuleRecord>({
    model: 'glBankMatchRule',
    scope: 'company',
  });
  /** A rule's targets must exist (the account by key in the database, the party here). */
  async function checkTargets(data: Record<string, unknown>) {
    const { db } = currentUnit();
    const account = data.targetAccountId;
    if (typeof account === 'string') {
      const found = await db.glAccount.findFirst({ where: { id: account, deletedAt: null } });
      if (found === null) {
        throw invalid('targetAccountId', 'This account does not exist.', 'unknown_account');
      }
    }
    const party = data.targetPartyId;
    if (typeof party === 'string') {
      const found = await db.party.findFirst({ where: { id: party }, select: { id: true } });
      if (found === null) {
        throw invalid('targetPartyId', 'This party does not exist.', 'unknown_party');
      }
    }
  }
  return {
    ...base,
    list: (options) =>
      base.list({
        ...options,
        orderBy: options.orderBy ?? [{ priority: 'asc' }, { name: 'asc' }],
      }),
    create: async (data) => {
      await checkTargets(data);
      return base.create(data);
    },
    update: async (id, version, changes) => {
      await checkTargets(changes);
      return base.update(id, version, changes);
    },
  };
}

/** The outcome of one automatic matching run. */
export interface AutoMatchResult {
  matched: number;
  ambiguous: number;
  unmatched: number;
  items: { statementLineId: string; journalLineId: string; ruleId: string | null }[];
}

/**
 * Rule 3: tries to match every unmatched line of the statement. Steps for one line:
 *   1. For each active rule (priority order) whose conditions hold for the line, find the
 *      ledger lines inside that rule's window and targets; exactly one qualifies -> match.
 *   2. Then the plain pass with the default window and no targets.
 *   3. More than one candidate, or a rival statement line with the same amount close in
 *      date, means "ambiguous": the line is left for a person.
 */
async function autoMatchStatement(
  repository: MatchRepository,
  statementId: string,
): Promise<AutoMatchResult> {
  const { db } = currentUnit();
  const statement = await db.glBankStatement.findFirst({ where: { id: statementId } });
  if (statement === null) throw new NotFoundError();
  const lines = await db.glBankStatementLine.findMany({
    where: { statementId, deletedAt: null, matchStatus: 'unmatched' },
    orderBy: [{ lineNo: 'asc' }],
  });
  const rules = await db.glBankMatchRule.findMany({
    where: { active: true, deletedAt: null },
    orderBy: [{ priority: 'asc' }, { name: 'asc' }],
  });
  const result: AutoMatchResult = { matched: 0, ambiguous: 0, unmatched: 0, items: [] };
  const open = new Map(lines.map((l) => [l.id, l]));

  for (const line of lines) {
    const ctx = await loadLine(db, line.id);
    const attempts: {
      ruleId: string | null;
      conditions: MatchConditions;
      filter: CandidateFilter;
    }[] = [];
    for (const rule of rules) {
      const conditions = conditionsOf(rule.conditions);
      if (
        !lineSatisfiesConditions(
          {
            amount: line.amount.toFixed(4),
            reference: line.reference,
            description: line.description,
          },
          conditions,
        )
      ) {
        continue;
      }
      attempts.push({
        ruleId: rule.id,
        conditions,
        filter: {
          windowDays: windowDaysOf(conditions),
          targetAccountId: rule.targetAccountId,
          targetPartyId: rule.targetPartyId,
          limit: 2,
        },
      });
    }
    attempts.push({
      ruleId: null,
      conditions: {},
      filter: { windowDays: windowDaysOf(null), limit: 2 },
    });

    let done = false;
    let sawAmbiguity = false;
    for (const attempt of attempts) {
      const found = await findCandidates(db, ctx, attempt.filter);
      const only = found[0];
      if (only === undefined) continue;
      const window = attempt.filter.windowDays;
      const rivals = [...open.values()].filter(
        (other) =>
          other.id !== line.id &&
          other.amount.equals(line.amount) &&
          daysBetween(isoDay(other.valueDate), isoDay(line.valueDate)) <= 2 * window,
      );
      if (found.length > 1 || rivals.length > 0) {
        sawAmbiguity = true;
        continue;
      }
      const match = await repository.record(ctx, only.id, 'rule', attempt.ruleId);
      open.delete(line.id);
      result.matched += 1;
      result.items.push({
        statementLineId: line.id,
        journalLineId: match.journalLineId,
        ruleId: attempt.ruleId,
      });
      done = true;
      break;
    }
    if (!done && sawAmbiguity) result.ambiguous += 1;
  }
  result.unmatched = open.size;
  return result;
}

const idParams = z.object({ id: z.uuid() });
const autoMatchResponse = z.object({
  matched: z.number().int(),
  ambiguous: z.number().int(),
  unmatched: z.number().int(),
  items: z.array(
    z.object({
      statementLineId: z.uuid(),
      journalLineId: z.uuid(),
      ruleId: z.uuid().nullable(),
    }),
  ),
});
const candidateItem = z.object({
  journalLineId: z.uuid(),
  entryDate: day,
  journalId: z.uuid(),
  journalNumber: z.string(),
  description: z.string().nullable(),
  memo: z.string().nullable(),
  partyId: z.uuid().nullable(),
  amount: z.string(),
  currency: z.string(),
});
const screenLine = z.object({
  id: z.uuid(),
  lineNo: z.number().int(),
  valueDate: day,
  amount: z.string(),
  currency: z.string(),
  reference: z.string().nullable(),
  description: z.string().nullable(),
  matchStatus: z.enum(['unmatched', 'matched']),
  match: z
    .object({
      id: z.uuid(),
      version: z.number().int(),
      method: z.enum(['rule', 'manual']),
      journalLineId: z.uuid(),
      journalId: z.uuid(),
      journalNumber: z.string(),
      entryDate: day,
    })
    .nullable(),
});
const screenQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(100),
  matchStatus: z.enum(['unmatched', 'matched']).optional(),
});

export interface ReconcileRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
}

export function createReconcileRouter(deps: ReconcileRouterDeps): Router {
  const { uow, registry, permissions } = deps;
  const router = Router();
  const crud = { uow, authorize: permissions.authorize, registry };

  router.post('/bank-statements/:id/auto-match', async (req, res) => {
    const id = idParams.parse(req.params).id;
    const result = await uow.run(async () => {
      await permissions.require('gl.reconciliation.auto');
      return autoMatchStatement(createMatchRepository(), id);
    });
    res.json(result);
  });
  registerRoute(registry, {
    method: 'post',
    path: '/bank-statements/{id}/auto-match',
    tags: ['Reconciliation'],
    summary: 'Match the statement lines that have exactly one safe candidate',
    request: { params: idParams },
    responses: {
      200: {
        description: 'What was matched and what was left for a person',
        content: { 'application/json': { schema: autoMatchResponse } },
      },
    },
  });

  router.get('/bank-statements/:id/reconciliation', async (req, res) => {
    const id = idParams.parse(req.params).id;
    const query = screenQuery.parse(req.query);
    const result = await uow.run(async () => {
      await permissions.require('gl.reconciliation.read');
      const { db } = currentUnit();
      const statement = await db.glBankStatement.findFirst({ where: { id }, select: { id: true } });
      if (statement === null) throw new NotFoundError();
      const where = {
        statementId: id,
        deletedAt: null,
        ...(query.matchStatus === undefined ? {} : { matchStatus: query.matchStatus }),
      };
      const [rows, total] = await Promise.all([
        db.glBankStatementLine.findMany({
          where,
          orderBy: [{ lineNo: 'asc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          include: {
            matches: { where: { deletedAt: null } },
          },
        }),
        db.glBankStatementLine.count({ where }),
      ]);
      // The journal behind each match (looked up by line id; see findCandidates).
      const journalLines = await db.glJournalLine.findMany({
        where: { id: { in: rows.flatMap((row) => row.matches.map((m) => m.journalLineId)) } },
        select: { id: true, journal: { select: { id: true, number: true } } },
      });
      const journalOf = new Map(journalLines.map((jl) => [jl.id, jl.journal]));
      const items = rows.map((row) => {
        const m = row.matches[0];
        const journal = m === undefined ? undefined : journalOf.get(m.journalLineId);
        return {
          id: row.id,
          lineNo: row.lineNo,
          valueDate: isoDay(row.valueDate),
          amount: row.amount.toFixed(4),
          currency: row.currency,
          reference: row.reference,
          description: row.description,
          matchStatus: row.matchStatus as 'unmatched' | 'matched',
          match:
            m === undefined || journal === undefined
              ? null
              : {
                  id: m.id,
                  version: m.version,
                  method: m.method as 'rule' | 'manual',
                  journalLineId: m.journalLineId,
                  journalId: journal.id,
                  journalNumber: journal.number,
                  entryDate: isoDay(m.journalLineDate),
                },
        };
      });
      return { items, total, page: query.page, pageSize: query.pageSize };
    });
    res.json(result);
  });
  registerRoute(registry, {
    method: 'get',
    path: '/bank-statements/{id}/reconciliation',
    tags: ['Reconciliation'],
    summary: 'The lines of a statement with the ledger entry each one is matched to',
    request: { params: idParams, query: screenQuery },
    responses: {
      200: {
        description: 'A page of lines',
        content: {
          'application/json': {
            schema: z.object({
              items: z.array(screenLine),
              total: z.number().int(),
              page: z.number().int(),
              pageSize: z.number().int(),
            }),
          },
        },
      },
    },
  });

  router.get('/bank-statement-lines/:id/candidates', async (req, res) => {
    const id = idParams.parse(req.params).id;
    const query = matchCandidatesQuerySchema.parse(req.query);
    const result = await uow.run(async () => {
      await permissions.require('gl.reconciliation.read');
      const { db } = currentUnit();
      const ctx = await loadLine(db, id);
      const found = await findCandidates(db, ctx, { windowDays: query.windowDays ?? 30 });
      return found.map((row) => ({
        journalLineId: row.id,
        entryDate: isoDay(row.entryDate),
        journalId: row.journal.id,
        journalNumber: row.journal.number,
        description: row.journal.description,
        memo: row.memo,
        partyId: row.partyId,
        amount: row.debit.minus(row.credit).toFixed(4),
        currency: row.currency,
      }));
    });
    res.json({ items: result });
  });
  registerRoute(registry, {
    method: 'get',
    path: '/bank-statement-lines/{id}/candidates',
    tags: ['Reconciliation'],
    summary: 'Unmatched ledger lines with exactly the same amount as a statement line',
    request: { params: idParams, query: matchCandidatesQuerySchema },
    responses: {
      200: {
        description: 'Candidate ledger lines, oldest first',
        content: { 'application/json': { schema: z.object({ items: z.array(candidateItem) }) } },
      },
    },
  });

  router.use(
    createCrudRouter<BankMatchRuleRecord>(crud, {
      path: '/bank-match-rules',
      resource: 'gl.bank_match_rule',
      tag: 'Bank match rules',
      repository: createRuleRepository(),
      schemas: {
        create: bankMatchRuleCreateSchema,
        update: bankMatchRuleUpdateSchema,
        item: ruleItem,
        filter: ruleFilter,
      },
      toItem: toRuleItem,
      toWhere: (filter) => filter,
    }),
  );
  router.use(
    createCrudRouter<ReconciliationMatchRecord>(crud, {
      path: '/reconciliation-matches',
      resource: 'gl.reconciliation',
      tag: 'Reconciliation',
      repository: createMatchRepository(),
      schemas: {
        create: reconciliationMatchCreateSchema,
        update: reconciliationMatchUpdateSchema,
        item: matchItem,
        filter: matchFilter,
      },
      toItem: toMatchItem,
      toWhere: (filter) => {
        const { statementId, ...rest } = filter as { statementId?: string };
        return statementId === undefined ? rest : { ...rest, statementLine: { statementId } };
      },
    }),
  );
  return router;
}
