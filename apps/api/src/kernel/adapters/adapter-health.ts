/**
 * Adapter health: one `integration.integration_health` row per adapter call worth tracking
 * (PLAN 3.8 `adapter_config`, `integration_health`).
 *
 * Purpose: a shared layer, so every module records how its external adapters behave the
 * same way (status, latency, error) without touching the integration tables itself.
 *
 * Rules, and why:
 *   - The adapter_config row of (kind, provider) is created on first use. It becomes the
 *     active one only when the tenant has no active provider of that kind yet (the database
 *     allows one active provider per kind). Settings stay empty: a stub needs none.
 *   - Errors are cut to 2000 characters (the column limit) and never include request data.
 *   - Runs inside the caller's unit of work, so the health row commits with the work it
 *     describes (row-level security applies; the rows are tenant-wide).
 *
 * Depends on: kernel/db/unit-of-work. Used by: modules/people/ocr-router.ts.
 */
import { currentUnit } from '../db/unit-of-work.js';

export type AdapterKind = 'ocr';
export type AdapterHealthStatus = 'ok' | 'degraded' | 'down';

export async function recordAdapterHealth(
  kind: AdapterKind,
  provider: string,
  outcome: { status: AdapterHealthStatus; latencyMs: number; error?: string | null },
): Promise<void> {
  const { db, context } = currentUnit();
  let config = await db.adapterConfig.findFirst({
    where: { adapterKind: kind, provider, deletedAt: null },
    select: { id: true },
  });
  if (config === null) {
    const active = await db.adapterConfig.findFirst({
      where: { adapterKind: kind, active: true, deletedAt: null },
      select: { id: true },
    });
    config = await db.adapterConfig.create({
      data: { tenantId: context.tenantId, adapterKind: kind, provider, active: active === null },
      select: { id: true },
    });
  }
  await db.integrationHealth.create({
    data: {
      tenantId: context.tenantId,
      adapterConfigId: config.id,
      status: outcome.status,
      latencyMs: Math.max(0, Math.round(outcome.latencyMs)),
      error: outcome.error == null ? null : outcome.error.slice(0, 2000),
    },
  });
}
