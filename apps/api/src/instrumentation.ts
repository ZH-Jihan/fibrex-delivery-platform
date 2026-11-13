/**
 * OpenTelemetry tracing bootstrap (SPEC 6.6).
 *
 * Purpose: when OTEL_EXPORTER_OTLP_ENDPOINT is set, start the OpenTelemetry SDK so every
 * HTTP request, Express route and PostgreSQL query becomes a span exported over OTLP/HTTP,
 * and log lines carry the trace id (see kernel/observability/logger.ts). When it is not
 * set (local development, tests), nothing starts and nothing tries to connect.
 *
 * It must run before express and pg are imported, so it is loaded with
 * `node --import ./src/instrumentation.ts` (or tsx --import), not imported from main.ts.
 * The ESM loader hook is registered so instrumentations can patch ES modules.
 *
 * Depends on: @opentelemetry/*. Used by: the `dev` and `start` scripts.
 */
import { register } from 'node:module';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint !== undefined && endpoint !== '') {
  // OpenTelemetry's ESM hook is written for the off-thread module.register() API; the newer
  // in-thread registerHooks() is not supported by it yet. Revisit at the quarterly upgrade.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'fibrex-api',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
    instrumentations: [
      new HttpInstrumentation({
        // Health probes would otherwise dominate the traces.
        ignoreIncomingRequestHook: (req) => req.url === '/health' || req.url === '/ready',
      }),
      new ExpressInstrumentation(),
      // Statement text is recorded without parameter values, so no personal data leaves.
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
    ],
  });
  sdk.start();

  const shutdown = () => {
    sdk.shutdown().catch(() => undefined);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
