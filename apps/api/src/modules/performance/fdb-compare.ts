/**
 * FDB report comparison (phase 4 row 4.9).
 *
 * Purpose: compares the rows of Snoonu's FDB tab with our own employee records and lists the
 * differences for staff to review. Pure: no database, no clock. The service
 * (./fdb-service.ts) loads our side and passes it in.
 *
 * What counts as a difference (kinds):
 *   - unmatched_id    the Falcon ID has no person in our system.
 *   - no_employee     the Falcon ID belongs to a person who has no employee record.
 *   - not_in_fdb      one of our active employees holds a Falcon ID that the tab does not list.
 *   - status_differs  Snoonu's employment status (active, inactive, blocked, terminated) is not
 *                     our status. Our status codes are the same four words.
 *   - expiry_differs both sides show a date for a document and the dates differ.
 *   - missing_ours    Snoonu shows a date and we hold no current document with a date.
 *   - missing_theirs  we hold a current document with a date and Snoonu shows none (a note such
 *                     as "NA" means "does not apply" and is not a difference).
 * Istimara is read but not compared: vehicle documents arrive in Phase 5.
 *
 * Which side is right is never decided here; both values are listed and staff decide. Nothing
 * is ever written back to either side.
 *
 * Depends on: ./fdb-parser.ts. Used by: ./fdb-service.ts.
 */
import { FDB_DOC_KEYS, type FdbDocKey, type FdbRow } from './fdb-parser.js';

export const FDB_COMPARED_DOCS: readonly FdbDocKey[] = FDB_DOC_KEYS.filter((k) => k !== 'istimara');

export const FDB_DIFFERENCE_KINDS = [
  'unmatched_id',
  'no_employee',
  'not_in_fdb',
  'status_differs',
  'expiry_differs',
  'missing_ours',
  'missing_theirs',
] as const;
export type FdbDifferenceKind = (typeof FDB_DIFFERENCE_KINDS)[number];

/** Our side for one person: the employee record and the current document dates. */
export interface FdbOurPerson {
  partyId: string;
  displayName: string;
  /** null when the person has no employee record. */
  statusCode: string | null;
  /** Expiry date of the current document by type code; null or absent when none has a date. */
  expiry: Partial<Record<string, string | null>>;
}

export interface FdbDifferenceDraft {
  kind: FdbDifferenceKind;
  /** A document type code for the document kinds. */
  field: string | null;
  partyId: string | null;
  externalId: string | null;
  displayName: string | null;
  oursValue: string | null;
  theirsValue: string | null;
}

export interface FdbCompareInput {
  rows: readonly FdbRow[];
  /** The person holding a Falcon ID, or null. */
  holderOf: (identifier: string) => string | null;
  /** Our side by party id, for the persons the rows matched. */
  ours: ReadonlyMap<string, FdbOurPerson>;
  /** Active employees holding a Falcon ID, to find those the tab does not list. */
  activeWithId: readonly FdbOurPerson[];
}

export interface FdbCompareResult {
  matched: number;
  unmatched: number;
  differences: FdbDifferenceDraft[];
}

/** Notes that mean "does not apply" rather than "missing". */
const NOT_APPLICABLE = new Set(['na', 'n/a', 'nil', 'none', '-', '--']);

export function compareFdb(input: FdbCompareInput): FdbCompareResult {
  const differences: FdbDifferenceDraft[] = [];
  const listed = new Set<string>();
  let matched = 0;
  let unmatched = 0;

  for (const row of input.rows) {
    const partyId = input.holderOf(row.identifier);
    const base = { partyId, externalId: row.identifier, displayName: row.name };
    if (partyId === null) {
      unmatched += 1;
      differences.push({
        ...base,
        kind: 'unmatched_id',
        field: null,
        oursValue: null,
        theirsValue: row.employmentStatus,
      });
      continue;
    }
    matched += 1;
    listed.add(partyId);
    const person = input.ours.get(partyId);
    const display = person?.displayName ?? row.name;
    if (person === undefined || person.statusCode === null) {
      differences.push({
        ...base,
        displayName: display,
        kind: 'no_employee',
        field: null,
        oursValue: null,
        theirsValue: row.employmentStatus,
      });
      continue;
    }

    const theirStatus = row.employmentStatus?.trim().toLowerCase() ?? null;
    if (theirStatus !== null && theirStatus !== person.statusCode.toLowerCase()) {
      differences.push({
        ...base,
        displayName: display,
        kind: 'status_differs',
        field: null,
        oursValue: person.statusCode,
        theirsValue: theirStatus,
      });
    }

    for (const doc of FDB_COMPARED_DOCS) {
      const theirs = row.dates[doc];
      const ours = person.expiry[doc] ?? null;
      const draft = { ...base, displayName: display, field: doc };
      if (theirs !== null && ours !== null) {
        if (theirs !== ours) {
          differences.push({
            ...draft,
            kind: 'expiry_differs',
            oursValue: ours,
            theirsValue: theirs,
          });
        }
      } else if (theirs !== null) {
        differences.push({ ...draft, kind: 'missing_ours', oursValue: null, theirsValue: theirs });
      } else if (ours !== null) {
        const note = row.notes[doc]?.trim().toLowerCase();
        if (note !== undefined && NOT_APPLICABLE.has(note)) continue;
        differences.push({ ...draft, kind: 'missing_theirs', oursValue: ours, theirsValue: null });
      }
    }
  }

  for (const person of input.activeWithId) {
    if (listed.has(person.partyId)) continue;
    differences.push({
      kind: 'not_in_fdb',
      field: null,
      partyId: person.partyId,
      externalId: null,
      displayName: person.displayName,
      oursValue: person.statusCode,
      theirsValue: null,
    });
  }
  return { matched, unmatched, differences };
}

/** A stable key for "the same difference as last time" (review carry-over). */
export function differenceKey(d: FdbDifferenceDraft): string {
  return [
    d.kind,
    d.field ?? '',
    d.externalId ?? d.partyId ?? '',
    d.oursValue ?? '',
    d.theirsValue ?? '',
  ].join('|');
}
