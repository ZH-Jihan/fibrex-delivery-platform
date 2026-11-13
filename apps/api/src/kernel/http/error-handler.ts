/**
 * Central error handling.
 *
 * Purpose: the last middleware of the app. Every error, from any module, leaves the API as
 * an RFC 9457 problem document (application/problem+json) with a stable `code` and the
 * request id. Internal details (stack traces, SQL, library messages) are logged but never
 * sent to the client (SPEC 6.3).
 *
 * Mapping:
 *   AppError              -> its own status and code
 *   ZodError              -> 400 validation_failed with one entry per invalid field
 *   malformed JSON body   -> 400 malformed_json
 *   body too large        -> 413 payload_too_large
 *   anything else         -> 500 internal_error (logged at error level with the stack)
 *
 * Depends on: ./errors.ts, ../context/request-context.ts, zod, a pino logger.
 * Used by: src/app.ts.
 */
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { currentContext } from '../context/request-context.js';
import type { Logger } from '../observability/logger.js';
import { AppError, ValidationError, toProblem, type FieldIssue } from './errors.js';

/** Errors thrown by express.json() carry a `type` and `status`. */
interface BodyParserError {
  type: string;
  status: number;
}

function isBodyParserError(err: unknown): err is BodyParserError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    typeof err.type === 'string' &&
    'status' in err &&
    typeof err.status === 'number'
  );
}

export function zodToIssues(err: ZodError): FieldIssue[] {
  return err.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

/** Converts anything thrown into an AppError (unknown errors become 500). */
export function normaliseError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) return new ValidationError(zodToIssues(err));
  if (isBodyParserError(err)) {
    if (err.type === 'entity.parse.failed') {
      return new AppError(
        400,
        'malformed_json',
        'Bad request',
        'The request body is not valid JSON',
      );
    }
    if (err.type === 'entity.too.large') {
      return new AppError(
        413,
        'payload_too_large',
        'Payload too large',
        'The request body is too large',
      );
    }
    if (err.status >= 400 && err.status < 500) {
      return new AppError(
        err.status,
        'bad_request',
        'Bad request',
        'The request body could not be read',
      );
    }
  }
  return new AppError(
    500,
    'internal_error',
    'Internal server error',
    'Something went wrong. Please try again; if it keeps failing, contact support with the request id.',
  );
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, _req, res, next) => {
    if (res.headersSent) {
      // Too late to send a problem document; let Express close the connection.
      next(err);
      return;
    }
    const appErr = normaliseError(err);
    if (appErr.status >= 500) {
      logger.error({ err }, 'request failed');
    } else {
      logger.info({ code: appErr.code, status: appErr.status }, 'request rejected');
    }
    for (const [name, value] of Object.entries(appErr.headers)) res.setHeader(name, value);
    res
      .status(appErr.status)
      .type('application/problem+json')
      .send(JSON.stringify(toProblem(appErr, currentContext()?.requestId)));
  };
}

/** 404 for any route no module claimed. */
export function notFoundHandler(): RequestHandler {
  return (req, _res, next) => {
    next(
      new AppError(404, 'route_not_found', 'Not found', `No route for ${req.method} ${req.path}`),
    );
  };
}
