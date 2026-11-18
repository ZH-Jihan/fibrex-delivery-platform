/**
 * Report service: lists, describes, runs and exports the reports modules declare in code
 * (phase 2 row 2.13; PLAN 5.9 "Reports").
 *
 * Purpose: one place that turns a `ReportDef` (columns, filters, a query) into the same
 * behaviour for every report, so a module writes only its query and never repeats the
 * permission check, filter validation, paging or export code.
 *
 * Rules (all inside the caller's unit of work, so row-level security applies to the query):
 *   1. A report is visible only to people holding its own permission; an unknown key is 404,
 *      a known one without the permission is 403 (and it is left out of the list).
 *   2. Filters and sort are checked against what the report declares BEFORE the query runs
 *      (shared `checkReportFilters`); a report never receives a filter it did not declare.
 *   3. Export additionally needs `platform.report.export`, so seeing a report on screen and
 *      taking a copy away are separate grants. The file is built in memory (at most
 *      MAX_EXPORT_ROWS rows, otherwise the caller is told to add a filter), stored, and
 *      recorded as a `file_object`; it is downloaded through the audited files endpoint.
 *   4. CSV and Excel reuse the writers of the export engine (formula-injection safe). PDF is
 *      a plain HTML table drawn by the PDF adapter of row 2.7 (no JavaScript, no network).
 *
 * Depends on: kernel/db, kernel/permissions, adapters/storage, adapters/pdf, ../imports
 * (xlsx writer), @fibrex/shared. Used by: ./report-router.ts, src/main.ts.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  buildCsv,
  can,
  checkReportFilters,
  MAX_EXPORT_ROWS,
  type ReportCell,
  type ReportFormat,
} from '@fibrex/shared';
import type { PdfRenderer } from '../../adapters/pdf/interface.js';
import type { StorageAdapter } from '../../adapters/storage/interface.js';
import { currentUnit } from '../db/unit-of-work.js';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '../http/errors.js';
import { buildXlsx } from '../imports/xlsx-sheet.js';
import type { ReportDef, ReportRunInput, ReportRunResult } from '../module-registry/manifest.js';
import type { PermissionService } from '../permissions/permission-service.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PAGE = 200;

export interface ReportServiceDeps {
  permissions: PermissionService;
  storage: StorageAdapter;
  renderer: PdfRenderer;
  /** Every report registered in code (kernel reports plus module manifests). */
  definitions: () => readonly ReportDef[];
}

/** What the caller may send to run or export: raw filters and sort, no paging checked yet. */
export interface ReportQuery {
  filters: Record<string, string>;
  sort?: { key: string; direction: 'asc' | 'desc' } | undefined;
}

export interface ReportExportResult {
  fileId: string;
  fileName: string;
  format: ReportFormat;
  rowCount: number;
}

export class ReportService {
  private readonly deps: ReportServiceDeps;

  constructor(deps: ReportServiceDeps) {
    this.deps = deps;
  }

  /** The registered definition, or 404. Does not check permission. */
  find(key: string): ReportDef {
    const def = this.deps.definitions().find((d) => d.key === key);
    if (def === undefined) throw new NotFoundError();
    return def;
  }

  /** Only the reports the caller's permissions allow, in key order. */
  async list(): Promise<ReportDef[]> {
    const access = await this.deps.permissions.current();
    return this.deps
      .definitions()
      .filter((d) => can(access, d.permission))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  /** The definition, after checking the caller may see it (403 otherwise). */
  async open(key: string): Promise<ReportDef> {
    const def = this.find(key);
    await this.deps.permissions.require(def.permission);
    return def;
  }

  async run(
    key: string,
    query: ReportQuery,
    page: number,
    pageSize: number,
  ): Promise<ReportRunResult> {
    const def = await this.open(key);
    return def.run(currentUnit().db, this.input(def, query, page, pageSize));
  }

  /** Step 2 of the rules: filters and sort checked against the declaration. */
  input(def: ReportDef, query: ReportQuery, page: number, pageSize: number): ReportRunInput {
    const checked = checkReportFilters(def.filters, query.filters);
    if (checked.problems.length > 0) {
      throw new ValidationError(
        checked.problems.map((p) => ({
          path: `filters.${p.key}`,
          message: p.message,
          code: 'invalid_filter',
        })),
      );
    }
    const input: ReportRunInput = { filters: checked.values, page, pageSize };
    if (query.sort !== undefined) {
      const column = def.columns.find((c) => c.key === query.sort?.key);
      if (column?.sortable !== true) {
        throw new BadRequestError('invalid_sort', 'This report cannot be sorted by that column.');
      }
      input.sort = query.sort;
    }
    return input;
  }

  async export(
    key: string,
    query: ReportQuery,
    format: ReportFormat,
    companyIdInput?: string,
  ): Promise<ReportExportResult> {
    const { db, context } = currentUnit();
    const def = await this.open(key);
    await this.deps.permissions.require('platform.report.export');

    const companyId =
      companyIdInput ?? (context.companyIds.length === 1 ? context.companyIds[0] : undefined);
    if (companyId === undefined) {
      throw new BadRequestError('company_required', 'State which company this export is for.');
    }
    if (!context.companyIds.includes(companyId)) {
      throw new ForbiddenError('You do not have access to this company');
    }

    // Gather every page. The total is known after the first page, so a too-large report is
    // refused before most of it is read.
    const rows: Record<string, ReportCell>[] = [];
    for (let page = 1; ; page += 1) {
      const result = await def.run(db, this.input(def, query, page, PAGE));
      if (result.total > MAX_EXPORT_ROWS) {
        throw new UnprocessableError(
          'export_too_large',
          `${String(result.total)} rows match; an export holds at most ${String(MAX_EXPORT_ROWS)}. Add a filter.`,
        );
      }
      rows.push(...result.rows);
      if (result.rows.length < PAGE || rows.length >= result.total) break;
    }

    // Column headings are the labels; two columns with the same label get their key added.
    const headings = def.columns.map((c, i) =>
      def.columns.findIndex((o) => o.label === c.label) === i ? c.label : `${c.label} (${c.key})`,
    );
    const labelled = rows.map((row) => {
      const out: Record<string, ReportCell> = {};
      def.columns.forEach((c, i) => {
        out[headings[i] ?? c.key] = row[c.key] ?? null;
      });
      return out;
    });

    let bytes: Buffer;
    let mimeType: string;
    if (format === 'csv') {
      bytes = Buffer.from(buildCsv(headings, labelled), 'utf8');
      mimeType = 'text/csv';
    } else if (format === 'xlsx') {
      bytes = await buildXlsx(def.label, headings, labelled);
      mimeType = XLSX_MIME;
    } else {
      bytes = await this.deps.renderer.render(pdfHtml(def, headings, labelled, query), 'A4');
      mimeType = 'application/pdf';
    }

    const objectKey = `${context.tenantId}/${companyId}/exports/${randomUUID()}`;
    await this.deps.storage.store(objectKey, bytes, mimeType);
    const fileName = `${key.replace(/\./g, '-')}-${new Date().toISOString().slice(0, 10)}.${format}`;
    const file = await db.fileObject.create({
      data: {
        tenantId: context.tenantId,
        companyId,
        bucket: this.deps.storage.bucket,
        objectKey,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: BigInt(bytes.length),
        mimeType,
        originalName: fileName,
      },
      select: { id: true },
    });
    return { fileId: file.id, fileName, format, rowCount: rows.length };
  }
}

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** A plain, escaped HTML table. Every cell is text from the database, so all of it is escaped. */
function pdfHtml(
  def: ReportDef,
  headings: string[],
  rows: Record<string, ReportCell>[],
  query: ReportQuery,
): string {
  const applied = Object.entries(query.filters)
    .filter(([, v]) => v.trim() !== '')
    .map(([k, v]) => `${def.filters.find((f) => f.key === k)?.label ?? k}: ${v}`)
    .join('; ');
  const head = headings.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
  const body = rows
    .map(
      (row) =>
        `<tr>${headings
          .map((h, i) => {
            const type = def.columns[i]?.type;
            const value = row[h];
            const align = type === 'number' || type === 'money' ? ' class="num"' : '';
            return `<td${align}>${escapeHtml(value === null || value === undefined ? '' : String(value))}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:Arial,Helvetica,sans-serif;font-size:10px;color:#111}
h1{font-size:16px;margin:0 0 4px}p{margin:0 0 10px;color:#555}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:3px 5px;text-align:left}
th{background:#eee}td.num{text-align:right}
</style></head><body><h1>${escapeHtml(def.label)}</h1>
<p>${escapeHtml(applied === '' ? 'No filters' : applied)} &middot; ${String(rows.length)} rows</p>
<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></body></html>`;
}
