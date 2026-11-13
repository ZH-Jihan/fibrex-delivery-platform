/**
 * HTTP security headers and CORS (SPEC 6.3: Helmet, strict CORS).
 *
 * CORS: only the exact origins in CORS_ORIGINS may call the API from a browser, with
 * credentials (the refresh-token cookie arrives in commit 7). Requests without an Origin
 * header (server-to-server integrations, curl) are not affected by CORS at all; they are
 * protected by authentication. A disallowed origin gets no CORS headers, so the browser
 * blocks the response.
 *
 * Helmet: default secure headers. The Content-Security-Policy allows only same-origin
 * scripts; the API serves no HTML except the Swagger UI page, whose assets are same-origin.
 *
 * Depends on: helmet, cors. Used by: src/app.ts.
 */
import cors from 'cors';
import type { RequestHandler } from 'express';
import helmet from 'helmet';
import { IDEMPOTENCY_HEADER, REPLAYED_HEADER } from './idempotency.js';
import { REQUEST_ID_HEADER } from './request-context-middleware.js';

export function securityHeaders(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
  });
}

export function corsPolicy(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return cors({
    origin: (origin, callback) => {
      callback(null, origin !== undefined && allowed.has(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'If-Match',
      IDEMPOTENCY_HEADER,
      REQUEST_ID_HEADER,
      'X-Company-Id',
      'X-CSRF-Token',
    ],
    exposedHeaders: [
      REQUEST_ID_HEADER,
      REPLAYED_HEADER,
      'ETag',
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
      'Retry-After',
    ],
    maxAge: 600,
  });
}
