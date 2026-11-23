/**
 * People reports on the report engine (phase 3 row 3.5; PLAN 5.12):
 * `people.expiring_documents`, `people.missing_documents`, `people.headcount`.
 *
 * All three read only through the `db` the engine hands them, so row-level security and the
 * caller's company scope apply. Documents need `people.document.read`; headcount needs
 * `people.employee.read`. Document numbers are never read (masked or not): the reports
 * show names, codes and dates only.
 *
 * Rules, and why:
 *   1. Expiring documents: the same rule as the expiring list (current documents, expired
 *      ones included, status derived from the company's windows) so the colours agree.
 *   2. Missing documents: a requirement applies to an employee when its formula condition
 *      (sandboxed, never eval) is true for the employee's sponsorship, current profession and
 *      nationality, and when it names a profession, that one. A document counts only if it is
 *      current (not replaced, not deleted). Only active employees are checked, because a
 *      terminated employee no longer needs papers chased.
 *   3. Headcount: counts of employees (not deleted) by status, sponsorship or profession.
 *
 * Depends on: @fibrex/formula, @fibrex/shared, kernel/module-registry, ./document-type-router.ts
 * (REQUIREMENT_INPUTS), ./expiry-service.ts (settings), ./dates.ts.
 * Used by: ./index.ts (the people manifest's `reports`).
 */
import { compileFormula, type CompiledFormula } from '@fibrex/formula';
import {
  DEFAULT_EXPIRY_SETTINGS,
  daysUntil,
  deriveDocumentStatus,
  type ReportCell,
} from '@fibrex/shared';
import type { Db } from '../../kernel/db/prisma.js';
import { BadRequestError } from '../../kernel/http/errors.js';
import type { ReportDef } from '../../kernel/module-registry/manifest.js';
import { fromDate, toDate } from './dates.js';
import { REQUIREMENT_INPUTS } from './document-type-router.js';
import { readExpirySettings } from './expiry-service.js';

type Row = Record<string, ReportCell>;

/** Sorts rows by a column (text or number) and cuts one page; the rows are not table rows. */
function pageOf(
  rows: Row[],
  input: { sort?: { key: string; direction: string } | undefined; page: number; pageSize: number },
): { rows: Row[]; total: number } {
  const sort = input.sort;
  if (sort !== undefined) {
    const direction = sort.direction === 'desc' ? -1 : 1;
    rows.sort((a, b) => {
      const x = a[sort.key] ?? '';
      const y = b[sort.key] ?? '';
      return (
        direction *
        (typeof x === 'number' && typeof y === 'number'
          ? x - y
          : String(x).localeCompare(String(y)))
      );
    });
  }
  const start = (input.page - 1) * input.pageSize;
  return { rows: rows.slice(start, start + input.pageSize), total: rows.length };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function typeName(name: unknown, fallback: string): string {
  return (name as Record<string, string> | null)?.en ?? fallback;
}

/** Display names of employees' parties, by party id. */
async function partyNames(db: Db, ids: string[]): Promise<Map<string, string>> {
  const parties = await db.party.findMany({
    where: { id: { in: ids } },
    select: { id: true, displayName: true },
  });
  return new Map(parties.map((p) => [p.id, p.displayName]));
}

export const expiringDocumentsReport: ReportDef = {
  key: 'people.expiring_documents',
  label: 'Expiring documents',
  description: 'Current documents that expire within a number of days, expired ones included.',
  permission: 'people.document.read',
  columns: [
    { key: 'ownerName', label: 'Owner', type: 'text', sortable: true },
    { key: 'employeeCode', label: 'Employee code', type: 'text', sortable: true },
    { key: 'documentName', label: 'Document', type: 'text', sortable: true },
    { key: 'expiryDate', label: 'Expiry date', type: 'date', sortable: true },
    { key: 'daysLeft', label: 'Days left', type: 'number', sortable: true },
    { key: 'status', label: 'Status', type: 'text', sortable: true },
  ],
  filters: [{ key: 'withinDays', label: 'Within days', type: 'number' }],
  async run(db, input) {
    const raw = input.filters.withinDays;
    const withinDays = raw === undefined ? 30 : Number(raw);
    if (!Number.isInteger(withinDays) || withinDays < 0 || withinDays > 365) {
      throw new BadRequestError('bad_within_days', 'Within days must be 0 to 365.');
    }
    const now = today();
    const to = new Date(Date.parse(`${now}T00:00:00Z`) + withinDays * 86_400_000);
    const docs = await db.document.findMany({
      where: {
        deletedAt: null,
        status: { not: 'replaced' },
        expiryDate: { not: null, lte: to },
      },
      include: { documentType: true },
      orderBy: [{ expiryDate: 'asc' }, { id: 'asc' }],
    });
    const settings = new Map<string, readonly number[]>();
    for (const companyId of new Set(docs.map((d) => d.companyId))) {
      settings.set(companyId, (await readExpirySettings(db, companyId)).windows);
    }
    const partyIds = docs.filter((d) => d.ownerType === 'party').map((d) => d.ownerId);
    const names = await partyNames(db, partyIds);
    const employees = await db.employee.findMany({
      where: { partyId: { in: partyIds }, deletedAt: null },
      select: { partyId: true, employeeCode: true },
    });
    const codes = new Map(employees.map((e) => [e.partyId, e.employeeCode]));
    const rows: Row[] = docs.map((doc) => {
      const expiryDate = fromDate(doc.expiryDate) ?? now;
      const own = doc.documentType?.alertWindows ?? [];
      const windows =
        own.length > 0 ? own : (settings.get(doc.companyId) ?? DEFAULT_EXPIRY_SETTINGS.windows);
      return {
        ownerName:
          doc.ownerType === 'party' ? (names.get(doc.ownerId) ?? 'Unknown') : doc.ownerType,
        employeeCode: doc.ownerType === 'party' ? (codes.get(doc.ownerId) ?? null) : null,
        documentName: typeName(doc.documentType?.name, doc.customName ?? 'Document'),
        expiryDate,
        daysLeft: daysUntil(expiryDate, now),
        status: deriveDocumentStatus({
          expiryDate,
          today: now,
          alertWindows: windows,
          replaced: false,
        }),
      };
    });
    return pageOf(rows, input);
  },
};

export const missingDocumentsReport: ReportDef = {
  key: 'people.missing_documents',
  label: 'Missing documents',
  description: 'Required documents that active employees do not have a current copy of.',
  permission: 'people.document.read',
  columns: [
    { key: 'employeeCode', label: 'Employee code', type: 'text', sortable: true },
    { key: 'employeeName', label: 'Employee', type: 'text', sortable: true },
    { key: 'sponsorship', label: 'Sponsorship', type: 'text', sortable: true },
    { key: 'profession', label: 'Profession', type: 'text', sortable: true },
    { key: 'documentName', label: 'Missing document', type: 'text', sortable: true },
  ],
  filters: [
    // Shown as a dropdown of document type names; the value sent is the type id.
    { key: 'documentTypeId', label: 'Document type', type: 'select', lookup: '/document-types' },
  ],
  async run(db, input) {
    const now = today();
    const requirements = await db.documentRequirement.findMany({
      where: {
        deletedAt: null,
        documentType: { deletedAt: null },
        ...(input.filters.documentTypeId === undefined
          ? {}
          : { documentTypeId: input.filters.documentTypeId }),
      },
      include: { documentType: true },
    });
    // Conditions are compiled once per run (they were checked when saved).
    const compiled = new Map<string, CompiledFormula>();
    for (const req of requirements) {
      if (req.conditionExpr !== null) {
        compiled.set(req.id, compileFormula(req.conditionExpr, REQUIREMENT_INPUTS, 'bool'));
      }
    }
    const employees = await db.employee.findMany({
      where: { deletedAt: null, statusCode: 'active' },
      include: {
        party: { select: { displayName: true, nationalityCode: true } },
        placements: {
          where: {
            deletedAt: null,
            validFrom: { lte: toDate(now) },
            OR: [{ validTo: null }, { validTo: { gte: toDate(now) } }],
          },
          orderBy: { validFrom: 'desc' },
          take: 1,
        },
      },
      orderBy: { employeeCode: 'asc' },
    });
    const docs = await db.document.findMany({
      where: {
        deletedAt: null,
        status: { not: 'replaced' },
        ownerType: 'party',
        ownerId: { in: employees.map((e) => e.partyId) },
        documentTypeId: { not: null },
      },
      select: { id: true, ownerId: true, documentTypeId: true, source: true },
    });
    // Row 4.9b: a date taken from the FDB check is not a held document until a scan is attached.
    const dateOnly = docs.filter((d) => d.source !== null).map((d) => d.id);
    const scanned = new Set(
      dateOnly.length === 0
        ? []
        : (
            await db.fileAttachment.findMany({
              where: { entityType: 'people.document', entityId: { in: dateOnly }, deletedAt: null },
              select: { entityId: true },
            })
          ).map((a) => a.entityId),
    );
    const held = new Set(
      docs
        .filter((d) => d.source === null || scanned.has(d.id))
        .map((d) => `${d.ownerId}:${d.documentTypeId}`),
    );
    const rows: Row[] = [];
    for (const emp of employees) {
      const profession = emp.placements[0]?.profession ?? '';
      for (const req of requirements) {
        if (req.companyId !== emp.companyId) continue;
        if (req.appliesToProfession !== null && req.appliesToProfession !== profession) continue;
        const condition = compiled.get(req.id);
        if (condition !== undefined) {
          const { value } = condition.evaluate({
            sponsorship: emp.sponsorship,
            profession,
            nationality: emp.party.nationalityCode ?? '',
          });
          if (value !== true) continue;
        }
        if (held.has(`${emp.partyId}:${req.documentTypeId}`)) continue;
        rows.push({
          employeeCode: emp.employeeCode,
          employeeName: emp.party.displayName,
          sponsorship: emp.sponsorship,
          profession: profession === '' ? null : profession,
          documentName: typeName(req.documentType.name, req.documentType.code),
        });
      }
    }
    return pageOf(rows, input);
  },
};

export const headcountReport: ReportDef = {
  key: 'people.headcount',
  label: 'Headcount',
  description: 'Number of employees by status, sponsorship or current profession.',
  permission: 'people.employee.read',
  columns: [
    { key: 'group', label: 'Group', type: 'text', sortable: true },
    { key: 'count', label: 'Employees', type: 'number', sortable: true },
  ],
  filters: [
    {
      key: 'groupBy',
      label: 'Group by',
      type: 'select',
      options: [
        { value: 'status', label: 'Status' },
        { value: 'sponsorship', label: 'Sponsorship' },
        { value: 'profession', label: 'Profession' },
      ],
    },
    { key: 'statusCode', label: 'Only status', type: 'text' },
  ],
  async run(db, input) {
    const groupBy = input.filters.groupBy ?? 'status';
    if (!['status', 'sponsorship', 'profession'].includes(groupBy)) {
      throw new BadRequestError('bad_group_by', 'Group by status, sponsorship or profession.');
    }
    const now = toDate(today());
    const employees = await db.employee.findMany({
      where: {
        deletedAt: null,
        ...(input.filters.statusCode === undefined ? {} : { statusCode: input.filters.statusCode }),
      },
      select: {
        statusCode: true,
        sponsorship: true,
        placements: {
          where: {
            deletedAt: null,
            validFrom: { lte: now },
            OR: [{ validTo: null }, { validTo: { gte: now } }],
          },
          orderBy: { validFrom: 'desc' },
          take: 1,
          select: { profession: true },
        },
      },
    });
    const counts = new Map<string, number>();
    for (const e of employees) {
      const key =
        groupBy === 'status'
          ? e.statusCode
          : groupBy === 'sponsorship'
            ? e.sponsorship
            : (e.placements[0]?.profession ?? '(none)');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const rows: Row[] = [...counts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([group, count]) => ({ group, count }));
    return pageOf(rows, input);
  },
};

export const PEOPLE_REPORTS: readonly ReportDef[] = [
  expiringDocumentsReport,
  missingDocumentsReport,
  headcountReport,
];
