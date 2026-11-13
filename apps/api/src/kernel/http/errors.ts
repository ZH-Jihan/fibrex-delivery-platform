/**
 * Application errors and the error response format.
 *
 * Purpose: services throw these typed errors; the shared error handler turns them into
 * RFC 9457 "problem details" JSON, so every endpoint fails in the same shape. The `code`
 * is a stable machine-readable string that the web app translates (i18n), and the
 * `requestId` lets support find the matching log lines.
 *
 * Depends on: nothing. Used by: kernel/http/*, every module's service and controller.
 */

export interface FieldIssue {
  /** Dotted path to the field, for example "lines.2.amount". */
  path: string;
  message: string;
  code: string;
}

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  requestId?: string;
  errors?: FieldIssue[];
  [extra: string]: unknown;
}

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  /** Extra JSON members added to the problem body (for example the current record on 409). */
  readonly extras: Record<string, unknown>;
  /** Extra response headers (for example Retry-After). */
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    code: string,
    title: string,
    detail?: string,
    extras: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) {
    super(detail ?? title);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.title = title;
    this.extras = extras;
    this.headers = headers;
  }

  get detail(): string | undefined {
    return this.message === this.title ? undefined : this.message;
  }
}

export class ValidationError extends AppError {
  readonly issues: FieldIssue[];

  constructor(issues: FieldIssue[], detail = 'The request contains invalid fields') {
    super(400, 'validation_failed', 'Validation failed', detail);
    this.issues = issues;
  }
}

export class BadRequestError extends AppError {
  constructor(code: string, detail: string) {
    super(400, code, 'Bad request', detail);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(detail = 'Authentication is required') {
    super(401, 'unauthenticated', 'Unauthenticated', detail);
  }
}

export class ForbiddenError extends AppError {
  constructor(detail = 'You do not have permission to do this') {
    super(403, 'forbidden', 'Forbidden', detail);
  }
}

export class NotFoundError extends AppError {
  constructor(detail = 'The requested resource does not exist') {
    super(404, 'not_found', 'Not found', detail);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, detail: string, extras: Record<string, unknown> = {}) {
    super(409, code, 'Conflict', detail, extras);
  }
}

export class UnprocessableError extends AppError {
  constructor(code: string, detail: string) {
    super(422, code, 'Unprocessable request', detail);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(retryAfterSeconds: number) {
    super(
      429,
      'rate_limited',
      'Too many requests',
      `Too many requests. Try again in ${String(retryAfterSeconds)} seconds.`,
      {},
      { 'Retry-After': String(retryAfterSeconds) },
    );
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(code: string, detail: string) {
    super(503, code, 'Service unavailable', detail);
  }
}

/** Builds the JSON body for an AppError. */
export function toProblem(err: AppError, requestId: string | undefined): ProblemBody {
  const body: ProblemBody = {
    ...err.extras,
    type: `urn:fibrex:problem:${err.code}`,
    title: err.title,
    status: err.status,
    code: err.code,
  };
  if (err.detail !== undefined) body.detail = err.detail;
  if (requestId !== undefined) body.requestId = requestId;
  if (err instanceof ValidationError) body.errors = err.issues;
  return body;
}
