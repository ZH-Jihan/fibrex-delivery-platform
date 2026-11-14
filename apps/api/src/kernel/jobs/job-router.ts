/**
 * Job monitor endpoint (PLAN 5.2): `GET /jobs` shows how many jobs each background queue
 * has waiting, running, delayed, failed and completed, so an administrator can see a
 * stuck queue without Redis access.
 *
 * Needs the permission `system.job.read`. Read-only: nothing here starts or removes jobs.
 *
 * Depends on: express, zod, kernel/http (OpenAPI), bullmq types. Used by: src/main.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import type { Queue } from 'bullmq';
import { Router } from 'express';
import { z } from 'zod';
import { registerRoute } from '../http/openapi.js';
import { permission } from '../permissions/catalogue.js';
import type { Authorize } from '../http/crud-router.js';

export const JOB_PERMISSIONS = [
  permission('system', 'system.job', 'read', 'View background job queues'),
];

const queueStatus = z
  .object({
    name: z.string(),
    counts: z.record(z.string(), z.number().int()),
  })
  .meta({ id: 'QueueStatus' });

export function createJobRouter(deps: {
  registry: OpenAPIRegistry;
  authorize: Authorize;
  queues: () => readonly (Queue | undefined)[];
}): Router {
  const router = Router();
  router.get('/jobs', async (_req, res) => {
    await deps.authorize('system.job.read');
    const rows = [];
    for (const queue of deps.queues()) {
      if (queue === undefined) continue;
      rows.push({
        name: queue.name,
        counts: await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
      });
    }
    res.json({ items: rows });
  });
  registerRoute(deps.registry, {
    method: 'get',
    path: '/jobs',
    tags: ['System'],
    summary: 'Background job queues and their counts',
    responses: {
      200: {
        description: 'One entry per queue',
        content: { 'application/json': { schema: z.object({ items: z.array(queueStatus) }) } },
      },
    },
  });
  return router;
}
