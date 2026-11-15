/**
 * `GET /modules`: the registered modules as data (key, label, permission keys, menu
 * entries, settings, reports, event types), so the web shell and the admin screens can
 * be built from the manifests instead of lists kept by hand. Any signed-in user may read
 * it: it reveals the same keys the permission matrix shows, never business data.
 *
 * Depends on: express, zod, kernel/http (OpenAPI, errors), kernel/context, ./registry.ts.
 * Used by: src/main.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { Router } from 'express';
import { z } from 'zod';
import { requireContext } from '../context/request-context.js';
import { UnauthenticatedError } from '../http/errors.js';
import { registerRoute } from '../http/openapi.js';
import type { ModuleRegistry } from './registry.js';

const navEntry = z.object({
  path: z.string(),
  labelKey: z.string(),
  groupKey: z.string(),
  permission: z.string(),
});
const setting = z.object({
  key: z.string(),
  label: z.string(),
  path: z.string(),
  permission: z.string(),
});
const report = z.object({ key: z.string(), label: z.string(), permission: z.string() });
export const moduleSummary = z
  .object({
    key: z.string(),
    label: z.string(),
    permissions: z.array(z.string()),
    nav: z.array(navEntry),
    settings: z.array(setting),
    reports: z.array(report),
    eventTypes: z.array(z.string()),
  })
  .meta({ id: 'ModuleSummary' });

export function createModuleRouter(deps: {
  registry: OpenAPIRegistry;
  modules: ModuleRegistry;
}): Router {
  const router = Router();
  router.get('/modules', (_req, res) => {
    if (requireContext().principal === undefined) throw new UnauthenticatedError();
    res.json({ items: deps.modules.summaries() });
  });
  registerRoute(deps.registry, {
    method: 'get',
    path: '/modules',
    tags: ['System'],
    summary: 'Registered modules and what each contributes (menu, settings, reports)',
    responses: {
      200: {
        description: 'One entry per module, in registration order',
        content: { 'application/json': { schema: z.object({ items: z.array(moduleSummary) }) } },
      },
    },
  });
  return router;
}
