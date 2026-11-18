/**
 * Bank statement import API (phase 2 row 2.17a; PLAN 3.9, SPEC 2.12).
 *
 *   POST /bank-statements          import a CSV or Excel (.xlsx, first sheet) already uploaded as
 *                                  a file (the body maps its columns); creates the statement
 *                                  and all its lines
 *   GET  /bank-statements          list (filters companyBankAccountId, status)
 *   GET  /bank-statements/{id}     one statement
 *   PATCH /bank-statements/{id}    change the note
 *   DELETE /bank-statements/{id}   to the recycle bin, with a reason (lines go with it)
 *   GET  /bank-statements/{id}/lines   the lines, paged (filter matchStatus)
 *
 * Rules, and why:
 *   1. All or nothing: one bad row (date, amount) refuses the whole file and lists up to 50
 *      problems with their row numbers. Nothing is corrected silently, so the ledger side
 *      of a reconciliation is never matched against a guessed number.
 *   2. The original file is kept as a `raw_input` (SPEC 2.12) before anything else is
 *      written.
 *   3. The same file (SHA-256) cannot be imported twice for one bank account, and a new
 *      statement may not overlap the dates of a live one, so a transaction is never counted
 *      twice. Delete the old statement first to replace it.
 *   4. Lines are in the currency of the cash location; the amount is signed (in > 0).
 *   5. Lines never change after import (database trigger); only their match status moves
 *      (row 2.17b). A statement with matched lines, or marked reconciled, cannot be deleted.
 *
 * Depends on: express, zod, @fibrex/shared (parsing), kernel/db, kernel/http,
 * adapters/storage. Used by: ./index.ts (the gl module manifest).
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  SheetError,
  bankStatementImportSchema,
  bankStatementUpdateSchema,
  normaliseStatement,
  parseCsv,
} from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { StorageAdapter } from '../../adapters/storage/interface.js';
import type { Db } from '../../kernel/db/prisma.js';
import { createRepository, type Repository } from '../../kernel/db/repository.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { createCrudRouter } from '../../kernel/http/crud-router.js';
import { readXlsx } from '../../kernel/imports/xlsx-sheet.js';
import { NotFoundError, UnprocessableError, ValidationError } from '../../kernel/http/errors.js';
import { registerRoute } from '../../kernel/http/openapi.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';

export type BankStatementRecord = NonNullable<
  Awaited<ReturnType<Db['glBankStatement']['findFirst']>>
>;
export type BankStatementLineRecord = NonNullable<
  Awaited<ReturnType<Db['glBankStatementLine']['findFirst']>>
>;

const CSV_MIME_TYPES = new Set(['text/csv', 'text/plain', 'application/vnd.ms-excel']);
const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const LINE_CHUNK = 1000;
const day = z.iso.date();
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDay = (text: string) => new Date(`${text}T00:00:00.000Z`);
const invalid = (path: string, message: string, code: string) =>
  new ValidationError([{ path, message, code }]);

const statementItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    companyBankAccountId: z.uuid(),
    rawInputId: z.uuid(),
    fileName: z.string(),
    periodFrom: day,
    periodTo: day,
    currency: z.string(),
    lineCount: z.number().int(),
    totalIn: z.string(),
    totalOut: z.string(),
    status: z.enum(['open', 'reconciled']),
    note: z.string().nullable(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'BankStatement' });
const statementFilter = z.object({
  companyBankAccountId: z.uuid().optional(),
  status: z.enum(['open', 'reconciled']).optional(),
});
const lineItem = z
  .object({
    id: z.uuid(),
    statementId: z.uuid(),
    lineNo: z.number().int(),
    valueDate: day,
    amount: z.string(),
    currency: z.string(),
    reference: z.string().nullable(),
    description: z.string().nullable(),
    matchStatus: z.enum(['unmatched', 'matched']),
  })
  .meta({ id: 'BankStatementLine' });
const linesQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  matchStatus: z.enum(['unmatched', 'matched']).optional(),
});

export const toStatementItem = (row: BankStatementRecord) => ({
  id: row.id,
  companyId: row.companyId,
  companyBankAccountId: row.companyBankAccountId,
  rawInputId: row.rawInputId,
  fileName: row.fileName,
  periodFrom: isoDay(row.periodFrom),
  periodTo: isoDay(row.periodTo),
  currency: row.currency,
  lineCount: row.lineCount,
  totalIn: row.totalIn.toFixed(4),
  totalOut: row.totalOut.toFixed(4),
  status: row.status as 'open' | 'reconciled',
  note: row.note,
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  deletedAt: row.deletedAt?.toISOString() ?? null,
});

export const toLineItem = (row: BankStatementLineRecord) => ({
  id: row.id,
  statementId: row.statementId,
  lineNo: row.lineNo,
  valueDate: isoDay(row.valueDate),
  amount: row.amount.toFixed(4),
  currency: row.currency,
  reference: row.reference,
  description: row.description,
  matchStatus: row.matchStatus as 'unmatched' | 'matched',
});

export function createBankStatementRepository(
  storage: StorageAdapter,
): Repository<BankStatementRecord> {
  const base = createRepository<BankStatementRecord>({
    model: 'glBankStatement',
    scope: 'company',
  });
  return {
    ...base,
    list: (options) =>
      base.list({
        ...options,
        orderBy: options.orderBy ?? [{ periodFrom: 'desc' }, { id: 'asc' }],
      }),

    create: async (data) => {
      const body = data as z.infer<typeof bankStatementImportSchema>;
      const { db, context } = currentUnit();

      // Step 1: the bank account, its cash location (for the currency) and the file.
      const account = await db.glCompanyBankAccount.findFirst({
        where: { id: body.companyBankAccountId, deletedAt: null },
        include: { cashLocation: true },
      });
      if (account === null) {
        throw invalid(
          'companyBankAccountId',
          'This bank account does not exist.',
          'unknown_bank_account',
        );
      }
      const file = await db.fileObject.findFirst({
        where: { id: body.fileObjectId, companyId: account.companyId },
      });
      if (file === null) {
        throw invalid('fileObjectId', 'This file does not exist.', 'unknown_file');
      }
      const isExcel = file.mimeType === XLSX_MIME_TYPE;
      if (!isExcel && !CSV_MIME_TYPES.has(file.mimeType)) {
        throw invalid(
          'fileObjectId',
          'Upload the statement as a CSV or Excel (.xlsx) file.',
          'not_a_csv',
        );
      }
      const bytes = await storage.read(file.objectKey);
      if (bytes === null) {
        throw invalid('fileObjectId', 'The file is not in storage.', 'file_missing');
      }

      // Step 2: read and check every row before writing anything (rule 1).
      let sheet;
      try {
        // Excel cells are read as text exactly like CSV fields (dates as YYYY-MM-DD, so
        // choose the "ymd" date order for a real date column), so one mapping serves both.
        sheet = isExcel
          ? await readXlsx(Buffer.from(bytes))
          : parseCsv(new TextDecoder('utf-8').decode(bytes));
      } catch (err) {
        if (err instanceof SheetError)
          throw invalid('fileObjectId', err.message, `sheet_${err.code}`);
        throw err;
      }
      const statement = normaliseStatement(sheet, body.mapping);
      if (statement.errors.length > 0) {
        throw new ValidationError(
          statement.errors.map((e) => ({
            path: e.row === 0 ? 'mapping' : `rows.${String(e.row)}.${e.field}`,
            message: e.message,
            code: 'invalid_statement_row',
          })),
        );
      }
      if (
        statement.lines.length === 0 ||
        statement.periodFrom === null ||
        statement.periodTo === null
      ) {
        throw invalid('fileObjectId', 'The file has no statement lines.', 'empty_statement');
      }

      // Step 3: not the same file again, and no overlap with a live statement (rule 3).
      const same = await db.glBankStatement.findFirst({
        where: { companyBankAccountId: account.id, sha256: file.sha256, deletedAt: null },
        select: { fileName: true },
      });
      if (same !== null) {
        throw new UnprocessableError(
          'gl_statement_duplicate',
          `This file was already imported as "${same.fileName}".`,
        );
      }
      const periodFrom = toDay(statement.periodFrom);
      const periodTo = toDay(statement.periodTo);
      const overlap = await db.glBankStatement.findFirst({
        where: {
          companyBankAccountId: account.id,
          deletedAt: null,
          periodFrom: { lte: periodTo },
          periodTo: { gte: periodFrom },
        },
        select: { fileName: true, periodFrom: true, periodTo: true },
      });
      if (overlap !== null) {
        throw new UnprocessableError(
          'gl_statement_overlap',
          `These dates overlap the statement "${overlap.fileName}" (${isoDay(overlap.periodFrom)} to ${isoDay(overlap.periodTo)}). Delete it first to replace it.`,
        );
      }

      // Step 4: keep the original (rule 2), then the statement, then its lines.
      const raw = await db.rawInput.create({
        data: {
          tenantId: context.tenantId,
          companyId: account.companyId,
          kind: 'bank_file',
          source: `bank_account:${account.id}`,
          sha256: file.sha256,
          fileObjectId: file.id,
          meta: { originalName: file.originalName, rows: sheet.rows.length },
        },
        select: { id: true },
      });
      const created = await base.create({
        companyId: account.companyId,
        companyBankAccountId: account.id,
        rawInputId: raw.id,
        fileName: file.originalName,
        sha256: file.sha256,
        periodFrom,
        periodTo,
        currency: account.cashLocation.currency,
        lineCount: statement.lines.length,
        totalIn: statement.totalIn,
        totalOut: statement.totalOut,
        note: body.note,
      });
      for (let start = 0; start < statement.lines.length; start += LINE_CHUNK) {
        await db.glBankStatementLine.createMany({
          data: statement.lines.slice(start, start + LINE_CHUNK).map((line) => ({
            tenantId: context.tenantId,
            companyId: account.companyId,
            statementId: created.id,
            lineNo: line.lineNo,
            valueDate: toDay(line.valueDate),
            amount: line.amount,
            currency: account.cashLocation.currency,
            reference: line.reference,
            description: line.description,
          })),
        });
      }
      return created;
    },

    update: (id, version, changes) => base.update(id, version, changes),

    softDelete: async (id, version, reason) => {
      const { db, context } = currentUnit();
      // Rule 5.
      const current = await base.get(id);
      const matched = await db.glBankStatementLine.count({
        where: { statementId: id, matchStatus: 'matched' },
      });
      if (current.status === 'reconciled' || matched > 0) {
        throw new UnprocessableError(
          'gl_statement_matched',
          'Lines of this statement are already matched; unmatch them first.',
        );
      }
      const deleted = await base.softDelete(id, version, reason);
      await db.glBankStatementLine.updateMany({
        where: { statementId: id, deletedAt: null },
        data: {
          deletedAt: new Date(),
          deletedBy: context.userId ?? null,
          deleteReason: 'Statement deleted',
        },
      });
      return deleted;
    },

    restore: async (id, version) => {
      const restored = await base.restore(id, version);
      await currentUnit().db.glBankStatementLine.updateMany({
        where: { statementId: id, deletedAt: { not: null }, deleteReason: 'Statement deleted' },
        data: { deletedAt: null, deletedBy: null, deleteReason: null },
      });
      return restored;
    },
  };
}

export interface BankStatementRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  storage: StorageAdapter;
}

export function createBankStatementRouter(deps: BankStatementRouterDeps): Router {
  const { uow, registry, permissions, storage } = deps;
  const router = Router();

  router.get('/bank-statements/:id/lines', async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const query = linesQuery.parse(req.query);
    const result = await uow.run(async () => {
      await permissions.require('gl.bank_statement.read');
      const { db } = currentUnit();
      const statement = await db.glBankStatement.findFirst({ where: { id }, select: { id: true } });
      if (statement === null) throw new NotFoundError();
      const where = {
        statementId: id,
        ...(query.matchStatus === undefined ? {} : { matchStatus: query.matchStatus }),
      };
      const [items, total] = await Promise.all([
        db.glBankStatementLine.findMany({
          where,
          orderBy: [{ lineNo: 'asc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
        db.glBankStatementLine.count({ where }),
      ]);
      return { items: items.map(toLineItem), total, page: query.page, pageSize: query.pageSize };
    });
    res.json(result);
  });
  registerRoute(registry, {
    method: 'get',
    path: '/bank-statements/{id}/lines',
    tags: ['Bank statements'],
    summary: 'The lines of one bank statement, in file order',
    request: { params: z.object({ id: z.uuid() }), query: linesQuery },
    responses: {
      200: {
        description: 'A page of statement lines',
        content: {
          'application/json': {
            schema: z.object({
              items: z.array(lineItem),
              total: z.number().int(),
              page: z.number().int(),
              pageSize: z.number().int(),
            }),
          },
        },
      },
    },
  });

  router.use(
    createCrudRouter<BankStatementRecord>(
      { uow, authorize: permissions.authorize, registry },
      {
        path: '/bank-statements',
        resource: 'gl.bank_statement',
        tag: 'Bank statements',
        repository: createBankStatementRepository(storage),
        schemas: {
          create: bankStatementImportSchema,
          update: bankStatementUpdateSchema,
          item: statementItem,
          filter: statementFilter,
        },
        toItem: toStatementItem,
        toWhere: (filter) => filter,
      },
    ),
  );
  return router;
}
