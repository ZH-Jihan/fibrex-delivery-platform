/**
 * Google connection API (phase 4 row 4.4; PLAN 5.13). All routes need
 * `performance.google_connection.manage` (admins).
 *
 *   GET  /google-connection             status (never a token)
 *   POST /google-connection/start       one-time state + Google's consent URL
 *   POST /google-connection/callback    { code, state } from the web callback page
 *   POST /google-connection/disconnect  forget the grant and revoke it at Google
 *   POST /google-connection/test        { spreadsheet, tab, authMode }: reads the header row
 *                                       only, signed in as the service account (default) or
 *                                       with the OAuth grant (row 4.4b)
 *
 * Why the callback is a POST from the web app and not Google's redirect landing on the API:
 * the browser holds the access token only in memory, so a plain redirect to the API would
 * arrive unauthenticated. Google redirects to the web page named by
 * GOOGLE_OAUTH_REDIRECT_URI; that page posts the code and state here with the signed-in
 * admin's token, and the state must be the one that same admin was given (see
 * ./google-connection.ts, rule 2).
 *
 * Depends on: express, zod, @fibrex/shared, kernel/db, kernel/http, kernel/permissions,
 * ./google-connection.ts. Used by: ./index.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  GOOGLE_AUTH_MODES,
  sheetHeaderTestSchema,
  SNOONU_DEFAULT_MAPPING,
  spreadsheetIdOf,
} from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { registerRoute } from '../../kernel/http/openapi.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import type { GoogleConnectionService } from './google-connection.js';
import { sourceErrorResponse } from './sync-source-router.js';

export const GOOGLE_MANAGE = 'performance.google_connection.manage';

const callbackBody = z.object({
  code: z.string().min(1).max(2000),
  state: z.string().min(1).max(200),
});
const statusSchema = z
  .object({
    state: z.enum(['not_configured', 'not_connected', 'connected', 'reconnect_needed']),
    configured: z.boolean(),
    redirectUri: z.string().nullable(),
    scope: z.string().nullable(),
    connectedAt: z.string().nullable(),
    connectedBy: z.uuid().nullable(),
    connectedByName: z.string().nullable(),
    problem: z.object({ code: z.string(), message: z.string(), at: z.string() }).nullable(),
    serviceAccount: z.object({
      configured: z.boolean(),
      email: z.string().nullable(),
      problem: z.string().nullable(),
    }),
    defaultAuthMode: z.enum(GOOGLE_AUTH_MODES),
  })
  .meta({ id: 'GoogleConnectionStatus' });
const startSchema = z.object({ authorizationUrl: z.url() }).meta({ id: 'GoogleConsentStart' });
export const headerTestResult = z
  .object({ ok: z.boolean(), headers: z.array(z.string()), message: z.string().nullable() })
  .meta({ id: 'SheetHeaderTest' });

export interface GoogleRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  google: GoogleConnectionService;
}

export function createGoogleRouter(deps: GoogleRouterDeps): Router {
  const { uow, registry, permissions, google } = deps;
  const router = Router();

  router.get('/google-connection', async (_req, res) => {
    res.json(
      await uow.run(async () => {
        await permissions.require(GOOGLE_MANAGE);
        return google.status();
      }),
    );
  });

  router.post('/google-connection/start', async (_req, res) => {
    res.json(
      await uow.run(async () => {
        await permissions.require(GOOGLE_MANAGE);
        return google.start();
      }),
    );
  });

  router.post('/google-connection/callback', async (req, res) => {
    const body = callbackBody.parse(req.body);
    // 1. State check (refused before Google is ever asked).
    const stateHash = await uow.run(async () => {
      await permissions.require(GOOGLE_MANAGE);
      return google.checkState(body.state);
    });
    // 2. Code for refresh token, outside any transaction.
    const grant = await google.exchange(body.code);
    // 3. Save once; revoke the token it replaced after the commit.
    const replaced = await uow.run(async () => {
      await permissions.require(GOOGLE_MANAGE);
      return google.saveGrant(stateHash, grant);
    });
    await google.revoke(replaced);
    res.json(await uow.run(() => google.status()));
  });

  router.post('/google-connection/disconnect', async (_req, res) => {
    const token = await uow.run(async () => {
      await permissions.require(GOOGLE_MANAGE);
      return google.disconnect();
    });
    await google.revoke(token);
    res.json(await uow.run(() => google.status()));
  });

  router.post('/google-connection/test', async (req, res) => {
    const body = sheetHeaderTestSchema.parse(req.body);
    const context = await uow.run(async () => {
      await permissions.require(GOOGLE_MANAGE);
      return currentUnit().context;
    });
    const spreadsheetId = spreadsheetIdOf(body.spreadsheet) ?? '';
    try {
      const headers = await google.readHeaders(
        context,
        spreadsheetId,
        body.tab,
        SNOONU_DEFAULT_MAPPING.headerRow,
        body.authMode,
      );
      res.json({ ok: true, headers, message: null });
    } catch (err) {
      res.json(sourceErrorResponse(err));
    }
  });

  const tags = ['Google connection'];
  const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
  const status = { 200: { description: 'The connection', content: json(statusSchema) } };
  registerRoute(registry, {
    method: 'get',
    path: '/google-connection',
    tags,
    summary: 'Google connection status (never returns a token)',
    responses: status,
  });
  registerRoute(registry, {
    method: 'post',
    path: '/google-connection/start',
    tags,
    summary: 'Start read-only Google consent; returns the URL to send the browser to',
    responses: { 200: { description: 'Consent URL', content: json(startSchema) } },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/google-connection/callback',
    tags,
    summary: 'Finish consent with the code and state Google returned',
    request: { body: { content: json(callbackBody) } },
    responses: status,
  });
  registerRoute(registry, {
    method: 'post',
    path: '/google-connection/disconnect',
    tags,
    summary: 'Forget the Google grant and revoke it',
    responses: status,
  });
  registerRoute(registry, {
    method: 'post',
    path: '/google-connection/test',
    tags,
    summary: 'Read only the header row (row 3) of a tab, to test access',
    request: { body: { content: json(sheetHeaderTestSchema) } },
    responses: { 200: { description: 'Headers or the problem', content: json(headerTestResult) } },
  });
  return router;
}
