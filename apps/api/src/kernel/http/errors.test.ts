import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { normaliseError } from './error-handler.js';
import {
  AppError,
  ConflictError,
  TooManyRequestsError,
  ValidationError,
  toProblem,
} from './errors.js';

describe('toProblem', () => {
  it('builds an RFC 9457 body with a stable code and the request id', () => {
    const body = toProblem(
      new ConflictError('version_conflict', 'Changed by someone else', { current: { version: 3 } }),
      'req-1',
    );
    expect(body).toEqual({
      type: 'urn:fibrex:problem:version_conflict',
      title: 'Conflict',
      status: 409,
      code: 'version_conflict',
      detail: 'Changed by someone else',
      requestId: 'req-1',
      current: { version: 3 },
    });
  });

  it('extras cannot overwrite the standard members', () => {
    const err = new AppError(400, 'x', 'Bad request', 'd', { status: 200, code: 'spoof' });
    const body = toProblem(err, undefined);
    expect(body.status).toBe(400);
    expect(body.code).toBe('x');
  });

  it('includes field issues for validation errors', () => {
    const body = toProblem(
      new ValidationError([{ path: 'amount', message: 'Required', code: 'invalid_type' }]),
      undefined,
    );
    expect(body.errors).toEqual([{ path: 'amount', message: 'Required', code: 'invalid_type' }]);
  });

  it('carries Retry-After for rate limiting', () => {
    expect(new TooManyRequestsError(12).headers).toEqual({ 'Retry-After': '12' });
  });
});

describe('normaliseError', () => {
  it('maps Zod errors to validation_failed with dotted paths', () => {
    const result = z
      .object({ lines: z.array(z.object({ amount: z.string() })) })
      .safeParse({ lines: [{ amount: 5 }] });
    if (result.success) throw new Error('expected failure');
    const err = normaliseError(result.error);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).issues[0]?.path).toBe('lines.0.amount');
  });

  it('maps body-parser errors', () => {
    expect(normaliseError({ type: 'entity.parse.failed', status: 400 }).code).toBe(
      'malformed_json',
    );
    expect(normaliseError({ type: 'entity.too.large', status: 413 }).status).toBe(413);
  });

  it('hides unknown errors behind a generic 500', () => {
    const err = normaliseError(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'));
    expect(err.status).toBe(500);
    expect(err.code).toBe('internal_error');
    expect(err.message).not.toContain('hunter2');
    expect(err.message).not.toContain('10.0.0.5');
  });
});
