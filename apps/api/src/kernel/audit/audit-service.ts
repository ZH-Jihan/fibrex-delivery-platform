/**
 * AuditService: the shared way to write and read the audit trail.
 *
 * Purpose:
 *   - Data changes (create, update, delete, restore) are NOT written here. A database
 *     trigger on every business table records them with a field diff, so no module can
 *     forget (docs/PLAN.md section 2.3).
 *   - `record()` is for events that are not a row change: login, export, file download,
 *     approval, AI tool call. A module states what happened; who did it, from which
 *     address, in which request and with which roles is taken from the transaction context
 *     by the database (trigger audit.tg_audit_log_stamp), so it cannot be forged here.
 *   - `list()`, `history()` and `exportCsv()` read the trail for the Activity Log and the
 *     History tab. Row-level security limits them to the caller's tenant and companies.
 *   - `verify()` recomputes the tamper-evidence hash chain (audit.verify_chain in SQL).
 *
 * Everything runs inside the caller's unit of work: an audit row commits or rolls back
 * together with the action it describes.
 *
 * Depends on: ../db/unit-of-work.ts, ../http/errors.ts, generated Prisma.
 * Used by: ./audit-router.ts, and every module that has non-data events (IAM from commit 7).
 */
import type { AuditLog, Prisma } from '../../generated/prisma/client.js';
import { currentUnit } from '../db/unit-of-work.js';
import { UnprocessableError } from '../http/errors.js';

export interface AuditEvent {
  /** Lower-case key: 'login', 'export', 'download', 'approve', 'transition', ... */
  action: string;
  moduleKey: string;
  /** What it was done to, as '<schema>.<table>' when it is a record. */
  entityType: string;
  entityId?: string;
  /** Leave out for tenant-level events. */
  companyId?: string;
  diff?: Prisma.InputJsonObject;
  meta?: Prisma.InputJsonObject;
}

export interface AuditFilter {
  userId?: string | undefined;
  moduleKey?: string | undefined;
  action?: string | undefined;
  entityType?: string | undefined;
  entityId?: string | undefined;
  /** Inclusive start and exclusive end of the period. */
  from?: Date | undefined;
  to?: Date | undefined;
}

/** One audit row as the API returns it. */
export interface AuditEntry {
  id: string;
  at: string;
  /** Position in the tenant's hash chain; null until the sealing job has run. */
  seq: number | null;
  userId: string | null;
  impersonatorId: string | null;
  roleKeys: string[];
  ip: string | null;
  requestId: string | null;
  companyId: string | null;
  moduleKey: string;
  entityType: string;
  entityId: string | null;
  action: string;
  diff: unknown;
  meta: unknown;
}

export interface AuditPage {
  items: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ChainVerification {
  ok: boolean;
  sealsChecked: number;
  rowsChecked: number;
  /** Rows written since the last sealing run; not yet protected by the chain. */
  unsealedRows: number;
  failedSealId: string | null;
  failedFromSeq: number | null;
  failure: string | null;
}

export interface ExportRecord {
  moduleKey: string;
  entityType: string;
  filters: Prisma.InputJsonObject;
  rowCount: number;
  format: string;
  fileId?: string;
}

export interface CsvExport {
  csv: string;
  rowCount: number;
}

export const AUDIT_MAX_PAGE_SIZE = 200;
/** Largest export in one file; beyond it the user narrows the filters. */
export const AUDIT_EXPORT_MAX_ROWS = 50_000;
const EXPORT_CHUNK = 2_000;

const NEWEST_FIRST: Prisma.AuditLogOrderByWithRelationInput[] = [{ at: 'desc' }, { id: 'desc' }];

function toWhere(filter: AuditFilter): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};
  if (filter.userId !== undefined) where.userId = filter.userId;
  if (filter.moduleKey !== undefined) where.moduleKey = filter.moduleKey;
  if (filter.action !== undefined) where.action = filter.action;
  if (filter.entityType !== undefined) where.entityType = filter.entityType;
  if (filter.entityId !== undefined) where.entityId = filter.entityId;
  if (filter.from !== undefined || filter.to !== undefined) {
    where.at = {
      ...(filter.from === undefined ? {} : { gte: filter.from }),
      ...(filter.to === undefined ? {} : { lt: filter.to }),
    };
  }
  return where;
}

export function toAuditEntry(row: AuditLog): AuditEntry {
  return {
    id: row.id,
    at: row.at.toISOString(),
    seq: row.seq === null ? null : Number(row.seq),
    userId: row.userId,
    impersonatorId: row.impersonatorId,
    roleKeys: row.roleKeys,
    ip: row.ip,
    requestId: row.requestId,
    companyId: row.companyId,
    moduleKey: row.moduleKey,
    entityType: row.entityType,
    entityId: row.entityId,
    action: row.action,
    diff: row.diff,
    meta: row.meta,
  };
}

/**
 * One CSV cell. Quotes are doubled; a cell that a spreadsheet would run as a formula
 * (starts with = + - @ or a control character) is prefixed with an apostrophe, so an
 * exported value typed by a user cannot execute on the reader's computer.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
  else text = JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

const CSV_COLUMNS: readonly (keyof AuditEntry)[] = [
  'at',
  'seq',
  'userId',
  'impersonatorId',
  'roleKeys',
  'ip',
  'requestId',
  'companyId',
  'moduleKey',
  'entityType',
  'entityId',
  'action',
  'diff',
  'meta',
];

export interface AuditService {
  record(event: AuditEvent): Promise<void>;
  /** Writes the export_log row and the matching 'export' audit event. */
  recordExport(record: ExportRecord): Promise<void>;
  list(filter: AuditFilter, page: number, pageSize: number): Promise<AuditPage>;
  /** Every audit row of one record, newest first (the History tab). */
  history(entityType: string, entityId: string, page: number, pageSize: number): Promise<AuditPage>;
  /** The filtered audit log as CSV; the export itself is logged. */
  exportCsv(filter: AuditFilter): Promise<CsvExport>;
  verify(): Promise<ChainVerification>;
}

export function createAuditService(): AuditService {
  async function record(event: AuditEvent): Promise<void> {
    const { db, context } = currentUnit();
    await db.auditLog.create({
      data: {
        tenantId: context.tenantId,
        companyId: event.companyId ?? null,
        moduleKey: event.moduleKey,
        entityType: event.entityType,
        entityId: event.entityId ?? null,
        action: event.action,
        ...(event.diff === undefined ? {} : { diff: event.diff }),
        ...(event.meta === undefined ? {} : { meta: event.meta }),
      },
    });
  }

  async function recordExport(exported: ExportRecord): Promise<void> {
    const { db, context } = currentUnit();
    await db.exportLog.create({
      data: {
        tenantId: context.tenantId,
        userId: context.userId ?? null,
        entityType: exported.entityType,
        filters: exported.filters,
        rowCount: exported.rowCount,
        format: exported.format,
        fileId: exported.fileId ?? null,
      },
    });
    await record({
      action: 'export',
      moduleKey: exported.moduleKey,
      entityType: exported.entityType,
      meta: {
        format: exported.format,
        rowCount: exported.rowCount,
        filters: exported.filters,
      },
    });
  }

  async function list(filter: AuditFilter, page: number, pageSize: number): Promise<AuditPage> {
    const { db } = currentUnit();
    const take = Math.min(Math.max(1, pageSize), AUDIT_MAX_PAGE_SIZE);
    const current = Math.max(1, page);
    const where = toWhere(filter);
    // One after the other: both run on the transaction's single connection.
    const rows = await db.auditLog.findMany({
      where,
      orderBy: NEWEST_FIRST,
      skip: (current - 1) * take,
      take,
    });
    const total = await db.auditLog.count({ where });
    return { items: rows.map(toAuditEntry), total, page: current, pageSize: take };
  }

  async function exportCsv(filter: AuditFilter): Promise<CsvExport> {
    const { db } = currentUnit();
    const where = toWhere(filter);
    const total = await db.auditLog.count({ where });
    if (total > AUDIT_EXPORT_MAX_ROWS) {
      throw new UnprocessableError(
        'export_too_large',
        `This export has ${String(total)} rows; the limit is ${String(AUDIT_EXPORT_MAX_ROWS)}. Narrow the filters or the dates.`,
      );
    }
    const lines: string[] = [CSV_COLUMNS.map(csvCell).join(',')];
    for (let skip = 0; skip < total; skip += EXPORT_CHUNK) {
      const rows = await db.auditLog.findMany({
        where,
        orderBy: NEWEST_FIRST,
        skip,
        take: EXPORT_CHUNK,
      });
      for (const row of rows) {
        const entry = toAuditEntry(row);
        lines.push(CSV_COLUMNS.map((column) => csvCell(entry[column])).join(','));
      }
    }
    const rowCount = lines.length - 1;
    // The export is itself an audited event, written in the same transaction.
    await recordExport({
      moduleKey: 'audit',
      entityType: 'audit.audit_log',
      filters: JSON.parse(JSON.stringify(filter)) as Prisma.InputJsonObject,
      rowCount,
      format: 'csv',
    });
    return { csv: `${lines.join('\r\n')}\r\n`, rowCount };
  }

  async function verify(): Promise<ChainVerification> {
    const { db } = currentUnit();
    const rows = await db.$queryRaw<
      {
        ok: boolean;
        seals_checked: number;
        rows_checked: bigint;
        unsealed_rows: bigint;
        failed_seal_id: string | null;
        failed_from_seq: bigint | null;
        failure: string | null;
      }[]
    >`SELECT ok, seals_checked, rows_checked, unsealed_rows, failed_seal_id::text AS failed_seal_id,
             failed_from_seq, failure
        FROM audit.verify_chain()`;
    const row = rows[0];
    if (row === undefined) throw new Error('audit.verify_chain returned no row');
    return {
      ok: row.ok,
      sealsChecked: row.seals_checked,
      rowsChecked: Number(row.rows_checked),
      unsealedRows: Number(row.unsealed_rows),
      failedSealId: row.failed_seal_id,
      failedFromSeq: row.failed_from_seq === null ? null : Number(row.failed_from_seq),
      failure: row.failure,
    };
  }

  return {
    record,
    recordExport,
    list,
    history: (entityType, entityId, page, pageSize) =>
      list({ entityType, entityId }, page, pageSize),
    exportCsv,
    verify,
  };
}
