/**
 * Public entry point of @fibrex/shared.
 *
 * Purpose: one place for code that the API and the web app must agree on (SPEC 6.2: shared
 * Zod schemas so frontend and backend validate identically).
 * Depends on: ./money, ./permissions. Used by: apps/api, apps/web.
 */
export * from './money/index.js';
export * from './permissions/index.js';
export * from './admin/index.js';
export * from './numbering/index.js';
export * from './lookups/index.js';
export * from './entities/index.js';
export * from './records/index.js';
export * from './imports/index.js';
export * from './formulas/index.js';
export * from './rates/index.js';
export * from './states/index.js';
export * from './workflows/index.js';
export * from './webhooks/index.js';
export * from './reports/index.js';
export * from './ledger/index.js';
export * from './ledger/posting.js';
export * from './ledger/journal.js';
export * from './ledger/bank.js';
export * from './ledger/reconcile.js';
export * from './people/index.js';
