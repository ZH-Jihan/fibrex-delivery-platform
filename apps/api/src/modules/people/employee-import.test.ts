/** Employee import, row 3.8: how one sheet row is read (no database). All values are invented. */
import { describe, expect, it } from 'vitest';
import { parseEmployeeRow } from './employee-import.js';

describe('parseEmployeeRow', () => {
  it('turns a full row into the employee create body', () => {
    const result = parseEmployeeRow({
      displayName: 'Test Worker',
      nameAr: 'عامل',
      nationality: 'bd',
      dateOfBirth: '1995-03-14',
      qid: '29000000001',
      phones: '97455550001, +97455550002',
      joiningDate: '2026-01-15',
      sponsorship: 'Company',
      profession: 'Rider',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row.body.person).toMatchObject({
      displayName: 'Test Worker',
      names: { en: 'Test Worker', ar: 'عامل' },
      nationalityCode: 'BD',
      qid: '29000000001',
      // A phone typed as a bare number gets its plus back.
      phones: ['+97455550001', '+97455550002'],
    });
    expect(result.row.body.sponsorship).toBe('company');
    expect(result.row.body.placement).toEqual({ profession: 'rider' });
  });

  it('accepts a phone Excel stored as a number', () => {
    const result = parseEmployeeRow({ displayName: 'Num Phone', phones: 97455550003 });
    expect(result.ok && result.row.body.person?.phones).toEqual(['+97455550003']);
  });

  it('reports every problem of a row with the field it belongs to', () => {
    const result = parseEmployeeRow({
      displayName: 'Bad Row',
      phones: '12',
      nationality: 'Qatar',
      sponsorship: 'friend',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.path).sort()).toEqual([
      'nationality',
      'phones',
      'sponsorship',
    ]);
  });

  it('requires the English name', () => {
    const result = parseEmployeeRow({ qid: '29000000002' });
    expect(result).toMatchObject({ ok: false, issues: [{ path: 'displayName' }] });
  });
});
