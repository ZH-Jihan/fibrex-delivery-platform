/**
 * Request id and request context middleware.
 *
 * Purpose: the first middleware of every request. It picks the request id (a well-formed
 * incoming X-Request-Id from a proxy is kept, otherwise a new UUID is made), echoes it
 * in the response, and runs the rest of the request inside a fresh RequestContext.
 *
 * Depends on: ./request-context.ts. Used by: src/app.ts.
 */
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { runWithContext, type RequestContext } from '../context/request-context.js';

/** Accept only short, plain ids from outside so they cannot inject into logs. */
const INCOMING_ID = /^[A-Za-z0-9._-]{8,64}$/;

export const REQUEST_ID_HEADER = 'X-Request-Id';

export function requestContextMiddleware(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get(REQUEST_ID_HEADER);
    const requestId =
      incoming !== undefined && INCOMING_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader(REQUEST_ID_HEADER, requestId);
    const ctx: RequestContext = {
      requestId,
      startedAt: Date.now(),
      ip: req.ip,
      principal: undefined,
      companyIds: [],
    };
    runWithContext(ctx, () => {
      next();
    });
  };
}
