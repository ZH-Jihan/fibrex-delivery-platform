import { describe, expect, it } from 'vitest';
import {
  AccountResolveError,
  canonicalJson,
  journalTotals,
  postingRuleLinesSchema,
  resolveAccountCode,
  ruleAccountCodes,
  ruleInputProblems,
  type PostingRuleLine,
} from './posting.js';

const lines: PostingRuleLine[] = [
  {
    side: 'debit',
    account: { kind: 'fixed', code: '1300' },
    amount: 'amount',
    dimensions: { party: 'borrower' },
  },
  {
    side: 'credit',
    account: { kind: 'map', input: 'method', map: { cash: '1000', bank: '1010' }, default: '1000' },
    amount: 'amount',
  },
];

describe('posting rule lines', () => {
  it('accepts a rule with both sides and refuses one-sided rules', () => {
    expect(postingRuleLinesSchema.safeParse(lines).success).toBe(true);
    const oneSided = lines.map((l) => ({ ...l, side: 'debit' as const }));
    expect(postingRuleLinesSchema.safeParse(oneSided).success).toBe(false);
  });

  it('refuses an unknown dimension and a bad account code', () => {
    const bad = [{ ...lines[0], dimensions: { planet: 'x' } }, lines[1]];
    expect(postingRuleLinesSchema.safeParse(bad).success).toBe(false);
    const badCode = [{ ...lines[0], account: { kind: 'fixed', code: '' } }, lines[1]];
    expect(postingRuleLinesSchema.safeParse(badCode).success).toBe(false);
  });

  it('lists inputs that resolvers and dimensions read but the schema lacks', () => {
    expect(
      ruleInputProblems(lines, { borrower: { type: 'string' }, method: { type: 'string' } }),
    ).toEqual([]);
    const problems = ruleInputProblems(lines, { borrower: { type: 'decimal' } });
    expect(problems.map((p) => p.path)).toEqual([
      'lines.0.dimensions.party',
      'lines.1.account.input',
    ]);
  });

  it('collects every account code a rule can reach', () => {
    expect(ruleAccountCodes(lines).sort()).toEqual(['1000', '1010', '1300']);
  });
});

describe('resolveAccountCode', () => {
  it('fixed, input and map resolvers', () => {
    expect(resolveAccountCode({ kind: 'fixed', code: '1300' }, {})).toBe('1300');
    expect(resolveAccountCode({ kind: 'input', input: 'acc' }, { acc: '2100' })).toBe('2100');
    const map = lines[1]?.account;
    if (map === undefined) throw new Error('fixture');
    expect(resolveAccountCode(map, { method: 'bank' })).toBe('1010');
    expect(resolveAccountCode(map, { method: 'card' })).toBe('1000');
  });

  it('fails without a value and without a default', () => {
    expect(() => resolveAccountCode({ kind: 'input', input: 'acc' }, {})).toThrow(
      AccountResolveError,
    );
    expect(() =>
      resolveAccountCode({ kind: 'map', input: 'm', map: { a: '1000' } }, { m: 'b' }),
    ).toThrow(AccountResolveError);
    // A prototype key is not a mapped value.
    expect(() =>
      resolveAccountCode({ kind: 'map', input: 'm', map: { a: '1000' } }, { m: 'toString' }),
    ).toThrow(AccountResolveError);
  });
});

describe('journalTotals', () => {
  it('adds exactly and needs equal, non-zero sides', () => {
    const t = journalTotals([
      { debit: '0.1', credit: '0' },
      { debit: '0.2', credit: '0' },
      { debit: '0', credit: '0.3' },
    ]);
    expect(t).toEqual({ debit: '0.3000', credit: '0.3000', balanced: true });
    expect(
      journalTotals([
        { debit: '1', credit: '0' },
        { debit: '0', credit: '0.9999' },
      ]).balanced,
    ).toBe(false);
    expect(journalTotals([]).balanced).toBe(false);
  });
});

describe('canonicalJson', () => {
  it('ignores key order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 'x' }] })).toBe(
      canonicalJson({ a: [{ c: 'x', d: 2 }], b: 1 }),
    );
  });
});
