/**
 * Document status rule and document input schemas (phase 3 row 3.2).
 *
 * Depends on: ./documents.ts. Used by: the shared unit test run.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveDocumentStatus,
  documentCreateSchema,
  documentNumberSchema,
  documentTypeCreateSchema,
} from './documents.js';

const today = '2026-11-19';
const status = (
  expiryDate: string | null,
  alertWindows: number[] | null = null,
  replaced = false,
) => deriveDocumentStatus({ expiryDate, today, alertWindows, replaced });

describe('deriveDocumentStatus', () => {
  it('is valid without an expiry date and far from expiry', () => {
    expect(status(null)).toBe('valid');
    expect(status('2026-12-04')).toBe('valid'); // 15 days left, default windows 14 and 7
  });

  it('is expiring inside the largest window, including the expiry day itself', () => {
    expect(status('2026-12-03')).toBe('expiring'); // 14 days
    expect(status('2026-11-26')).toBe('expiring'); // 7 days
    expect(status(today)).toBe('expiring'); // still valid on its last day
  });

  it('is expired from the day after the expiry date', () => {
    expect(status('2026-11-18')).toBe('expired');
  });

  it('uses the type windows when it has them', () => {
    expect(status('2026-12-19', [30, 7])).toBe('expiring'); // 30 days
    expect(status('2026-12-03', [3])).toBe('valid');
  });

  it('keeps a replaced document replaced whatever its dates', () => {
    expect(status('2020-01-01', null, true)).toBe('replaced');
  });

  it('counts calendar days across a month end', () => {
    expect(
      deriveDocumentStatus({
        expiryDate: '2027-03-01',
        today: '2027-02-28',
        alertWindows: [1],
        replaced: false,
      }),
    ).toBe('expiring');
  });
});

describe('document schemas', () => {
  const owner = { ownerType: 'party', ownerId: '0190a7c4-0000-7000-8000-000000000001' };

  it('needs a type or a custom name, not both and not neither', () => {
    const typeId = '0190a7c4-0000-7000-8000-000000000002';
    expect(documentCreateSchema.safeParse({ ...owner, documentTypeId: typeId }).success).toBe(true);
    expect(documentCreateSchema.safeParse({ ...owner, customName: 'Gym pass' }).success).toBe(true);
    expect(documentCreateSchema.safeParse(owner).success).toBe(false);
    expect(
      documentCreateSchema.safeParse({ ...owner, documentTypeId: typeId, customName: 'X' }).success,
    ).toBe(false);
  });

  it('refuses an expiry before the issue date and a status in the body', () => {
    const base = { ...owner, customName: 'Gym pass' };
    expect(
      documentCreateSchema.safeParse({ ...base, issueDate: '2026-02-01', expiryDate: '2026-01-01' })
        .success,
    ).toBe(false);
    expect(documentCreateSchema.safeParse({ ...base, status: 'valid' }).success).toBe(false);
  });

  it('accepts only number characters that survive normalisation and masking', () => {
    expect(documentNumberSchema.safeParse('AB-123 45/6').success).toBe(true);
    expect(documentNumberSchema.safeParse('12*34').success).toBe(false);
  });

  it('requires an English type name and sane alert windows', () => {
    const type = { code: 'gym_pass', appliesTo: 'party' };
    expect(documentTypeCreateSchema.safeParse({ ...type, name: { en: 'Gym' } }).success).toBe(true);
    expect(documentTypeCreateSchema.safeParse({ ...type, name: { bn: 'জিম' } }).success).toBe(
      false,
    );
    expect(
      documentTypeCreateSchema.safeParse({ ...type, name: { en: 'Gym' }, alertWindows: [400] })
        .success,
    ).toBe(false);
  });
});
