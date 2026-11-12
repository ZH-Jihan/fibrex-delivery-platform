/**
 * Public entry point of @fibrex/shared.
 *
 * Purpose: one place for code that the API and the web app must agree on (SPEC 6.2: shared
 * Zod schemas so frontend and backend validate identically).
 * Depends on: ./money. Used by: apps/api, apps/web.
 */
export * from './money/index.js';
