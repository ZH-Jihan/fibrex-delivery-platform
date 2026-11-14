/**
 * Express application factory.
 *
 * Purpose: assembles the shared HTTP layers that every module gets for free, in a fixed
 * order. Modules never add their own copies of these layers, so none can skip them
 * (CLAUDE.md: shared layers a module cannot skip).
 *
 * Order and why:
 *   1. request context + X-Request-Id   everything after can log and trace by request
 *   2. access log (pino-http)           one line per request, health probes excluded
 *   3. security headers (Helmet), CORS  before any route can answer
 *   4. /health, /ready                  no rate limit, no body parsing (probes)
 *   5. /api/v1:
 *      a. rate limit                    cheapest rejection first
 *      b. JSON body parser (size limit)
 *      c. authentication                (commit 7) must run before idempotency so a 401 is
 *                                       never cached as the answer to a key
 *      d. idempotency keys              needs the parsed body for the fingerprint
 *      e. module routes
 *      f. /api/v1/openapi.json
 *   6. /api/docs                        Swagger UI over the generated document
 *   7. 404 handler, error handler       every failure becomes a problem document
 *
 * Depends on: express, pino-http, swagger-ui-express, kernel/*. Used by: src/main.ts and
 * the HTTP integration tests.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import express, { Router, type Express, type RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import type { Env } from './kernel/config/env.js';
import { currentContext } from './kernel/context/request-context.js';
import { errorHandler, notFoundHandler } from './kernel/http/error-handler.js';
import { healthRouter, registerHealthDocs, type ReadinessCheck } from './kernel/http/health.js';
import { idempotencyMiddleware } from './kernel/http/idempotency.js';
import { buildOpenApiDocument, createOpenApiRegistry } from './kernel/http/openapi.js';
import { RateLimiter, rateLimitMiddleware } from './kernel/http/rate-limit.js';
import { requestContextMiddleware } from './kernel/http/request-context-middleware.js';
import { corsPolicy, securityHeaders } from './kernel/http/security.js';
import type { Logger } from './kernel/observability/logger.js';

export const API_PREFIX = '/api/v1';
export const API_VERSION = '1.0.0';

/**
 * Paths under /api/v1 that do not require an Idempotency-Key. They are safe to repeat,
 * and their answers carry access tokens, which must not be kept for replay.
 */
const IDEMPOTENCY_EXEMPT_PREFIXES = ['/auth/', '/me/switch-company'];

export interface AppDeps {
  env: Env;
  logger: Logger;
  redis: Redis;
  readinessChecks: readonly ReadinessCheck[];
  /**
   * Fills the request context from the caller's credentials (kernel/auth/authenticate.ts).
   * Optional only so kernel tests can run the HTTP layers without a database.
   */
  authenticate?: RequestHandler;
  /** Lets modules (and tests) mount routes on /api/v1 and document them. */
  mountApi?: (api: Router, registry: OpenAPIRegistry) => void;
}

export function createApp(deps: AppDeps): Express {
  const { env, logger, redis } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.set('query parser', 'simple');

  const registry = createOpenApiRegistry();
  registerHealthDocs(registry);

  // 1-3
  app.use(requestContextMiddleware());
  app.use(
    pinoHttp({
      logger,
      genReqId: () => currentContext()?.requestId ?? 'unknown',
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' },
      customLogLevel: (_req, res, err) =>
        err !== undefined || res.statusCode >= 500
          ? 'error'
          : res.statusCode >= 400
            ? 'warn'
            : 'info',
      serializers: {
        req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(securityHeaders());
  app.use(corsPolicy(env.CORS_ORIGINS));

  // 4
  app.use(healthRouter(deps.readinessChecks, logger));

  // 5
  const api = Router();
  const limiter = new RateLimiter({
    redis,
    keyPrefix: 'rl:api',
    windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,
    limitFor: (caller) =>
      caller.startsWith('ip:') ? env.RATE_LIMIT_ANONYMOUS : env.RATE_LIMIT_AUTHENTICATED,
  });
  api.use(rateLimitMiddleware(limiter, logger));
  api.use(express.json({ limit: env.BODY_LIMIT, strict: true }));
  if (deps.authenticate !== undefined) api.use(deps.authenticate);
  api.use(
    idempotencyMiddleware({
      redis,
      logger,
      ttlSeconds: env.IDEMPOTENCY_TTL_SECONDS,
      lockSeconds: env.IDEMPOTENCY_LOCK_SECONDS,
      exempt: (req) => IDEMPOTENCY_EXEMPT_PREFIXES.some((p) => req.path.startsWith(p)),
    }),
  );
  deps.mountApi?.(api, registry);

  // The document is built on first request, after every module has registered its routes.
  let document: ReturnType<typeof buildOpenApiDocument> | undefined;
  const getDocument = () =>
    (document ??= buildOpenApiDocument(registry, { version: API_VERSION, serverUrl: API_PREFIX }));
  api.get('/openapi.json', (_req, res) => {
    res.json(getDocument());
  });
  app.use(API_PREFIX, api);

  // 6
  app.use(
    '/api/docs',
    swaggerUi.serve,
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      swaggerUi.setup(getDocument())(req, res, next);
    },
  );

  // 7
  app.use(notFoundHandler());
  app.use(errorHandler(logger));
  return app;
}
