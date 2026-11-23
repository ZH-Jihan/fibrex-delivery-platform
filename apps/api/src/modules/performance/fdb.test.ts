/**
 * Unit tests for the FDB tab parser and the comparison (phase 4 row 4.9). Fake names and ids
 * only, in the real layout (totals row 1, header row 2, header text sometimes unreadable).
 */
import { describe, expect, it } from 'vitest';
import { compareFdb, differenceKey, type FdbOurPerson } from './fdb-compare.js';
import { fdbDate, parseFdbReport } from './fdb-parser.js';
import type { SheetCell, SheetGrid } from './report-adapter.js';

const HEAD: SheetCell[] = [
  'Falcon ID',
  'Agent Name',
  'Type',
  'Account Status',
  'Employment Status',
  'Documents Status',
  'Sponsorship',
  'Secondment (Iaara)',
  'QID',
  'Passport',
  'Istimara',
  'Driving License',
  'Insurance',
  'FHC',
  'Health Card',
];

function person(id: string, over: Partial<Record<number, SheetCell>> = {}): SheetCell[] {
  const row: SheetCell[] = [
    id,
    `Rider ${id}`,
    'Rider',
    'Active',
    'active',
    'Updated',
    'No',
    null,
    new Date('2027-01-15T00:00:00Z'),
    new Date('2028-02-01T00:00:00Z'),
    null,
    new Date('2027-03-10T00:00:00Z'),
    null,
    null,
    new Date('2027-05-05T00:00:00Z'),
  ];
  for (const [i, v] of Object.entries(over)) row[Number(i)] = v ?? null;
  return row;
}

const grid = (header: SheetCell[], ...rows: SheetCell[][]): SheetGrid => ({
  tab: 'FDB Report',
  rows: [['FDB Report:', 'Fake Co', null, 'Active Fleet:2'], header, ...rows],
});

describe('fdbDate', () => {
  it('reads dates, serial numbers and the common text forms', () => {
    expect(fdbDate(new Date('2027-01-15T00:00:00Z'))).toBe('2027-01-15');
    expect(fdbDate(46037)).toBe('2026-01-15');
    expect(fdbDate('2027-01-15')).toBe('2027-01-15');
    expect(fdbDate('15-Jan-2027')).toBe('2027-01-15');
    expect(fdbDate('15/01/2027')).toBe('2027-01-15');
    expect(fdbDate('NA')).toBeNull();
    expect(fdbDate(12)).toBeNull();
    expect(fdbDate(new Date('x'))).toBeNull();
    expect(fdbDate('31/02/2027')).toBeNull();
  });
});

describe('parseFdbReport', () => {
  it('reads rows by header text', () => {
    const out = parseFdbReport(grid(HEAD, person('9001'), person('9002')));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.report.headerRow).toBe(2);
    expect(out.report.positional).toEqual([]);
    expect(out.report.rows).toHaveLength(2);
    const first = out.report.rows[0];
    expect(first?.identifier).toBe('9001');
    expect(first?.employmentStatus).toBe('active');
    expect(first?.dates.qid).toBe('2027-01-15');
    expect(first?.dates.driving_licence).toBe('2027-03-10');
    expect(first?.dates.health_card).toBe('2027-05-05');
    expect(first?.dates.insurance).toBeNull();
  });

  it('finds the date columns by position when their headers cannot be read', () => {
    // Snoonu's header cells are text in date-formatted cells: they arrive blank.
    const head = HEAD.map((h, i) => (i >= 7 && i !== 13 ? null : h));
    const out = parseFdbReport(grid(head, person('9001')));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.report.positional).toContain('qid');
    expect(out.report.positional).toContain('health_card');
    expect(out.report.rows[0]?.dates.passport).toBe('2028-02-01');
    expect(out.report.rows[0]?.dates.health_card).toBe('2027-05-05');
    // FHC kept its readable header.
    expect(out.report.positional).not.toContain('food_handling');
  });

  it('keeps text such as NA as a note, skips blank rows and reports a repeated id', () => {
    const out = parseFdbReport(
      grid(HEAD, person('9001', { 12: 'NA' }), [null, null], person('9001'), person(' 9003 ')),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.report.rows.map((r) => r.identifier)).toEqual(['9001', '9003']);
    expect(out.report.rows[0]?.notes.insurance).toBe('NA');
    expect(out.report.rowErrors).toHaveLength(1);
    expect(out.report.rowErrors[0]?.code).toBe('duplicate_identifier');
  });

  it('refuses a tab with no Falcon ID header', () => {
    const out = parseFdbReport({
      tab: 'FDB Report',
      rows: [
        ['x', 'y'],
        ['a', 'b'],
      ],
    });
    expect(out.ok).toBe(false);
  });
});

const ours = (over: Partial<FdbOurPerson> = {}): FdbOurPerson => ({
  partyId: 'p1',
  displayName: 'Ours One',
  statusCode: 'active',
  expiry: {
    qid: '2027-01-15',
    passport: '2028-02-01',
    driving_licence: '2027-03-10',
    health_card: '2027-05-05',
  },
  ...over,
});

function compare(rows: SheetCell[][], people: FdbOurPerson[], holders: Record<string, string>) {
  const out = parseFdbReport(grid(HEAD, ...rows));
  if (!out.ok) throw new Error(out.message);
  return compareFdb({
    rows: out.report.rows,
    holderOf: (id) => holders[id] ?? null,
    ours: new Map(people.map((p) => [p.partyId, p])),
    activeWithId: people.filter((p) => p.statusCode === 'active'),
  });
}

describe('compareFdb', () => {
  it('finds nothing when both sides agree', () => {
    const r = compare([person('9001')], [ours()], { '9001': 'p1' });
    expect(r.differences).toEqual([]);
    expect(r.matched).toBe(1);
  });

  it('lists a date that differs, one we lack and one they lack', () => {
    const r = compare(
      [
        person('9001', {
          8: new Date('2027-02-15T00:00:00Z'),
          12: new Date('2027-09-09T00:00:00Z'),
        }),
      ],
      [
        ours({
          expiry: {
            qid: '2027-01-15',
            passport: '2028-02-01',
            driving_licence: '2027-03-10',
            health_card: '2027-05-05',
            food_handling: '2027-06-06',
          },
        }),
      ],
      { '9001': 'p1' },
    );
    const by = (kind: string) => r.differences.filter((d) => d.kind === kind);
    expect(by('expiry_differs')).toMatchObject([
      { field: 'qid', oursValue: '2027-01-15', theirsValue: '2027-02-15' },
    ]);
    expect(by('missing_ours')).toMatchObject([{ field: 'insurance', theirsValue: '2027-09-09' }]);
    expect(by('missing_theirs')).toMatchObject([
      { field: 'food_handling', oursValue: '2027-06-06' },
    ]);
  });

  it('does not call "NA" a missing date, and ignores Istimara', () => {
    const r = compare(
      [person('9001', { 13: 'NA', 10: new Date('2027-01-01T00:00:00Z') })],
      [
        ours({
          expiry: {
            qid: '2027-01-15',
            passport: '2028-02-01',
            driving_licence: '2027-03-10',
            health_card: '2027-05-05',
            food_handling: '2027-06-06',
          },
        }),
      ],
      { '9001': 'p1' },
    );
    expect(r.differences).toEqual([]);
  });

  it('flags a status difference, an unknown id, a person without an employee record and a person the tab omits', () => {
    const r = compare(
      [person('9001', { 4: 'blocked' }), person('9002'), person('9003')],
      [
        ours(),
        ours({ partyId: 'p3', displayName: 'No Employee', statusCode: null }),
        ours({ partyId: 'p4', displayName: 'Left Out' }),
      ],
      { '9001': 'p1', '9003': 'p3' },
    );
    const kinds = r.differences.map((d) => d.kind).sort();
    expect(kinds).toEqual(['no_employee', 'not_in_fdb', 'status_differs', 'unmatched_id']);
    expect(r.unmatched).toBe(1);
    expect(r.differences.find((d) => d.kind === 'status_differs')).toMatchObject({
      oursValue: 'active',
      theirsValue: 'blocked',
    });
    expect(r.differences.find((d) => d.kind === 'not_in_fdb')?.displayName).toBe('Left Out');
  });

  it('gives the same key to the same difference', () => {
    const a = compare([person('9001', { 8: new Date('2027-02-15T00:00:00Z') })], [ours()], {
      '9001': 'p1',
    });
    const b = compare([person('9001', { 8: new Date('2027-02-15T00:00:00Z') })], [ours()], {
      '9001': 'p1',
    });
    const [first] = a.differences;
    const [second] = b.differences;
    if (first === undefined || second === undefined) throw new Error('expected a difference');
    expect(differenceKey(first)).toBe(differenceKey(second));
  });
});
