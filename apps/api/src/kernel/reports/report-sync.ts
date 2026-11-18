/**
 * Writes the reports declared in code to `cfg.report_definition` (phase 2 row 2.13).
 *
 * Purpose: the table lets the database and the admin screens know which reports exist and
 * lets `cfg.saved_report` point at one with a foreign key. Code stays the source of truth:
 * a new report is inserted, a changed label, description, permission, columns or filters is
 * updated, and a report code no longer declares is left alone (saved reports still point at
 * it; the API lists only what is registered in code). Rows that did not change are not
 * touched, so a restart does not bump versions or fill the audit log.
 *
 * Depends on: kernel/db/prisma.ts, ../module-registry/manifest.ts. Used by: src/main.ts and
 * integration tests.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type { PrismaDb } from '../db/prisma.js';
import type { ReportDef } from '../module-registry/manifest.js';

/** JSON text with object keys sorted: PostgreSQL's jsonb returns keys in its own order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

export async function syncReportDefinitions(
  prisma: PrismaDb,
  defs: readonly ReportDef[],
): Promise<void> {
  if (defs.length === 0) return;
  const seen = new Set<string>();
  for (const def of defs) {
    if (seen.has(def.key)) throw new Error(`Report ${def.key} is declared twice`);
    seen.add(def.key);
  }
  const existing = await prisma.reportDefinition.findMany({
    where: { key: { in: [...seen] } },
  });
  const byKey = new Map(existing.map((row) => [row.key, row]));
  for (const def of defs) {
    const wanted = {
      moduleKey: def.key.split('.')[0] ?? def.key,
      label: def.label,
      description: def.description ?? '',
      permissionKey: def.permission,
      config: { columns: def.columns, filters: def.filters } as unknown as Prisma.InputJsonValue,
    };
    const row = byKey.get(def.key);
    if (row === undefined) {
      await prisma.reportDefinition.create({ data: { key: def.key, ...wanted } });
      continue;
    }
    const same =
      row.moduleKey === wanted.moduleKey &&
      row.label === wanted.label &&
      row.description === wanted.description &&
      row.permissionKey === wanted.permissionKey &&
      canonical(row.config) === canonical(wanted.config);
    if (!same) await prisma.reportDefinition.update({ where: { key: def.key }, data: wanted });
  }
}
