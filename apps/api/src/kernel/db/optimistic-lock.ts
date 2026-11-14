/**
 * Optimistic locking: the version conflict error and its diff (SPEC 2.2).
 *
 * Purpose: every mutable row has a `version` that the database increases on each update
 * (trigger app.tg_row_stamp). A client must send back the version it read. If the row has
 * moved on, the write is refused with 409 and this error tells the user what happened:
 * the current record, and which of the fields they tried to change now hold a different
 * value. The web app uses that to show "your value / current value" and let them retry.
 *
 * The diff compares the submitted changes with the current row. It is not a three-way
 * merge: the row as the client first saw it is not known here (the audit history, commit
 * 6, holds it). A field listed in `conflicts` therefore means "saving would overwrite a
 * value that differs from yours", which is exactly what the user has to decide about.
 *
 * Depends on: ../http/errors.ts. Used by: kernel/db/repository.ts, kernel/http/crud-router.ts.
 */
import { ConflictError } from '../http/errors.js';

export interface FieldConflict {
  field: string;
  /** The value the client tried to save. */
  yours: unknown;
  /** The value stored now. */
  current: unknown;
}

/** JSON text with object keys sorted, so two equal values always give the same text. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      // Dates and Decimals have already been turned into strings by their toJSON().
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
      return sorted;
    }
    return v;
  });
}

/**
 * Lists the submitted fields whose value differs from the current row. Values are compared
 * as JSON, so a Date equals its ISO string and a Decimal equals its string form: the same
 * forms the API sends and receives.
 */
export function diffChanges(
  changes: Record<string, unknown>,
  current: Record<string, unknown>,
): FieldConflict[] {
  const conflicts: FieldConflict[] = [];
  for (const [field, yours] of Object.entries(changes)) {
    if (yours === undefined) continue;
    const now = current[field] ?? null;
    if (stableJson(yours) !== stableJson(now)) conflicts.push({ field, yours, current: now });
  }
  return conflicts;
}

export class VersionConflictError extends ConflictError {
  readonly expectedVersion: number;
  readonly currentRow: Record<string, unknown> & { version: number };
  readonly conflicts: FieldConflict[];

  constructor(
    expectedVersion: number,
    currentRow: Record<string, unknown> & { version: number },
    conflicts: FieldConflict[],
    /** How the current row is shown to the client (the module's DTO mapping). */
    present: (row: Record<string, unknown>) => unknown = (row) => row,
  ) {
    super(
      'version_conflict',
      'This record was changed by someone else after you opened it. Review the current values and try again.',
      {
        expectedVersion,
        currentVersion: currentRow.version,
        current: present(currentRow),
        conflicts,
      },
    );
    this.expectedVersion = expectedVersion;
    this.currentRow = currentRow;
    this.conflicts = conflicts;
  }

  /** The same conflict with the current row mapped for the client. */
  presentedWith(present: (row: Record<string, unknown>) => unknown): VersionConflictError {
    return new VersionConflictError(this.expectedVersion, this.currentRow, this.conflicts, present);
  }
}
