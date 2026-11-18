/**
 * Posting rules API (phase 2 row 2.15a; PLAN 5.11): how each business event is booked, as
 * versioned data.
 *
 *   /posting-rules                       CRUD (filters eventKey, status); only drafts change
 *   POST /posting-rules/{id}/activate    put a draft in force from its validFrom (If-Match)
 *   POST /posting-rules/{eventKey}/simulate   the journal an event would post (row 2.15b)
 *
 * Rules, and why:
 *   1. A rule belongs to one company (each company has its own chart) and one event key.
 *      Versions are numbered per company and event key; a number is never reused.
 *   2. A draft is checked when saved: its lines have both sides, every input that a resolver
 *      or dimension reads is declared as text, every amount formula compiles to a decimal
 *      over the declared inputs, and every account code it can reach is a live, postable
 *      account of the company, every tax code exists. A broken rule never reaches a posting.
 *   3. Activation checks the accounts again (one may have been deleted since), then closes
 *      the version in force the day before the new one starts (status retired) and makes the
 *      new one active. The new version must start after the one in force started. Retired
 *      versions still serve postings dated in their range, so a back-dated event is booked
 *      the way it was booked then.
 *   4. Active and retired versions are frozen (also by a database trigger): journals name
 *      the version that produced them. Only drafts can be edited or deleted.
 *   5. Simulation goes through the same posting service as a real posting (minus writing),
 *      so what it shows is what would be posted; a draft can be tried with `ruleId`. Read
 *      permission is enough because nothing is written.
 *
 * Depends on: express, zod, @fibrex/shared (posting shapes), @fibrex/formula, kernel/db,
 * kernel/http, kernel/permissions, ./posting-service.ts. Used by: ./index.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { compileFormula, FormulaError, type InputSchema } from '@fibrex/formula';
import {
  POSTING_RULE_STATUSES,
  postingEventKeySchema,
  postingRuleInputSchemaSchema,
  postingRuleLinesSchema,
  ruleAccountCodes,
  ruleInputProblems,
  type PostingRuleLine,
} from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import { VersionConflictError } from '../../kernel/db/optimistic-lock.js';
import { createRepository, type Repository } from '../../kernel/db/repository.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { createCrudRouter, parseIfMatch } from '../../kernel/http/crud-router.js';
import {
  BadRequestError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
  type FieldIssue,
} from '../../kernel/http/errors.js';
import { problemSchema, registerRoute } from '../../kernel/http/openapi.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import {
  dayBefore,
  isoDay,
  postingRuleChecksum,
  toDay,
  type PostingRuleRecord,
  type PostingService,
} from './posting-service.js';

const day = z.iso.date();

const ruleCreate = z.strictObject({
  /** Needed only when the session spans several companies. */
  companyId: z.uuid().optional(),
  eventKey: postingEventKeySchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  inputSchema: postingRuleInputSchemaSchema.default({}),
  lines: postingRuleLinesSchema,
  validFrom: day.optional(),
});
const ruleUpdate = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable(),
    inputSchema: postingRuleInputSchemaSchema,
    lines: postingRuleLinesSchema,
    validFrom: day,
  })
  .partial();
const ruleFilter = z.object({
  eventKey: z.string().max(100).optional(),
  status: z.enum(POSTING_RULE_STATUSES).optional(),
});
const ruleItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    eventKey: z.string(),
    versionNo: z.number().int(),
    name: z.string(),
    description: z.string().nullable(),
    inputSchema: z.record(z.string(), z.unknown()),
    lines: z.array(z.record(z.string(), z.unknown())),
    validFrom: day,
    validTo: day.nullable(),
    status: z.enum(POSTING_RULE_STATUSES),
    checksum: z.string(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'PostingRule' });

export const toPostingRuleItem = (row: PostingRuleRecord) => ({
  id: row.id,
  companyId: row.companyId,
  eventKey: row.eventKey,
  versionNo: row.versionNo,
  name: row.name,
  description: row.description,
  inputSchema: row.inputSchema as Record<string, unknown>,
  lines: row.lines as Record<string, unknown>[],
  validFrom: isoDay(row.validFrom),
  validTo: row.validTo === null ? null : isoDay(row.validTo),
  status: row.status as (typeof POSTING_RULE_STATUSES)[number],
  checksum: row.checksum,
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  deletedAt: row.deletedAt?.toISOString() ?? null,
});

/** Rule 2 (and the account part of rule 3): every problem of a rule, as field issues. */
async function checkRule(
  companyId: string,
  inputSchema: Record<string, { type: string }>,
  lines: PostingRuleLine[],
): Promise<void> {
  const issues: FieldIssue[] = ruleInputProblems(lines, inputSchema).map((p) => ({
    ...p,
    code: 'gl_rule_input',
  }));
  lines.forEach((line, i) => {
    try {
      compileFormula(line.amount, inputSchema as unknown as InputSchema, 'decimal');
    } catch (err) {
      if (!(err instanceof FormulaError)) throw err;
      issues.push({ path: `lines.${String(i)}.amount`, message: err.message, code: err.code });
    }
  });
  const { db } = currentUnit();
  const codes = ruleAccountCodes(lines);
  const accounts = await db.glAccount.findMany({
    where: { companyId, deletedAt: null, code: { in: codes } },
  });
  for (const code of codes) {
    const account = accounts.find((a) => a.code === code);
    if (!account?.isPostable) {
      issues.push({
        path: 'lines',
        message:
          account === undefined
            ? `Account ${code} does not exist in this company.`
            : `Account ${code} is a header account and takes no postings.`,
        code: 'gl_account_missing',
      });
    }
  }
  const taxCodes = [...new Set(lines.flatMap((l) => (l.taxCode === undefined ? [] : [l.taxCode])))];
  if (taxCodes.length > 0) {
    const found = await db.glTaxCode.findMany({
      where: { companyId, deletedAt: null, code: { in: taxCodes } },
    });
    for (const code of taxCodes.filter((c) => !found.some((t) => t.code === c))) {
      issues.push({
        path: 'lines',
        message: `Tax code ${code} does not exist.`,
        code: 'gl_tax_code_missing',
      });
    }
  }
  if (issues.length > 0) throw new ValidationError(issues, 'The posting rule has problems');
}

function companyFor(requested: string | undefined): string {
  const { context } = currentUnit();
  const companyId =
    requested ?? (context.companyIds.length === 1 ? context.companyIds[0] : undefined);
  if (companyId === undefined || !context.companyIds.includes(companyId)) {
    throw new BadRequestError(
      'company_required',
      'State which of your companies this rule is for.',
    );
  }
  return companyId;
}

/** The repository behind `/posting-rules` and the recycle bin; adds rules 1, 2 and 4. */
export function createPostingRuleRepository(): Repository<PostingRuleRecord> {
  const base = createRepository<PostingRuleRecord>({ model: 'glPostingRule', scope: 'company' });
  const frozen = () =>
    new UnprocessableError(
      'gl_posting_rule_frozen',
      'Only a draft can be changed or deleted; make a new version instead.',
    );
  return {
    ...base,
    list: (options) =>
      base.list({
        ...options,
        orderBy: options.orderBy ?? [{ eventKey: 'asc' }, { versionNo: 'desc' }],
      }),
    create: async (data) => {
      const body = data as z.infer<typeof ruleCreate>;
      const companyId = companyFor(body.companyId);
      await checkRule(companyId, body.inputSchema, body.lines);
      // Rule 1: the number counts deleted drafts too. Raw SQL because the soft-delete
      // extension hides deleted rows from Prisma reads.
      const highest = await currentUnit().db.$queryRaw<{ n: number }[]>`
        SELECT coalesce(max(version_no), 0)::int AS n FROM gl.posting_rule
         WHERE company_id = ${companyId}::uuid AND event_key = ${body.eventKey}`;
      return base.create({
        companyId,
        eventKey: body.eventKey,
        versionNo: (highest[0]?.n ?? 0) + 1,
        name: body.name,
        description: body.description ?? null,
        inputSchema: body.inputSchema,
        lines: body.lines,
        checksum: postingRuleChecksum(body.inputSchema, body.lines),
        status: 'draft',
        ...(body.validFrom === undefined ? {} : { validFrom: toDay(body.validFrom) }),
      });
    },
    update: async (id, version, changes) => {
      const current = await base.get(id);
      if (current.status !== 'draft') throw frozen();
      const body = changes as z.infer<typeof ruleUpdate> & { status?: string };
      const inputSchema =
        body.inputSchema ?? (current.inputSchema as Record<string, { type: string }>);
      const lines = body.lines ?? (current.lines as unknown as PostingRuleLine[]);
      const changesWhat = body.inputSchema !== undefined || body.lines !== undefined;
      if (changesWhat) await checkRule(current.companyId, inputSchema, lines);
      return base.update(id, version, {
        ...body,
        ...(changesWhat ? { checksum: postingRuleChecksum(inputSchema, lines) } : {}),
        ...(body.validFrom === undefined ? {} : { validFrom: toDay(body.validFrom) }),
      });
    },
    softDelete: async (id, version, reason) => {
      const current = await base.get(id);
      if (current.status !== 'draft') throw frozen();
      return base.softDelete(id, version, reason);
    },
  };
}

const eventKeyParams = z.object({ eventKey: postingEventKeySchema });
const simulateBody = z.strictObject({
  /** Needed only when the session spans several companies. */
  companyId: z.uuid().optional(),
  /** Picks the rule version, the exchange rates and the period; today when left out. */
  entryDate: day.optional(),
  inputs: z.record(z.string(), z.unknown()).default({}),
  /** Try this version (a draft, say) instead of the one in force on entryDate. */
  ruleId: z.uuid().optional(),
  description: z.string().trim().min(1).max(500).optional(),
});
const money = z.string();
const simulateResult = z
  .object({
    rule: z.object({ id: z.uuid(), versionNo: z.number().int(), status: z.string() }),
    entryDate: day,
    baseCurrency: z.string(),
    lines: z.array(
      z.object({
        lineNo: z.number().int(),
        accountId: z.uuid(),
        accountCode: z.string(),
        debit: money,
        credit: money,
        currency: z.string(),
        fxRate: z.string(),
        baseDebit: money,
        baseCredit: money,
        dimensions: z.record(z.string(), z.uuid()),
        taxCodeId: z.uuid(),
        memo: z.string().nullable(),
      }),
    ),
    totals: z.object({ debit: money, credit: money, balanced: z.boolean() }),
    period: z.object({ id: z.uuid(), status: z.string() }).nullable(),
    postable: z.boolean(),
  })
  .meta({ id: 'PostingSimulation' });

export interface PostingRuleRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  posting: PostingService;
}

export function createPostingRuleRouter(deps: PostingRuleRouterDeps): Router {
  const { uow, registry, permissions, posting } = deps;
  const router = Router();
  const rules = createPostingRuleRepository();
  const idParams = z.object({ id: z.uuid() });

  router.use(
    createCrudRouter<PostingRuleRecord>(
      { uow, authorize: permissions.authorize, registry },
      {
        path: '/posting-rules',
        resource: 'gl.posting_rule',
        tag: 'Posting rules',
        repository: rules,
        schemas: { create: ruleCreate, update: ruleUpdate, item: ruleItem, filter: ruleFilter },
        toItem: toPostingRuleItem,
        toWhere: (filter) => filter,
      },
    ),
  );

  // Rule 3.
  router.post('/posting-rules/:id/activate', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const expected = parseIfMatch(req.get('If-Match'));
    try {
      const row = await uow.run(async () => {
        await permissions.require('gl.posting_rule.activate');
        const current = await rules.get(id);
        if (current.status !== 'draft') {
          throw new UnprocessableError(
            'gl_posting_rule_not_draft',
            'Only a draft can be activated.',
          );
        }
        if (current.version !== expected) throw new VersionConflictError(expected, current, []);
        await checkRule(
          current.companyId,
          current.inputSchema as Record<string, { type: string }>,
          current.lines as unknown as PostingRuleLine[],
        );
        const { db } = currentUnit();
        const inForce = await db.glPostingRule.findFirst({
          where: {
            companyId: current.companyId,
            eventKey: current.eventKey,
            status: 'active',
            deletedAt: null,
          },
        });
        if (inForce !== null) {
          if (current.validFrom <= inForce.validFrom) {
            throw new UnprocessableError(
              'gl_posting_rule_starts_too_early',
              `The new version must start after ${isoDay(inForce.validFrom)}, when version ${String(inForce.versionNo)} started.`,
            );
          }
          await db.glPostingRule.update({
            where: { id: inForce.id },
            data: { status: 'retired', validTo: dayBefore(current.validFrom) },
          });
        }
        return rules.update(id, expected, { status: 'active' });
      });
      res.setHeader('ETag', `"${String(row.version)}"`).json(toPostingRuleItem(row));
    } catch (err) {
      if (err instanceof VersionConflictError) {
        throw err.presentedWith((r) => toPostingRuleItem(r as unknown as PostingRuleRecord));
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
    path: '/posting-rules/{id}/activate',
    tags: ['Posting rules'],
    summary:
      'Put a draft posting rule in force from its validFrom; the version in force is retired the day before (If-Match required)',
    request: { params: idParams },
    responses: {
      200: {
        description: 'The activated rule',
        content: { 'application/json': { schema: ruleItem } },
      },
      400: problem('The rule has problems (accounts, inputs, formulas)'),
      403: problem('Missing permission'),
      404: problem('No such rule'),
      409: problem('Version conflict'),
      422: problem('Not a draft, or starts too early'),
    },
  });

  // Rule 5: simulate. Runs the whole posting (rule, formulas, accounts, dimensions, rates,
  // base amounts, balance) and shows the journal it would write; writes nothing.
  router.post('/posting-rules/:eventKey/simulate', async (req, res) => {
    const { eventKey } = eventKeyParams.parse(req.params);
    const body = simulateBody.parse(req.body ?? {});
    const result = await uow.run(async () => {
      await permissions.require('gl.posting_rule.read');
      const companyId = companyFor(body.companyId);
      const entryDate = body.entryDate ?? isoDay(new Date());
      const day = toDay(entryDate);
      let rule: PostingRuleRecord;
      if (body.ruleId === undefined) {
        rule = await posting.ruleInForce(companyId, eventKey, day);
      } else {
        const found = await currentUnit().db.glPostingRule.findFirst({
          where: { id: body.ruleId, companyId, eventKey, deletedAt: null },
        });
        if (found === null) throw new NotFoundError(`No ${eventKey} rule with that id.`);
        rule = found;
      }
      const lines = await posting.linesFromRule(rule, body.inputs, day);
      const prepared = await posting.prepare({
        companyId,
        entryDate,
        eventKey,
        description: body.description ?? `Simulation of ${eventKey}`,
        lines,
        postingRuleId: rule.id,
      });
      return { rule, entryDate, prepared };
    });
    const { rule, entryDate, prepared } = result;
    res.json({
      rule: { id: rule.id, versionNo: rule.versionNo, status: rule.status },
      entryDate,
      baseCurrency: prepared.baseCurrency,
      lines: prepared.rows.map((r) => ({
        lineNo: r.lineNo,
        accountId: r.accountId,
        accountCode: r.accountCode,
        debit: r.debit,
        credit: r.credit,
        currency: r.currency,
        fxRate: r.fxRate,
        baseDebit: r.baseDebit,
        baseCredit: r.baseCredit,
        dimensions: r.dimensionFields,
        taxCodeId: r.taxCodeId,
        memo: r.memo,
      })),
      totals: prepared.totals,
      period: prepared.period,
      // Whether posting it on that day would get past the period check too.
      postable: prepared.period?.status === 'open',
    });
  });
  registerRoute(registry, {
    method: 'post',
    path: '/posting-rules/{eventKey}/simulate',
    tags: ['Posting rules'],
    summary:
      'Show the journal an event would post (rule in force on entryDate, or ruleId to try a draft); writes nothing',
    request: {
      params: eventKeyParams,
      body: { content: { 'application/json': { schema: simulateBody } } },
    },
    responses: {
      200: {
        description: 'The journal lines it would post',
        content: { 'application/json': { schema: simulateResult } },
      },
      403: problem('Missing permission'),
      404: problem('No such rule'),
      422: problem('The posting would be refused (no rule, formula, account, rate, balance)'),
    },
  });

  return router;
}
