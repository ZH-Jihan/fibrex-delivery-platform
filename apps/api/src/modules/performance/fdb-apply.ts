/**
 * Taking document expiry dates from the FDB check into our records (phase 4 row 4.9b).
 *
 * Purpose: for a difference of kind "We have no date" (`missing_ours`: Snoonu's tab shows an
 * expiry date, we hold none for that person and document type), create or fill the person's
 * document with that date, one at a time or all open ones at once. The people module writes
 * the document through its service interface (`DocumentDateWriter`), so the status rule, the
 * audit trigger and row-level security are the same as for a document typed in by staff.
 *
 * Hard rules, and why:
 *   - Only "missing_ours" differences that are still open. "Expiry date differs" and "Status
 *     differs" stay manual review: when both sides have a date, only a person can say which is
 *     right.
 *   - A date we already hold is never overwritten (checked again at the moment of writing,
 *     because staff may have typed one since the check ran).
 *   - A date before 2000 or after 2100 is almost surely a typing error in the sheet: skipped
 *     and listed as "odd date", never written.
 *   - The new document has no file and is marked source "snoonu_fdb": the missing-documents
 *     report still asks for the scan, and the expiry engine already uses the date.
 *   - The bulk run is one transaction per person, so a failure for one person rolls back only
 *     that person, and running it twice changes nothing: an applied difference is marked
 *     "applied" in the same transaction and is no longer open.
 *   - Every change is audited by the database trigger on the document and the difference; the
 *     bulk run adds one summary audit entry.
 *
 * Depends on: kernel/db, kernel/audit, kernel/http errors, ./fdb-compare.ts. The document
 * writer is injected (people module's `DocumentDateWriter`, structurally typed here so this
 * module imports nothing of people). Used by: ./fdb-router.ts, src/main.ts.
 */
import type { AuditService } from '../../kernel/audit/audit-service.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { NotFoundError, UnprocessableError } from '../../kernel/http/errors.js';
import type { Logger } from '../../kernel/observability/logger.js';

/** The people module's `DocumentDateWriter`, as far as this module needs it. */
export interface FdbDocumentWriter {
  applyDate(input: {
    partyId: string;
    typeCode: string;
    expiryDate: string;
    source: 'snoonu_fdb';
  }): Promise<{
    outcome: 'created' | 'updated' | 'has_date' | 'no_person' | 'no_type';
    documentId: string | null;
  }>;
}

export const APPLY_SOURCE = 'snoonu_fdb' as const;
/** Dates outside this range are treated as typing errors (inclusive years). */
export const ODD_YEAR_MIN = 2000;
export const ODD_YEAR_MAX = 2100;

export const APPLY_SKIP_REASONS = [
  'odd_date',
  'not_in_system',
  'has_date',
  'no_type',
  'failed',
] as const;
export type ApplySkipReason = (typeof APPLY_SKIP_REASONS)[number];

/** True when a yyyy-mm-dd text is a real date in the believable range. */
export function isBelievableDate(text: string | null): text is string {
  if (text === null || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) return false;
  const year = parsed.getUTCFullYear();
  return year >= ODD_YEAR_MIN && year <= ODD_YEAR_MAX;
}

export interface ApplyLine {
  differenceId: string;
  displayName: string | null;
  externalId: string | null;
  field: string | null;
  date: string | null;
}
export interface ApplyPreview {
  checkId: string | null;
  /** People who will get at least one document. */
  people: number;
  /** Documents that will be created or filled in. */
  documents: number;
  byType: { field: string; count: number }[];
  /** The first ten. */
  examples: ApplyLine[];
  /** Left out, with the reason (counted, not listed). */
  skipped: { reason: ApplySkipReason; count: number }[];
}
export interface ApplyResult {
  checkId: string | null;
  people: number;
  created: number;
  updated: number;
  applied: ApplyLine[];
  skipped: (ApplyLine & { reason: ApplySkipReason })[];
}

export interface FdbApplyDeps {
  uow: UnitOfWork;
  documents: FdbDocumentWriter;
  audit: AuditService;
  logger: Logger;
}

interface DiffRow {
  id: string;
  companyId: string;
  fdbCheckId: string;
  kind: string;
  field: string | null;
  partyId: string | null;
  externalId: string | null;
  displayName: string | null;
  theirsValue: string | null;
  reviewStatus: string;
}

const lineOf = (d: DiffRow): ApplyLine => ({
  differenceId: d.id,
  displayName: d.displayName,
  externalId: d.externalId,
  field: d.field,
  date: d.theirsValue,
});

export class FdbApplyService {
  readonly #deps: FdbApplyDeps;

  constructor(deps: FdbApplyDeps) {
    this.#deps = deps;
  }

  /** The open "We have no date" differences of a run (the newest when `checkId` is absent). */
  async #openMissing(
    checkId: string | undefined,
  ): Promise<{ checkId: string | null; rows: DiffRow[] }> {
    const { db } = currentUnit();
    const check =
      checkId === undefined
        ? await db.fdbCheck.findFirst({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
        : await db.fdbCheck.findFirst({ where: { id: checkId } });
    if (check === null) {
      if (checkId !== undefined) throw new NotFoundError();
      return { checkId: null, rows: [] };
    }
    const rows = await db.fdbDifference.findMany({
      where: { fdbCheckId: check.id, deletedAt: null, kind: 'missing_ours', reviewStatus: 'open' },
      orderBy: [{ displayName: 'asc' }, { field: 'asc' }, { id: 'asc' }],
    });
    return { checkId: check.id, rows };
  }

  /** What the bulk run would do now, without changing anything. Runs in its own transaction. */
  async preview(checkId: string | undefined): Promise<ApplyPreview> {
    return this.#deps.uow.run(async (db) => {
      const { checkId: id, rows } = await this.#openMissing(checkId);
      const skipped = new Map<ApplySkipReason, number>();
      const skip = (r: ApplySkipReason) => skipped.set(r, (skipped.get(r) ?? 0) + 1);
      const usable = rows.filter((d) => {
        if (d.partyId === null || d.field === null) {
          skip('not_in_system');
          return false;
        }
        if (!isBelievableDate(d.theirsValue)) {
          skip('odd_date');
          return false;
        }
        return true;
      });
      // A date we hold already would not be written (it may have been typed since the run).
      const parties = [...new Set(usable.flatMap((d) => (d.partyId === null ? [] : [d.partyId])))];
      const held =
        parties.length === 0
          ? []
          : await db.document.findMany({
              where: {
                ownerType: 'party',
                ownerId: { in: parties },
                deletedAt: null,
                status: { not: 'replaced' },
                expiryDate: { not: null },
              },
              select: { ownerId: true, documentType: { select: { code: true } } },
            });
      const heldKeys = new Set(held.map((h) => `${h.ownerId}:${h.documentType?.code ?? ''}`));
      const will = usable.filter((d) => {
        if (heldKeys.has(`${d.partyId}:${d.field}`)) {
          skip('has_date');
          return false;
        }
        return true;
      });
      const byType = new Map<string, number>();
      for (const d of will) byType.set(d.field ?? '', (byType.get(d.field ?? '') ?? 0) + 1);
      return {
        checkId: id,
        people: new Set(will.map((d) => d.partyId)).size,
        documents: will.length,
        byType: [...byType].map(([field, count]) => ({ field, count })),
        examples: will.slice(0, 10).map(lineOf),
        skipped: [...skipped].map(([reason, count]) => ({ reason, count })),
      };
    });
  }

  /**
   * Applies one difference. Runs in its own transaction; the caller checked the permissions.
   * Returns the line with `reason` set when it was skipped (nothing written then).
   */
  async applyOne(
    differenceId: string,
  ): Promise<{ line: ApplyLine; skipped: ApplySkipReason | null }> {
    return this.#deps.uow.run(async (db) => {
      const found = await db.fdbDifference.findFirst({
        where: { id: differenceId, deletedAt: null },
      });
      if (found === null) throw new NotFoundError();
      if (found.kind !== 'missing_ours') {
        throw new UnprocessableError(
          'not_applicable',
          'Only a difference of kind "We have no date" can be applied; the others are reviewed by hand.',
        );
      }
      if (found.reviewStatus !== 'open') {
        throw new UnprocessableError('not_open', 'This difference is not open any more.');
      }
      const result = await this.#applyRow(found);
      return { line: lineOf(found), skipped: result.skipped };
    });
  }

  /**
   * Applies every open "We have no date" difference of a run, one transaction per person.
   * The caller checked the permissions. Safe to run twice: applied rows are no longer open.
   */
  async applyAll(checkId: string | undefined): Promise<ApplyResult> {
    const { uow, audit, logger } = this.#deps;
    const first = await uow.run(() => this.#openMissing(checkId));
    const result: ApplyResult = {
      checkId: first.checkId,
      people: 0,
      created: 0,
      updated: 0,
      applied: [],
      skipped: [],
    };
    // Rows without a person cannot be grouped: they are skipped without a transaction.
    const byPerson = new Map<string, DiffRow[]>();
    for (const d of first.rows) {
      if (d.partyId === null) {
        result.skipped.push({ ...lineOf(d), reason: 'not_in_system' });
        continue;
      }
      byPerson.set(d.partyId, [...(byPerson.get(d.partyId) ?? []), d]);
    }

    for (const [partyId, rows] of byPerson) {
      try {
        // One transaction per person: either all of that person's documents, or none.
        const done = await uow.run(async (db) => {
          const out: {
            line: ApplyLine;
            outcome: string | null;
            skipped: ApplySkipReason | null;
          }[] = [];
          for (const seen of rows) {
            // Read again inside the transaction: the row may have been applied or reviewed
            // since the list was read (a second click, another user).
            const d = await db.fdbDifference.findFirst({
              where: { id: seen.id, deletedAt: null, kind: 'missing_ours', reviewStatus: 'open' },
            });
            if (d === null) continue;
            const r = await this.#applyRow(d);
            out.push({ line: lineOf(d), outcome: r.outcome, skipped: r.skipped });
          }
          return out;
        });
        let wrote = false;
        for (const o of done) {
          if (o.skipped !== null) {
            result.skipped.push({ ...o.line, reason: o.skipped });
            continue;
          }
          wrote = true;
          result.applied.push(o.line);
          if (o.outcome === 'created') result.created += 1;
          else result.updated += 1;
        }
        if (wrote) result.people += 1;
      } catch (err) {
        // The person's transaction rolled back as a whole: list all their rows as failed.
        logger.warn({ err, partyId }, 'fdb apply failed for one person');
        for (const d of rows) result.skipped.push({ ...lineOf(d), reason: 'failed' });
      }
    }

    // One summary entry for the whole run, in its own small transaction.
    const summaryCheckId = first.checkId;
    if (summaryCheckId !== null) {
      await uow.run(async () => {
        await audit.record({
          action: 'apply',
          moduleKey: 'performance',
          entityType: 'performance.fdb_check',
          entityId: summaryCheckId,
          meta: {
            people: result.people,
            created: result.created,
            updated: result.updated,
            skipped: result.skipped.length,
            skippedByReason: Object.fromEntries(
              APPLY_SKIP_REASONS.map((r) => [
                r,
                result.skipped.filter((s) => s.reason === r).length,
              ]),
            ),
          },
        });
      });
    }
    return result;
  }

  /**
   * Writes one difference's date and marks the difference applied, inside the open unit of
   * work. A skipped row is left open and nothing is written.
   */
  async #applyRow(
    d: DiffRow,
  ): Promise<{ outcome: string | null; skipped: ApplySkipReason | null }> {
    const { db, context } = currentUnit();
    if (d.partyId === null || d.field === null) return { outcome: null, skipped: 'not_in_system' };
    if (!isBelievableDate(d.theirsValue)) return { outcome: null, skipped: 'odd_date' };
    const written = await this.#deps.documents.applyDate({
      partyId: d.partyId,
      typeCode: d.field,
      expiryDate: d.theirsValue,
      source: APPLY_SOURCE,
    });
    if (written.outcome === 'no_person') return { outcome: null, skipped: 'not_in_system' };
    if (written.outcome === 'no_type') return { outcome: null, skipped: 'no_type' };
    if (written.outcome === 'has_date') return { outcome: null, skipped: 'has_date' };
    await db.fdbDifference.update({
      where: { id: d.id },
      data: {
        reviewStatus: 'applied',
        reviewNote: 'Snoonu FDB',
        reviewedAt: new Date(),
        reviewedBy: context.userId ?? null,
        version: { increment: 1 },
      },
    });
    return { outcome: written.outcome, skipped: null };
  }
}
