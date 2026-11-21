/**
 * Row 4.5c: the one identifier normaliser and the holder-on-a-date pick, shared by the
 * identifier API, the employee import, the platform sync and the unmatched queue.
 */
import { describe, expect, it } from 'vitest';
import { holderOn, type IdentifierHolder } from './party-service.js';
import { normaliseIdentifierValue } from './vault.js';

describe('normaliseIdentifierValue', () => {
  it('gives a sheet number and a typed text the same value', () => {
    expect(normaliseIdentifierValue(47370)).toBe('47370');
    expect(normaliseIdentifierValue('47370')).toBe('47370');
    expect(normaliseIdentifierValue(' 47 370 ')).toBe('47370');
    expect(normaliseIdentifierValue(47370.0)).toBe('47370');
  });

  it('ignores case, spaces and dashes, and keeps leading zeros', () => {
    expect(normaliseIdentifierValue('fc-14 01')).toBe('FC1401');
    expect(normaliseIdentifierValue('047370')).toBe('047370');
  });
});

describe('holderOn', () => {
  const period = (
    partyId: string,
    validFrom: string,
    validTo: string | null,
  ): IdentifierHolder => ({
    identifierId: partyId,
    version: 1,
    createdOn: '2026-11-21',
    value: '47370',
    partyId,
    validFrom,
    validTo,
  });
  const holders = [period('old', '1900-01-01', '2026-10-31'), period('new', '2026-11-01', null)];

  it('picks the period that covers the date, from a raw sheet value', () => {
    expect(holderOn(holders, ' 47370', '2026-10-26')).toBe('old');
    expect(holderOn(holders, '47370', '2026-11-01')).toBe('new');
    expect(holderOn(holders, '47371', '2026-11-01')).toBeNull();
  });

  it('finds nobody before a period starts', () => {
    expect(holderOn([period('p', '2026-11-21', null)], '47370', '2026-11-20')).toBeNull();
  });
});
