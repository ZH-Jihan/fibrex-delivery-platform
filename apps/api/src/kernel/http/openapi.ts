/**
 * OpenAPI documentation (SPEC 2.11 "documented with OpenAPI", SPEC 6.2).
 *
 * Purpose: every route registers its request and response Zod schemas here, and the
 * OpenAPI 3.1 document is generated from them. Because the same schemas validate the
 * requests, the documentation cannot drift from what the API accepts.
 *
 * Schemas are named with Zod 4's `.meta({ id: 'Name' })`, which zod-to-openapi turns into
 * a reusable `components/schemas` entry. The shared problem-details error schema and the
 * standard headers are registered once here so every route can reference them.
 *
 * Depends on: @asteasolutions/zod-to-openapi, zod. Used by: src/app.ts and module routers.
 */
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  type RouteConfig,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { IDEMPOTENCY_HEADER } from './idempotency.js';

export const problemSchema = z
  .object({
    type: z.string().meta({ example: 'urn:fibrex:problem:validation_failed' }),
    title: z.string(),
    status: z.number().int(),
    code: z.string().meta({ description: 'Stable machine-readable error code' }),
    detail: z.string().optional(),
    requestId: z.string().optional(),
    errors: z
      .array(z.object({ path: z.string(), message: z.string(), code: z.string() }))
      .optional()
      .meta({ description: 'Present for validation_failed: one entry per invalid field' }),
  })
  .meta({ id: 'Problem', description: 'RFC 9457 problem details' });

export const idempotencyKeyHeader = z
  .string()
  .min(8)
  .max(255)
  .meta({ description: 'Required on every write request; repeats return the first response' });

/** Standard error responses, merged into every registered route. */
export const standardErrorResponses: RouteConfig['responses'] = {
  400: {
    description: 'Invalid request',
    content: { 'application/problem+json': { schema: problemSchema } },
  },
  429: {
    description: 'Rate limit exceeded',
    content: { 'application/problem+json': { schema: problemSchema } },
  },
  500: {
    description: 'Unexpected server error',
    content: { 'application/problem+json': { schema: problemSchema } },
  },
};

/**
 * Schemas carrying `.meta({ id })` are added to components/schemas automatically when a
 * route references them, so nothing is pre-registered (registry.register() would require
 * patching Zod with extendZodWithOpenApi, which Fibrex avoids).
 */
export function createOpenApiRegistry(): OpenAPIRegistry {
  return new OpenAPIRegistry();
}

/**
 * Registers a route and adds the standard error responses and, for write methods, the
 * required Idempotency-Key header.
 */
export function registerRoute(registry: OpenAPIRegistry, route: RouteConfig): void {
  const isWrite = ['post', 'put', 'patch', 'delete'].includes(route.method);
  const own = route.request?.headers;
  // A write route keeps its own documented headers (for example If-Match) and gains the key.
  const headers = isWrite
    ? (own instanceof z.ZodObject ? own : z.object({})).extend({
        [IDEMPOTENCY_HEADER]: idempotencyKeyHeader,
      })
    : own;
  registry.registerPath({
    ...route,
    request: headers === undefined ? route.request : { ...route.request, headers },
    responses: { ...standardErrorResponses, ...route.responses },
  });
}

export interface DocumentInfo {
  version: string;
  serverUrl: string;
}

export function buildOpenApiDocument(
  registry: OpenAPIRegistry,
  info: DocumentInfo,
): ReturnType<OpenApiGeneratorV31['generateDocument']> {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Fibrex API',
      version: info.version,
      description:
        'Versioned REST API used by the Fibrex web app and integrations. Errors use RFC 9457 problem details. Write requests require an Idempotency-Key header.',
    },
    servers: [{ url: info.serverUrl }],
  });
}
