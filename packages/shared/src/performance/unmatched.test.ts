import { describe, expect, it } from 'vitest';
import {
  sheetPhoneToInternational,
  sheetProfessionCode,
  unmatchedLinkSchema,
} from './unmatched.js';

describe('unmatched helpers', () => {
  it('turns sheet phones into international form', () => {
    expect(sheetPhoneToInternational('5555 0101')).toBe('+97455550101');
    expect(sheetPhoneToInternational('00974 5555 0101')).toBe('+97455550101');
    expect(sheetPhoneToInternational('+974-5555-0101')).toBe('+97455550101');
    expect(sheetPhoneToInternational('97455550101')).toBe('+97455550101');
    expect(sheetPhoneToInternational('12')).toBeNull();
    expect(sheetPhoneToInternational(null)).toBeNull();
  });

  it('reads driver or rider, and nothing when unclear', () => {
    expect(sheetProfessionCode('Rider')).toBe('rider');
    expect(sheetProfessionCode('Driver')).toBe('driver');
    expect(sheetProfessionCode('Driver / Rider')).toBeNull();
    expect(sheetProfessionCode('')).toBeNull();
  });

  it('link needs exactly one of employee or person', () => {
    const id = '0190e5a0-0000-7000-8000-000000000001';
    expect(unmatchedLinkSchema.safeParse({ employeeId: id }).success).toBe(true);
    expect(unmatchedLinkSchema.safeParse({}).success).toBe(false);
    expect(unmatchedLinkSchema.safeParse({ employeeId: id, partyId: id }).success).toBe(false);
  });
});
