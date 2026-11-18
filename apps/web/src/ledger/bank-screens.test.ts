import { describe, expect, it } from 'vitest';
import { buildConditions } from './MatchRulesPage';
import { buildMapping } from './StatementsPage';

const base = {
  dateColumn: ' Date ',
  dateFormat: 'dmy',
  split: false,
  amountColumn: 'Amount',
  debitColumn: 'Debit',
  creditColumn: 'Credit',
  referenceColumn: '',
  descriptionColumn: ' Details ',
};

describe('buildMapping', () => {
  it('sends one amount column, trimmed, and leaves out empty optional columns', () => {
    expect(buildMapping(base)).toEqual({
      dateColumn: 'Date',
      dateFormat: 'dmy',
      amountColumn: 'Amount',
      referenceColumn: undefined,
      descriptionColumn: 'Details',
    });
  });

  it('sends the debit and credit pair and never the single amount column with it', () => {
    const mapping = buildMapping({ ...base, split: true });
    expect(mapping).toMatchObject({ debitColumn: 'Debit', creditColumn: 'Credit' });
    expect('amountColumn' in mapping).toBe(false);
  });
});

describe('buildConditions', () => {
  it('keeps only what was filled in', () => {
    expect(
      buildConditions({
        direction: '',
        textContains: '',
        amountMin: '',
        amountMax: '',
        dateWindowDays: '',
      }),
    ).toEqual({});
    expect(
      buildConditions({
        direction: 'out',
        textContains: ' fuel ',
        amountMin: '10',
        amountMax: '',
        dateWindowDays: '5',
      }),
    ).toEqual({ direction: 'out', textContains: 'fuel', amountMin: '10', dateWindowDays: 5 });
  });
});
