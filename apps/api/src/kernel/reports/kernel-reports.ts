/**
 * Reports the kernel itself provides (phase 2 row 2.13). Modules declare theirs in their
 * manifest (`ModuleManifest.reports`); these are for kernel tables.
 *
 * `integration.export_log` lists bulk exports (who took which record type out, when, how
 * many rows). It is also the worked example of the pattern: columns and filters declared as
 * data, a query that reads only through the `db` it is handed, sortable columns named
 * explicitly.
 *
 * Depends on: kernel/db, kernel/module-registry/manifest.ts. Used by: src/main.ts.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type { ReportDef } from '../module-registry/manifest.js';

const DAY_MS = 86_400_000;

export const exportLogReport: ReportDef = {
  key: 'integration.export_log',
  label: 'Export log',
  description: 'Bulk exports of record types: what left the system, when and how many rows.',
  permission: 'integration.export_job.read',
  columns: [
    { key: 'createdAt', label: 'When', type: 'datetime', sortable: true },
    { key: 'entityKey', label: 'Record type', type: 'text', sortable: true },
    { key: 'format', label: 'Format', type: 'text' },
    { key: 'status', label: 'Status', type: 'text' },
    { key: 'rowCount', label: 'Rows', type: 'number', sortable: true },
  ],
  filters: [
    { key: 'entityKey', label: 'Record type', type: 'text' },
    {
      key: 'format',
      label: 'Format',
      type: 'select',
      options: [
        { value: 'csv', label: 'CSV' },
        { value: 'xlsx', label: 'Excel' },
      ],
    },
    { key: 'from', label: 'From date', type: 'date' },
    { key: 'to', label: 'To date', type: 'date' },
  ],
  async run(db, input) {
    const where: Prisma.ExportJobWhereInput = { deletedAt: null };
    const createdAt: Prisma.DateTimeFilter = {};
    if (input.filters.entityKey !== undefined) where.entityKey = input.filters.entityKey;
    if (input.filters.format !== undefined) where.format = input.filters.format;
    if (input.filters.from !== undefined)
      createdAt.gte = new Date(`${input.filters.from}T00:00:00Z`);
    // "To" is a whole day: everything before the start of the next day.
    if (input.filters.to !== undefined) {
      createdAt.lt = new Date(Date.parse(`${input.filters.to}T00:00:00Z`) + DAY_MS);
    }
    if (createdAt.gte !== undefined || createdAt.lt !== undefined) where.createdAt = createdAt;

    const direction = input.sort?.direction ?? 'desc';
    const key = input.sort?.key ?? 'createdAt';
    // Only the columns marked sortable above reach here; `id` keeps the order stable on ties.
    const orderBy: Prisma.ExportJobOrderByWithRelationInput[] = [
      { [key]: direction },
      { id: 'desc' },
    ];
    const [items, total] = await Promise.all([
      db.exportJob.findMany({
        where,
        orderBy,
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
      db.exportJob.count({ where }),
    ]);
    return {
      rows: items.map((job) => ({
        createdAt: job.createdAt.toISOString(),
        entityKey: job.entityKey,
        format: job.format,
        status: job.status,
        rowCount: job.rowCount,
      })),
      total,
    };
  },
};

export const KERNEL_REPORTS: readonly ReportDef[] = [exportLogReport];
