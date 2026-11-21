/**
 * Daily performance summary API (phase 4 row 4.6b).
 *
 *   GET  /performance/summary?companyId=            settings (recipients, send time, time zone,
 *                                                   on/off), the date "Send now" would use and
 *                                                   the last sent summaries
 *   PUT  /performance/summary?companyId=            save the settings (audited by trigger)
 *   POST /performance/summary/send-now?companyId=   send the summary of a date now (default
 *                                                   yesterday); 409 when that date was already
 *                                                   sent, 422 when no recipients are set
 *
 * All three need `performance.summary.manage`. Sending goes through the same service method
 * as the schedule, so the sent log guards both: one email per company and date, whoever asks.
 *
 * Depends on: express, zod, @fibrex/shared (settings schema), kernel/db, kernel/http,
 * ./summary-service.ts. Used by: ./index.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  SUMMARY_INCOMPLETE_REASONS,
  summarySendNowSchema,
  summarySettingsSchema,
} from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { ConflictError, UnprocessableError, ValidationError } from '../../kernel/http/errors.js';
import { registerRoute } from '../../kernel/http/openapi.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import {
  readSummarySettings,
  writeSummarySettings,
  type SummaryService,
} from './summary-service.js';

export const SUMMARY_MANAGE = 'performance.summary.manage';

const companyQuery = z.object({ companyId: z.uuid().optional() });
const recentRow = z.object({
  date: z.iso.date(),
  variant: z.enum(['full', 'incomplete']),
  reason: z.enum(SUMMARY_INCOMPLETE_REASONS).nullable(),
  trigger: z.enum(['scheduled', 'manual']),
  recipients: z.number().int(),
  sentAt: z.string(),
});
const summaryResponse = z
  .object({
    companyId: z.uuid(),
    recipients: z.array(z.string()),
    sendTime: z.string(),
    timeZone: z.string(),
    enabled: z.boolean(),
    /** null while the defaults apply (nothing saved yet). */
    version: z.number().int().nullable(),
    /** The date "Send now" uses when none is given. */
    defaultDate: z.iso.date(),
    recent: z.array(recentRow),
  })
  .meta({ id: 'PerformanceSummarySettings' });
const sendNowResponse = z
  .object({
    date: z.iso.date(),
    variant: z.enum(['full', 'incomplete']),
    reason: z.enum(SUMMARY_INCOMPLETE_REASONS).nullable(),
    recipients: z.number().int(),
  })
  .meta({ id: 'PerformanceSummarySent' });

/** The company the settings belong to: the one asked for, or the caller's only company. */
function summaryCompany(requested: string | undefined): string {
  const { companyIds } = currentUnit().context;
  if (requested !== undefined) {
    if (!companyIds.includes(requested)) {
      throw new ValidationError([
        { path: 'companyId', code: 'unknown_company', message: 'No such company' },
      ]);
    }
    return requested;
  }
  const only = companyIds.length === 1 ? companyIds[0] : undefined;
  if (only === undefined) {
    throw new UnprocessableError('company_required', 'Choose the company (companyId).');
  }
  return only;
}

export interface SummaryRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  summary: SummaryService;
}

export function createSummaryRouter(deps: SummaryRouterDeps): Router {
  const { uow, registry, permissions, summary } = deps;
  const router = Router();

  router.get('/performance/summary', async (req, res) => {
    const query = companyQuery.parse(req.query);
    const body = await uow.run(async (db) => {
      await permissions.require(SUMMARY_MANAGE);
      const companyId = summaryCompany(query.companyId);
      const settings = await readSummarySettings(db, companyId);
      return {
        companyId,
        ...settings,
        defaultDate: summary.defaultDate(settings),
        recent: await summary.recent(db, companyId),
      };
    });
    res.json(body);
  });

  router.put('/performance/summary', async (req, res) => {
    const query = companyQuery.parse(req.query);
    const settings = summarySettingsSchema.parse(req.body);
    const body = await uow.run(async (db) => {
      await permissions.require(SUMMARY_MANAGE);
      const companyId = summaryCompany(query.companyId);
      const saved = await writeSummarySettings(db, companyId, settings);
      return {
        companyId,
        ...saved,
        defaultDate: summary.defaultDate(saved),
        recent: await summary.recent(db, companyId),
      };
    });
    res.json(body);
  });

  router.post('/performance/summary/send-now', async (req, res) => {
    const query = companyQuery.parse(req.query);
    const input = summarySendNowSchema.parse(req.body ?? {});
    const result = await uow.run(async (db) => {
      await permissions.require(SUMMARY_MANAGE);
      const companyId = summaryCompany(query.companyId);
      const settings = await readSummarySettings(db, companyId);
      const date = input.date ?? summary.defaultDate(settings);
      return summary.sendFor(companyId, date, 'manual');
    });
    if (result.status === 'already_sent') {
      throw new ConflictError(
        'summary_already_sent',
        `The summary for ${result.date} was already sent. It is sent once per date.`,
      );
    }
    if (result.status === 'no_recipients') {
      throw new UnprocessableError(
        'no_recipients',
        'No recipients are set. Add at least one address first.',
      );
    }
    res.json({
      date: result.date,
      variant: result.variant,
      reason: result.reason,
      recipients: result.recipients,
    });
  });

  const tags = ['Performance summary'];
  const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
  registerRoute(registry, {
    method: 'get',
    path: '/performance/summary',
    tags,
    summary: 'Daily summary email settings and the last sent summaries',
    request: { query: companyQuery },
    responses: { 200: { description: 'The settings', content: json(summaryResponse) } },
  });
  registerRoute(registry, {
    method: 'put',
    path: '/performance/summary',
    tags,
    summary: 'Save the daily summary email settings',
    request: { query: companyQuery, body: { content: json(summarySettingsSchema) } },
    responses: { 200: { description: 'The settings', content: json(summaryResponse) } },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/performance/summary/send-now',
    tags,
    summary: 'Send the summary of a date now (once per date)',
    request: { query: companyQuery, body: { content: json(summarySendNowSchema) } },
    responses: { 200: { description: 'Sent', content: json(sendNowResponse) } },
  });
  return router;
}
