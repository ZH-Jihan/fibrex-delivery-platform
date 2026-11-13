/**
 * Health and readiness endpoints (SPEC 6.3 "health-check endpoint").
 *
 *   GET /health  liveness: the process is up and serving HTTP. Never touches dependencies,
 *                so a database outage does not make the orchestrator restart healthy pods.
 *   GET /ready   readiness: every dependency check passes within its timeout. Returns 503
 *                with the failing checks named, so a load balancer stops sending traffic.
 *
 * Responses never include error messages from dependencies (they can contain hostnames
 * or credentials); details go to the log.
 *
 * Depends on: express, zod, ./openapi.ts. Used by: src/app.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { Router } from 'express';
import { z } from 'zod';
import type { Logger } from '../observability/logger.js';

export interface ReadinessCheck {
  name: string;
  check: () => Promise<void>;
}

const CHECK_TIMEOUT_MS = 2000;

const healthSchema = z.object({ status: z.literal('ok') }).meta({ id: 'Health' });
const readinessSchema = z
  .object({
    status: z.enum(['ready', 'not_ready']),
    checks: z.record(z.string(), z.enum(['ok', 'failed'])),
  })
  .meta({ id: 'Readiness' });

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(ms)} ms`));
    }, ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export function healthRouter(checks: readonly ReadinessCheck[], logger: Logger): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/ready', async (_req, res) => {
    const results = await Promise.all(
      checks.map(async ({ name, check }) => {
        try {
          await withTimeout(check(), CHECK_TIMEOUT_MS);
          return [name, 'ok'] as const;
        } catch (err) {
          logger.warn({ err, check: name }, 'readiness check failed');
          return [name, 'failed'] as const;
        }
      }),
    );
    const ready = results.every(([, r]) => r === 'ok');
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      checks: Object.fromEntries(results),
    });
  });

  return router;
}

export function registerHealthDocs(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/health',
    tags: ['System'],
    summary: 'Liveness probe',
    responses: {
      200: {
        description: 'Process is up',
        content: { 'application/json': { schema: healthSchema } },
      },
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/ready',
    tags: ['System'],
    summary: 'Readiness probe (database, Redis)',
    responses: {
      200: {
        description: 'All dependencies reachable',
        content: { 'application/json': { schema: readinessSchema } },
      },
      503: {
        description: 'A dependency is unreachable',
        content: { 'application/json': { schema: readinessSchema } },
      },
    },
  });
}
