/**
 * Sync source API (phase 4 row 4.4; PLAN 5.13).
 *
 *   GET  /client-platforms                platforms to choose from (read only; edited in 4.5)
 *   GET  /sync-sources                    the company's sources
 *   GET  /sync-sources/{id}               one source
 *   POST /sync-sources                    create (platform, name, kind, spreadsheet, tab, schedule)
 *   PUT  /sync-sources/{id}               change (body + `version`; 409 on a stale version)
 *   POST /sync-sources/{id}/test-headers  read only the header row of the source's tab
 *
 * Where each value is kept:
 *   - The spreadsheet id and the sign-in mode are sealed in `config_encrypted`
 *     (`{ spreadsheetId, authMode }`; row 4.4b added `authMode`), where the
 *     reader expects it (./google-connection.ts). A pasted URL is reduced to the id first.
 *   - The tab belongs to the column mapping (`column_mapping.mapping.tab`), which the sync
 *     engine reads it from. Changing the tab writes a new mapping version that copies the
 *     current mapping with the new tab, so nothing else of the mapping changes. The mapping
 *     editor itself arrives with row 4.5.
 *   - Schedule and time zone are columns; the queue's per-source schedules are rewritten
 *     right after a save (and every 10 minutes anyway).
 *
 * Depends on: express, zod, @fibrex/shared, kernel/crypto, kernel/db, kernel/http,
 * kernel/permissions, ./google-connection.ts, ./sync-service.ts, ./sync-queue.ts.
 * Used by: ./index.ts, ./google-router.ts (error shape of a header test).
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  GOOGLE_AUTH_MODES,
  sheetColumnMappingSchema,
  spreadsheetIdOf,
  syncSourceFormSchema,
  type SheetColumnMapping,
  type SyncSourceForm,
} from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { SecretBox } from '../../kernel/crypto/secret-box.js';
import type { Db } from '../../kernel/db/prisma.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { ConflictError, NotFoundError, ValidationError } from '../../kernel/http/errors.js';
import { registerRoute } from '../../kernel/http/openapi.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import { authModeOf, type GoogleConnectionService } from './google-connection.js';
import { ReportSourceError } from './report-adapter.js';
import type { SyncQueue } from './sync-queue.js';
import { defaultMappingFor, SYNC_SOURCE_SECRET_CONTEXT } from './sync-service.js';

const idParams = z.object({ id: z.uuid() });
const updateBody = z.intersection(
  syncSourceFormSchema,
  z.object({ version: z.number().int().min(1) }),
);

const sourceItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    clientPlatformId: z.uuid(),
    platformName: z.string(),
    name: z.string(),
    adapterKind: z.string(),
    spreadsheetId: z.string().nullable(),
    /** How a sheet source signs in to Google (row 4.4b); null for excel. */
    authMode: z.enum(GOOGLE_AUTH_MODES).nullable(),
    tab: z.string(),
    scheduleCron: z.string(),
    timeZone: z.string(),
    active: z.boolean(),
    version: z.number().int(),
    updatedAt: z.string(),
  })
  .meta({ id: 'SyncSource' });
const headerTest = z
  .object({ ok: z.boolean(), headers: z.array(z.string()), message: z.string().nullable() })
  .meta({ id: 'SyncSourceHeaderTest' });

/** A failed header read as the answer the screens show (never a stack or a token). */
export function sourceErrorResponse(err: unknown): {
  ok: false;
  headers: string[];
  message: string;
  code: string;
} {
  if (err instanceof ReportSourceError) {
    return { ok: false, headers: [], message: err.message, code: err.code };
  }
  throw err;
}

export interface SyncSourceRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  box: SecretBox;
  google: GoogleConnectionService;
  queue: SyncQueue;
}

interface SourceRow {
  id: string;
  companyId: string;
  clientPlatformId: string;
  name: string;
  adapterKind: string;
  configEncrypted: Uint8Array | null;
  scheduleCron: string;
  timeZone: string;
  active: boolean;
  version: number;
  updatedAt: Date;
  clientPlatform: { code: string; name: string };
}

export function createSyncSourceRouter(deps: SyncSourceRouterDeps): Router {
  const { uow, registry, permissions, box, google, queue } = deps;
  const router = Router();
  const include = { clientPlatform: { select: { code: true, name: true } } } as const;

  const openConfig = (row: SourceRow): Record<string, unknown> | null =>
    row.configEncrypted === null
      ? null
      : (JSON.parse(
          box.open(row.configEncrypted, SYNC_SOURCE_SECRET_CONTEXT).toString('utf8'),
        ) as Record<string, unknown>);
  const sealConfig = (form: SyncSourceForm): Uint8Array<ArrayBuffer> | null => {
    if (form.adapterKind !== 'sheet') return null;
    const spreadsheetId = spreadsheetIdOf(form.spreadsheet ?? '');
    return box.seal(
      Buffer.from(JSON.stringify({ spreadsheetId, authMode: form.authMode }), 'utf8'),
      SYNC_SOURCE_SECRET_CONTEXT,
    );
  };

  /** The mapping the engine would use now: the newest saved one, else the platform's. */
  async function effectiveMapping(
    db: Db,
    row: { id: string; clientPlatform: { code: string } },
  ): Promise<{ mapping: SheetColumnMapping; latestVersion: number }> {
    const saved = await db.columnMapping.findFirst({
      where: { syncSourceId: row.id, deletedAt: null },
      orderBy: { mappingVersion: 'desc' },
    });
    const parsed = saved === null ? null : sheetColumnMappingSchema.safeParse(saved.mapping);
    return {
      mapping: parsed?.success === true ? parsed.data : defaultMappingFor(row.clientPlatform.code),
      latestVersion: saved?.mappingVersion ?? 0,
    };
  }

  async function toItem(db: Db, row: SourceRow) {
    const config = openConfig(row);
    const { mapping } = await effectiveMapping(db, row);
    const spreadsheetId = config?.spreadsheetId;
    return {
      id: row.id,
      companyId: row.companyId,
      clientPlatformId: row.clientPlatformId,
      platformName: row.clientPlatform.name,
      name: row.name,
      adapterKind: row.adapterKind,
      spreadsheetId: typeof spreadsheetId === 'string' ? spreadsheetId : null,
      authMode: row.adapterKind === 'sheet' ? authModeOf(config) : null,
      tab: mapping.tab,
      scheduleCron: row.scheduleCron,
      timeZone: row.timeZone,
      active: row.active,
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Writes a new mapping version when the tab changed (see the header). */
  async function keepTab(db: Db, row: SourceRow, tab: string): Promise<void> {
    const { mapping, latestVersion } = await effectiveMapping(db, row);
    if (mapping.tab === tab) return;
    const { context } = currentUnit();
    await db.columnMapping.create({
      data: {
        tenantId: context.tenantId,
        companyId: row.companyId,
        syncSourceId: row.id,
        mappingVersion: latestVersion + 1,
        mapping: { ...mapping, tab },
      },
    });
  }

  async function platformOf(db: Db, clientPlatformId: string) {
    const platform = await db.clientPlatform.findFirst({
      where: { id: clientPlatformId, deletedAt: null },
      select: { id: true, companyId: true },
    });
    if (platform === null) {
      throw new ValidationError([
        { path: 'clientPlatformId', code: 'not_found', message: 'No such platform.' },
      ]);
    }
    return platform;
  }

  router.get('/client-platforms', async (_req, res) => {
    const items = await uow.run(async (db) => {
      await permissions.require('performance.client_platform.read');
      return db.clientPlatform.findMany({
        where: { deletedAt: null },
        select: { id: true, companyId: true, code: true, name: true },
        orderBy: { name: 'asc' },
      });
    });
    res.json({ items });
  });

  router.get('/sync-sources', async (_req, res) => {
    const items = await uow.run(async (db) => {
      await permissions.require('performance.sync_source.read');
      const rows = await db.syncSource.findMany({
        where: { deletedAt: null },
        include,
        orderBy: { name: 'asc' },
      });
      return Promise.all(rows.map((r) => toItem(db, r)));
    });
    res.json({ items });
  });

  router.get('/sync-sources/:id', async (req, res) => {
    const { id } = idParams.parse(req.params);
    res.json(
      await uow.run(async (db) => {
        await permissions.require('performance.sync_source.read');
        const row = await db.syncSource.findFirst({ where: { id, deletedAt: null }, include });
        if (row === null) throw new NotFoundError();
        return toItem(db, row);
      }),
    );
  });

  router.post('/sync-sources', async (req, res) => {
    const form = syncSourceFormSchema.parse(req.body);
    const item = await uow.run(async (db) => {
      await permissions.require('performance.sync_source.create');
      const platform = await platformOf(db, form.clientPlatformId);
      const { context } = currentUnit();
      const created = await db.syncSource.create({
        data: {
          tenantId: context.tenantId,
          companyId: platform.companyId,
          clientPlatformId: platform.id,
          name: form.name,
          adapterKind: form.adapterKind,
          configEncrypted: sealConfig(form),
          scheduleCron: form.scheduleCron,
          timeZone: form.timeZone,
          active: form.active,
        },
        include,
      });
      await keepTab(db, created, form.tab);
      return toItem(db, created);
    });
    await queue.syncSchedules();
    res.status(201).json(item);
  });

  router.put('/sync-sources/:id', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const body = updateBody.parse(req.body);
    const item = await uow.run(async (db) => {
      await permissions.require('performance.sync_source.update');
      const row = await db.syncSource.findFirst({ where: { id, deletedAt: null }, include });
      if (row === null) throw new NotFoundError();
      if (row.version !== body.version) {
        throw new ConflictError('stale_version', 'Someone else changed this source; reload it.', {
          currentVersion: row.version,
        });
      }
      const platform = await platformOf(db, body.clientPlatformId);
      if (platform.companyId !== row.companyId) {
        throw new ValidationError([
          {
            path: 'clientPlatformId',
            code: 'other_company',
            message: 'The platform belongs to another company.',
          },
        ]);
      }
      const updated = await db.syncSource.update({
        where: { id },
        data: {
          clientPlatformId: platform.id,
          name: body.name,
          adapterKind: body.adapterKind,
          configEncrypted: sealConfig(body),
          scheduleCron: body.scheduleCron,
          timeZone: body.timeZone,
          active: body.active,
        },
        include,
      });
      await keepTab(db, updated, body.tab);
      return toItem(db, updated);
    });
    await queue.syncSchedules();
    res.json(item);
  });

  router.post('/sync-sources/:id/test-headers', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const checked = await uow.run(async (db) => {
      await permissions.require('performance.sync_source.update');
      const row = await db.syncSource.findFirst({ where: { id, deletedAt: null }, include });
      if (row === null) throw new NotFoundError();
      const config = openConfig(row);
      const { mapping } = await effectiveMapping(db, row);
      return { context: currentUnit().context, config, mapping, kind: row.adapterKind };
    });
    const spreadsheetId = checked.config?.spreadsheetId;
    if (checked.kind !== 'sheet' || typeof spreadsheetId !== 'string') {
      res.json({ ok: false, headers: [], message: 'This source does not read a Google Sheet.' });
      return;
    }
    try {
      const headers = await google.readHeaders(
        checked.context,
        spreadsheetId,
        checked.mapping.tab,
        checked.mapping.headerRow,
        authModeOf(checked.config),
      );
      res.json({ ok: true, headers, message: null });
    } catch (err) {
      res.json(sourceErrorResponse(err));
    }
  });

  const tags = ['Performance sync'];
  const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
  registerRoute(registry, {
    method: 'get',
    path: '/client-platforms',
    tags,
    summary: 'Client platforms of the company (id, code, name)',
    responses: {
      200: {
        description: 'The platforms',
        content: json(
          z.object({
            items: z.array(
              z.object({ id: z.uuid(), companyId: z.uuid(), code: z.string(), name: z.string() }),
            ),
          }),
        ),
      },
    },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/sync-sources',
    tags,
    summary: 'Sync sources of the company',
    responses: {
      200: { description: 'The sources', content: json(z.object({ items: z.array(sourceItem) })) },
    },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/sync-sources/{id}',
    tags,
    summary: 'One sync source',
    request: { params: idParams },
    responses: { 200: { description: 'The source', content: json(sourceItem) } },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/sync-sources',
    tags,
    summary: 'Create a sync source (spreadsheet id or URL, tab, schedule)',
    request: { body: { content: json(syncSourceFormSchema) } },
    responses: { 201: { description: 'Created', content: json(sourceItem) } },
  });
  registerRoute(registry, {
    method: 'put',
    path: '/sync-sources/{id}',
    tags,
    summary: 'Change a sync source (send the version you read)',
    request: { params: idParams, body: { content: json(updateBody) } },
    responses: { 200: { description: 'Changed', content: json(sourceItem) } },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/sync-sources/{id}/test-headers',
    tags,
    summary: "Read only the header row of the source's tab (test access)",
    request: { params: idParams },
    responses: { 200: { description: 'Headers or the problem', content: json(headerTest) } },
  });
  return router;
}
