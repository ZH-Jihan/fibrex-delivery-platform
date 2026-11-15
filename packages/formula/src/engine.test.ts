/**
 * Unit tests of the formula engine: exact decimal money, the sandbox (allowed calls, no
 * floats, no nested loops, limits), input checks, explain trace and test cases.
 * All figures are invented.
 */
import { describe, expect, it } from 'vitest';
import {
  compileFormula,
  DEFAULT_LIMITS,
  FormulaError,
  runTestCases,
  type InputSchema,
} from './index.js';

const pay: InputSchema = {
  orders: { type: 'int' },
  rate: { type: 'decimal' },
  bonus: { type: 'decimal', default: '0' },
};

function errorOf(fn: () => unknown): FormulaError {
  try {
    fn();
  } catch (err) {
    if (err instanceof FormulaError) return err;
    throw err;
  }
  throw new Error('expected a FormulaError');
}

describe('decimal money arithmetic', () => {
  it('multiplies a rate by orders exactly', () => {
    const f = compileFormula('rate * orders + bonus', pay, 'decimal');
    expect(f.evaluate({ orders: 312, rate: '14.0000', bonus: '0.1' }).value).toBe('4368.1');
  });

  it('never uses floats: 0.1 + 0.2 is exactly 0.3', () => {
    const f = compileFormula('0.1 + 0.2', {}, 'decimal');
    expect(f.evaluate({}).value).toBe('0.3');
    const g = compileFormula('0.1 + 0.2 == 0.3', {}, 'bool');
    expect(g.evaluate({}).value).toBe(true);
  });

  it('rounds half-up only when asked', () => {
    const f = compileFormula('round(rate / 3, 2)', pay, 'decimal');
    expect(f.evaluate({ orders: 0, rate: '10' }).value).toBe('3.33');
    expect(compileFormula('round(2.345, 2)', {}, 'decimal').evaluate({}).value).toBe('2.35');
    expect(compileFormula('round(-2.345, 2)', {}, 'decimal').evaluate({}).value).toBe('-2.35');
    expect(compileFormula('round_down(2.349, 2)', {}, 'decimal').evaluate({}).value).toBe('2.34');
  });

  it('has min, max, abs, floor, ceil, sum and int conversions', () => {
    const schema: InputSchema = { fines: { type: 'list<decimal>' }, cap: { type: 'decimal' } };
    const f = compileFormula('min(sum(fines), cap)', schema, 'decimal');
    expect(f.evaluate({ fines: ['50', '25.5', 100], cap: '150' }).value).toBe('150');
    expect(f.evaluate({ fines: ['50', '25.5'], cap: '150' }).value).toBe('75.5');
    expect(compileFormula('int(floor(7.9)) + 1', {}, 'int').evaluate({}).value).toBe('8');
    expect(compileFormula('abs(-3.5) + ceil(0.2)', {}, 'decimal').evaluate({}).value).toBe('4.5');
  });

  it('mixes int and decimal and accepts an int result for a decimal formula', () => {
    expect(
      compileFormula('orders * 10', pay, 'decimal').evaluate({ orders: 3, rate: '1' }).value,
    ).toBe('30');
    expect(
      compileFormula('orders > rate', pay, 'bool').evaluate({ orders: 3, rate: '2.5' }).value,
    ).toBe(true);
  });

  it('refuses division by zero', () => {
    const f = compileFormula('rate / orders', pay, 'decimal');
    expect(errorOf(() => f.evaluate({ orders: 0, rate: '1' })).code).toBe('formula_runtime');
  });

  it('works with dates', () => {
    const schema: InputSchema = { start: { type: 'date' }, end: { type: 'date' } };
    const f = compileFormula(
      'days_between(start, end) * 1.0 / days_in_month(start)',
      schema,
      'decimal',
    );
    expect(f.evaluate({ start: '2026-02-01', end: '2026-02-15' }).value).toBe('0.5');
  });

  it('works with conditions and loops', () => {
    const schema: InputSchema = { days: { type: 'list<int>' }, platform: { type: 'string' } };
    const f = compileFormula(
      'platform == "snoonu" ? days.filter(d, d >= 10).size() * 5 : 0',
      schema,
      'int',
    );
    expect(f.evaluate({ days: [3, 10, 12], platform: 'snoonu' }).value).toBe('10');
    expect(f.evaluate({ days: [3, 10, 12], platform: 'other' }).value).toBe('0');
  });
});

describe('sandbox', () => {
  it('reports a syntax error with its place', () => {
    const err = errorOf(() => compileFormula('rate * (orders', pay, 'decimal'));
    expect(err.code).toBe('formula_syntax');
  });

  it('refuses names that are not declared inputs', () => {
    expect(errorOf(() => compileFormula('salary * 2', pay, 'decimal')).code).toBe('formula_type');
    expect(errorOf(() => compileFormula('process.env', pay, 'string')).code).toBe('formula_type');
  });

  it('refuses functions outside the allow-list', () => {
    for (const text of [
      '"aaaa".matches("(a+)+$")',
      'cel.bind(x, "a", x + x) == "aa"',
      'double(orders) > 1.0',
      'timestamp("2026-01-01T00:00:00Z") != null',
      'dyn(orders) == 1',
    ]) {
      expect(errorOf(() => compileFormula(text, pay, 'bool')).code).toBe('formula_not_allowed');
    }
  });

  it('refuses nested loops', () => {
    const schema: InputSchema = { a: { type: 'list<int>' } };
    const err = errorOf(() => compileFormula('a.all(x, a.exists(y, y > x))', schema, 'bool'));
    expect(err.code).toBe('formula_not_allowed');
  });

  it('checks the return type', () => {
    expect(errorOf(() => compileFormula('orders > 1', pay, 'decimal')).code).toBe('formula_type');
  });

  it('refuses formulas that are too large', () => {
    const long = Array.from({ length: 600 }, () => 'orders').join(' + ');
    expect(errorOf(() => compileFormula(long, pay, 'decimal')).code).toBe('formula_too_large');
    const tooLong = 'orders + '.repeat(DEFAULT_LIMITS.maxExpressionLength);
    expect(errorOf(() => compileFormula(tooLong, pay, 'int')).code).toBe('formula_too_large');
  });

  it('stops a formula that needs too many steps', () => {
    const schema: InputSchema = { a: { type: 'list<decimal>' } };
    const f = compileFormula('sum(a.map(x, x * 2))', schema, 'decimal', {
      ...DEFAULT_LIMITS,
      maxSteps: 50,
    });
    const err = errorOf(() => f.evaluate({ a: Array.from({ length: 100 }, () => '1') }));
    expect(err.code).toBe('formula_limit');
  });

  it('rejects reserved or badly formed input names', () => {
    expect(errorOf(() => compileFormula('1', { Rate: { type: 'int' } }, 'int')).code).toBe(
      'formula_input',
    );
    expect(errorOf(() => compileFormula('1', { cel: { type: 'int' } }, 'int')).code).toBe(
      'formula_input',
    );
  });
});

describe('inputs', () => {
  const f = compileFormula('rate * orders + bonus', pay, 'decimal');

  it('applies defaults and lists only the inputs read', () => {
    const result = f.evaluate({ orders: 2, rate: '10' });
    expect(result.value).toBe('20');
    expect(result.inputs).toEqual({ orders: '2', rate: '10', bonus: '0' });
  });

  it('refuses missing and wrongly typed inputs', () => {
    expect(errorOf(() => f.evaluate({ rate: '1' })).code).toBe('formula_input');
    expect(errorOf(() => f.evaluate({ orders: 1.5, rate: '1' })).code).toBe('formula_input');
    expect(errorOf(() => f.evaluate({ orders: 1, rate: 'ten' })).code).toBe('formula_input');
    expect(errorOf(() => f.evaluate({ orders: 1, rate: '1', bonus: true })).code).toBe(
      'formula_input',
    );
  });

  it('caps list lengths', () => {
    const g = compileFormula('size(a)', { a: { type: 'list<int>' } }, 'int');
    const list = Array.from({ length: DEFAULT_LIMITS.maxListLength + 1 }, () => 1);
    expect(errorOf(() => g.evaluate({ a: list })).code).toBe('formula_input');
  });
});

describe('explain trace', () => {
  it('lists each step, innermost first, in the words of the formula', () => {
    const f = compileFormula('round(rate * orders * 1.5, 2) + bonus', pay, 'decimal');
    const result = f.evaluate({ orders: 3, rate: '10.333', bonus: '1' }, { explain: true });
    expect(result.value).toBe('47.5');
    expect(result.trace).toEqual([
      { expression: 'rate * orders', value: '30.999' },
      { expression: 'rate * orders * 1.5', value: '46.4985' },
      { expression: 'round(rate * orders * 1.5, 2)', value: '46.5' },
      { expression: 'round(rate * orders * 1.5, 2) + bonus', value: '47.5' },
    ]);
  });

  it('explains only the branch that was taken', () => {
    const f = compileFormula('orders > 0 ? rate / orders : 0.0', pay, 'decimal');
    const result = f.evaluate({ orders: 0, rate: '5' }, { explain: true });
    expect(result.value).toBe('0');
    expect(result.trace?.map((s) => s.expression)).toEqual([
      'orders > 0',
      'orders > 0 ? rate / orders : 0.0',
    ]);
  });
});

describe('test cases', () => {
  it('passes by value, fails with the actual result, and reports errors', () => {
    const f = compileFormula('rate * orders', pay, 'decimal');
    const results = runTestCases(f, [
      { name: 'normal month', inputs: { orders: 10, rate: '14' }, expected: '140.00' },
      { name: 'wrong expectation', inputs: { orders: 10, rate: '14' }, expected: '141' },
      { name: 'missing input', inputs: { orders: 10 }, expected: '0' },
    ]);
    expect(results.map((r) => r.passed)).toEqual([true, false, false]);
    expect(results[1]?.actual).toBe('140');
    expect(results[2]?.error?.code).toBe('formula_input');
  });
});
