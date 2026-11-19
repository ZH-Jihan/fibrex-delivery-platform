/**
 * Expiry API (phase 3 row 3.4; PLAN 5.12 endpoints `expiring` and `expiry-calendar`).
 *
 *   GET /documents/expiring?withinDays=&ownerType=   current documents expiring within N days
 *                                                    (default 30), expired ones included
 *   GET /documents/expiry-calendar?month=YYYY-MM     documents expiring in a month, by day
 *   GET /documents/expiry-settings?companyId=        the company's email list and windows
 *   PUT /documents/expiry-settings?companyId=        save them (admin; audited by trigger)
 *
 * The lists show what the app shows for expired documents (owner answer 2026-11-19: expired
 * documents are in-app only). Each item carries its days left and a freshly derived status,
 * so the screens (row 3.5) colour it the same way as the daily job does.
 *
 * Mounted before the documents CRUD router so `/documents/expiring` is not read as an id.
 *
 * Depends on: express, zod, @fibrex/shared (settings schema, owner types), kernel/db,
 * kernel/http, ./expiry-service.ts. Used by: ./index.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { DOCUMENT_OWNER_TYPES, DOCUMENT_STATUSES, expirySettingsSchema } from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { UnprocessableError, ValidationError } from '../../kernel/http/errors.js';
import { registerRoute } from '../../kernel/http/openapi.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import { readExpirySettings, writeExpirySettings, type ExpiryService } from './expiry-service.js';

const expiryItem = z
  .object({
    documentId: z.uuid(),
    companyId: z.uuid(),
    ownerType: z.enum(DOCUMENT_OWNER_TYPES),
    ownerId: z.uuid(),
    ownerName: z.string(),
    employeeCode: z.string().nullable(),
    documentTypeId: z.uuid().nullable(),
    documentName: z.string(),
    expiryDate: z.iso.date(),
    daysLeft: z.number().int(),
    status: z.enum(DOCUMENT_STATUSES),
  })
  .meta({ id: 'ExpiringDocument' });
const expiringQuery = z.object({
  withinDays: z.coerce.number().int().min(0).max(365).default(30),
  ownerType: z.enum(DOCUMENT_OWNER_TYPES).optional(),
});
const expiringResponse = z
  .object({ today: z.iso.date(), withinDays: z.number().int(), items: z.array(expiryItem) })
  .meta({ id: 'ExpiringDocuments' });
const calendarQuery = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM')
    .optional(),
});
const calendarResponse = z
  .object({
    month: z.string(),
    days: z.array(z.object({ date: z.iso.date(), items: z.array(expiryItem) })),
  })
  .meta({ id: 'ExpiryCalendar' });
const companyQuery = z.object({ companyId: z.uuid().optional() });
const settingsResponse = z
  .object({
    companyId: z.uuid(),
    emails: z.array(z.string()),
    windows: z.array(z.number().int()),
    /** null while the defaults apply (nothing saved yet). */
    version: z.number().int().nullable(),
  })
  .meta({ id: 'ExpirySettings' });

/** The company the settings belong to: the one asked for, or the caller's only company. */
function settingsCompany(requested: string | undefined): string {
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

/** Last day of a "YYYY-MM" month as "YYYY-MM-DD". */
function monthEnd(month: string): string {
  const [year, mon] = month.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, mon ?? 1, 0)).toISOString().slice(0, 10);
}

export interface ExpiryRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  expiry: ExpiryService;
}

export function createExpiryRouter(deps: ExpiryRouterDeps): Router {
  const { uow, registry, permissions, expiry } = deps;
  const router = Router();

  router.get('/documents/expiring', async (req, res) => {
    const query = expiringQuery.parse(req.query);
    const today = expiry.today();
    const to = new Date(Date.parse(`${today}T00:00:00Z`) + query.withinDays * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const items = await uow.run(async () => {
      await permissions.require('people.document.read');
      return expiry.list({
        from: null,
        to,
        today,
        ...(query.ownerType === undefined ? {} : { ownerType: query.ownerType }),
      });
    });
    res.json({ today, withinDays: query.withinDays, items });
  });

  router.get('/documents/expiry-calendar', async (req, res) => {
    const query = calendarQuery.parse(req.query);
    const month = query.month ?? expiry.today().slice(0, 7);
    const items = await uow.run(async () => {
      await permissions.require('people.document.read');
      return expiry.list({ from: `${month}-01`, to: monthEnd(month) });
    });
    const days = new Map<string, typeof items>();
    for (const item of items) {
      days.set(item.expiryDate, [...(days.get(item.expiryDate) ?? []), item]);
    }
    res.json({ month, days: [...days].map(([date, list]) => ({ date, items: list })) });
  });

  router.get('/documents/expiry-settings', async (req, res) => {
    const query = companyQuery.parse(req.query);
    const body = await uow.run(async (db) => {
      await permissions.require('people.expiry_settings.read');
      const companyId = settingsCompany(query.companyId);
      return { companyId, ...(await readExpirySettings(db, companyId)) };
    });
    res.json(body);
  });

  router.put('/documents/expiry-settings', async (req, res) => {
    const query = companyQuery.parse(req.query);
    const settings = expirySettingsSchema.parse(req.body);
    const body = await uow.run(async (db) => {
      await permissions.require('people.expiry_settings.update');
      const companyId = settingsCompany(query.companyId);
      return { companyId, ...(await writeExpirySettings(db, companyId, settings)) };
    });
    res.json(body);
  });

  const tags = ['Documents'];
  const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
  registerRoute(registry, {
    method: 'get',
    path: '/documents/expiring',
    tags,
    summary: 'Documents expiring within N days (expired ones included)',
    request: { query: expiringQuery },
    responses: { 200: { description: 'The documents', content: json(expiringResponse) } },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/documents/expiry-calendar',
    tags,
    summary: 'Documents expiring in a month, grouped by day',
    request: { query: calendarQuery },
    responses: { 200: { description: 'The calendar', content: json(calendarResponse) } },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/documents/expiry-settings',
    tags,
    summary: 'Expiry alert settings of a company (email list, windows)',
    request: { query: companyQuery },
    responses: { 200: { description: 'The settings', content: json(settingsResponse) } },
  });
  registerRoute(registry, {
    method: 'put',
    path: '/documents/expiry-settings',
    tags,
    summary: 'Save the expiry alert settings of a company',
    request: { query: companyQuery, body: { content: json(expirySettingsSchema) } },
    responses: { 200: { description: 'The settings', content: json(settingsResponse) } },
  });
  return router;
}
