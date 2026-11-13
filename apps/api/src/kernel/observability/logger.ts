/**
 * Structured logger.
 *
 * Purpose: one pino logger for the whole API. Every line is JSON with the request id, and
 * the OpenTelemetry trace and span ids when tracing is on, so a log line can be followed
 * end to end (SPEC 6.3, 6.6).
 *
 * Secrets and personal identifiers must never reach the logs, so credentials, tokens and
 * cookies are redacted by path. Request bodies are not logged at all.
 *
 * Depends on: pino, @opentelemetry/api, ../context/request-context.ts.
 * Used by: src/main.ts, src/app.ts and every service that logs.
 */
import { trace } from '@opentelemetry/api';
import { pino, type Logger, type LoggerOptions } from 'pino';
import { currentContext } from '../context/request-context.js';

export type { Logger } from 'pino';

/** Paths that are always replaced with "[redacted]". */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.token',
  '*.refreshToken',
  '*.accessToken',
  '*.secret',
  '*.otp',
  '*.code',
] as const;

export interface LoggerConfig {
  level: string;
  pretty: boolean;
  serviceName: string;
}

export function createLogger(config: LoggerConfig, destination?: pino.DestinationStream): Logger {
  const options: LoggerOptions = {
    level: config.level,
    base: { service: config.serviceName },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
    // Adds request and trace ids to every line logged while handling a request.
    mixin() {
      const fields: Record<string, string> = {};
      const ctx = currentContext();
      if (ctx) fields.requestId = ctx.requestId;
      const span = trace.getActiveSpan()?.spanContext();
      if (span) {
        fields.traceId = span.traceId;
        fields.spanId = span.spanId;
      }
      return fields;
    },
  };
  if (config.pretty && destination === undefined) {
    return pino({ ...options, transport: { target: 'pino-pretty' } });
  }
  return destination ? pino(options, destination) : pino(options);
}
