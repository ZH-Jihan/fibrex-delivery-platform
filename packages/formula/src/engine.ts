/**
 * Sandboxed formula engine (phase 2 plan row 2.9; SPEC 2.10 "Rules and formula engine").
 *
 * Purpose: evaluate business formulas (pay components, fines, billing rates, interest,
 * eligibility ...) written by administrators in CEL, the Common Expression Language, with
 * exact decimal arithmetic for money and a step-by-step "how was this calculated" trace.
 *
 * Library: @marcbachmann/cel-js 8.0.0 (zero dependencies, maintained, has typed
 * environments, custom types/operators and parse-time size limits). It never uses `eval` or
 * `new Function`; it walks its own AST. The choice is recorded in docs/DECISIONS.md.
 *
 * Why the extra layer on top of the library, step by step:
 *   1. Money must never be a JavaScript float. CEL writes `1.5` as a double, so before
 *      type-checking every number literal with a fraction or exponent is rewritten, using its
 *      exact source text, to `decimal("1.5")`. Inputs of type decimal arrive as Decimal values,
 *      and every arithmetic/comparison operator between decimal and int is registered here
 *      on decimal.js. The `double()` conversion is not allowed, so no float can appear.
 *   2. Sandbox. The environment has no I/O functions at all. On top of that, only the calls
 *      in ALLOWED_CALLS are accepted (no regex `matches`, which could be slow; no `cel.bind`,
 *      which could double a string per step; no timestamps/durations/bytes/dyn).
 *   3. Limits. Parse-time limits on expression length, AST nodes, depth, list and map
 *      literals; input lists and strings are capped; loops (`map`, `filter`, `all`, `exists`,
 *      `exists_one`) may not be nested, so the work is at most nodes x list length. Every
 *      engine function and operator counts a step and checks the deadline, and the elapsed
 *      time is checked again at the end.
 *   4. Unknown names are a type error (undeclared variables are not allowed), so a formula can
 *      only read the inputs declared in its input schema.
 *
 * Depends on: @marcbachmann/cel-js, @fibrex/shared/money (Decimal).
 * Used by: ./index.ts -> apps/api kernel/formulas (versions, test, evaluate) and the web
 * admin preview.
 */
import {
  Environment,
  EvaluationError,
  ParseError,
  TypeError as CelTypeError,
  type ASTNode,
  type ParseResult,
} from '@marcbachmann/cel-js';
import {
  FORMULA_INPUT_TYPES as INPUT_TYPES,
  type FormulaInputType as InputType,
  type FormulaReturnType as ReturnType,
} from '@fibrex/shared';
import { Decimal } from '@fibrex/shared/money';

/* ------------------------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------------------------- */

export interface InputField {
  type: InputType;
  description?: string;
  /** Used when the caller does not pass the input. Without a default the input is required. */
  default?: unknown;
}
export type InputSchema = Record<string, InputField>;

/** A result as JSON: decimals and ints are strings (exact), bools and strings as they are. */
export type FormulaValue = string | boolean | FormulaValue[];

export interface TraceStep {
  /** The part of the formula, as the administrator wrote it. */
  expression: string;
  value: FormulaValue;
}

export interface Evaluation {
  value: FormulaValue;
  /** Inputs the formula actually reads, after defaults, as JSON. */
  inputs: Record<string, FormulaValue>;
  /** Present when explain was asked for: every sub-calculation, innermost first. */
  trace?: TraceStep[];
}

export type FormulaErrorCode =
  | 'formula_syntax'
  | 'formula_type'
  | 'formula_not_allowed'
  | 'formula_too_large'
  | 'formula_input'
  | 'formula_runtime'
  | 'formula_limit';

export class FormulaError extends Error {
  readonly code: FormulaErrorCode;
  /** Character offsets in the formula text, when the problem has a place. */
  readonly range: { start: number; end: number } | undefined;

  constructor(code: FormulaErrorCode, message: string, range?: { start: number; end: number }) {
    super(message);
    this.name = 'FormulaError';
    this.code = code;
    this.range = range;
  }
}

export interface EngineLimits {
  maxExpressionLength: number;
  maxAstNodes: number;
  maxDepth: number;
  maxListLength: number;
  maxStringLength: number;
  maxSteps: number;
  timeoutMs: number;
}

export const DEFAULT_LIMITS: EngineLimits = {
  maxExpressionLength: 5000,
  maxAstNodes: 500,
  maxDepth: 32,
  maxListLength: 1000,
  maxStringLength: 1000,
  maxSteps: 100_000,
  timeoutMs: 250,
};

/* ------------------------------------------------------------------------------------------
 * The environment: decimal type, operators and the allowed functions
 * ---------------------------------------------------------------------------------------- */

/** Loop macros: their bodies run once per list element, so they may not be nested. */
const LOOP_MACROS = new Set(['map', 'filter', 'all', 'exists', 'exists_one']);

/**
 * Every function or method a formula may call. Built-ins kept: size, has, int, string, bool
 * conversions and simple string tests. Everything else is the engine's own decimal helpers.
 */
const ALLOWED_CALLS = new Set([
  ...LOOP_MACROS,
  'size',
  'has',
  'int',
  'string',
  'bool',
  'contains',
  'startsWith',
  'endsWith',
  'decimal',
  'round',
  'round_down',
  'floor',
  'ceil',
  'abs',
  'min',
  'max',
  'sum',
  'days_between',
  'days_in_month',
]);

/** Step counter and deadline for the evaluation that is running (evaluation is synchronous). */
interface Budget {
  steps: number;
  maxSteps: number;
  deadline: number;
}
let budget: Budget | undefined;

function step(): void {
  if (budget === undefined) return;
  budget.steps += 1;
  if (budget.steps > budget.maxSteps) {
    throw new FormulaError('formula_limit', 'The formula needs too many steps.');
  }
  if ((budget.steps & 63) === 0 && Date.now() > budget.deadline) {
    throw new FormulaError('formula_limit', 'The formula took too long.');
  }
}

const dec = (value: bigint | Decimal): Decimal =>
  value instanceof Decimal ? value : new Decimal(value.toString());

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function parseDay(text: string): number {
  const time = Date.parse(`${text}T00:00:00Z`);
  if (
    !DATE.test(text) ||
    Number.isNaN(time) ||
    new Date(time).toISOString().slice(0, 10) !== text
  ) {
    throw new FormulaError('formula_runtime', `"${text}" is not a date (YYYY-MM-DD).`);
  }
  return time;
}

function buildEnvironment(): Environment {
  const env = new Environment({
    unlistedVariablesAreDyn: false,
    homogeneousAggregateLiterals: true,
    enableOptionalTypes: false,
    limits: {
      maxAstNodes: DEFAULT_LIMITS.maxAstNodes,
      maxDepth: DEFAULT_LIMITS.maxDepth,
      maxListElements: 100,
      maxMapEntries: 50,
      maxCallArguments: 8,
    },
  }).registerType('decimal', Decimal);

  // Arithmetic. Mixed decimal/int forms exist so `rate * orders` works without conversions.
  const pairs = [
    ['decimal', 'decimal'],
    ['decimal', 'int'],
    ['int', 'decimal'],
  ] as const;
  for (const [l, r] of pairs) {
    env
      .registerOperator(`${l} + ${r}: decimal`, (a: bigint | Decimal, b: bigint | Decimal) => {
        step();
        return dec(a).plus(dec(b));
      })
      .registerOperator(`${l} - ${r}: decimal`, (a: bigint | Decimal, b: bigint | Decimal) => {
        step();
        return dec(a).minus(dec(b));
      })
      .registerOperator(`${l} * ${r}: decimal`, (a: bigint | Decimal, b: bigint | Decimal) => {
        step();
        return dec(a).times(dec(b));
      })
      .registerOperator(`${l} / ${r}: decimal`, (a: bigint | Decimal, b: bigint | Decimal) => {
        step();
        // Business rule: a division by zero is an error to fix in the data, never a silent 0.
        if (dec(b).isZero()) throw new FormulaError('formula_runtime', 'Division by zero.');
        return dec(a).dividedBy(dec(b));
      })
      .registerOperator(`${l} < ${r}`, (a: bigint | Decimal, b: bigint | Decimal) =>
        dec(a).lt(dec(b)),
      )
      .registerOperator(`${l} <= ${r}`, (a: bigint | Decimal, b: bigint | Decimal) =>
        dec(a).lte(dec(b)),
      )
      .registerOperator(`${l} > ${r}`, (a: bigint | Decimal, b: bigint | Decimal) =>
        dec(a).gt(dec(b)),
      )
      .registerOperator(`${l} >= ${r}`, (a: bigint | Decimal, b: bigint | Decimal) =>
        dec(a).gte(dec(b)),
      );
    // Registering == gives != and the mirrored int/decimal form as well.
    if (l === 'decimal') {
      env.registerOperator(`${l} == ${r}`, (a: bigint | Decimal, b: bigint | Decimal) =>
        dec(a).eq(dec(b)),
      );
    }
  }
  env.registerOperator('-decimal: decimal', (a: Decimal) => a.negated());

  // Rounding is always explicit and half-up (the commercial rule, as in @fibrex/shared/money).
  const places = (n: bigint): number => {
    if (n < 0n || n > 10n) throw new FormulaError('formula_runtime', 'Places must be 0 to 10.');
    return Number(n);
  };
  env
    .registerFunction('decimal(string): decimal', (s: string) => {
      step();
      if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) {
        throw new FormulaError('formula_runtime', `"${s.slice(0, 40)}" is not a number.`);
      }
      return new Decimal(s);
    })
    .registerFunction('decimal(int): decimal', (n: bigint) => new Decimal(n.toString()))
    .registerFunction('int(decimal): int', (d: Decimal) => {
      step();
      return BigInt(d.truncated().toFixed(0));
    })
    .registerFunction('string(decimal): string', (d: Decimal) => d.toFixed())
    .registerFunction('round(decimal, int): decimal', (d: Decimal, n: bigint) => {
      step();
      return d.toDecimalPlaces(places(n), Decimal.ROUND_HALF_UP);
    })
    .registerFunction('round(decimal): decimal', (d: Decimal) =>
      d.toDecimalPlaces(0, Decimal.ROUND_HALF_UP),
    )
    .registerFunction('round_down(decimal, int): decimal', (d: Decimal, n: bigint) => {
      step();
      return d.toDecimalPlaces(places(n), Decimal.ROUND_DOWN);
    })
    .registerFunction('floor(decimal): decimal', (d: Decimal) => d.floor())
    .registerFunction('ceil(decimal): decimal', (d: Decimal) => d.ceil())
    .registerFunction('abs(decimal): decimal', (d: Decimal) => d.abs())
    .registerFunction('min(decimal, decimal): decimal', (a: Decimal, b: Decimal) => {
      step();
      return Decimal.min(a, b);
    })
    .registerFunction('max(decimal, decimal): decimal', (a: Decimal, b: Decimal) => {
      step();
      return Decimal.max(a, b);
    })
    .registerFunction('sum(list<decimal>): decimal', (list: Decimal[]) =>
      list.reduce((total: Decimal, d) => {
        step();
        return total.plus(d);
      }, new Decimal(0)),
    )
    .registerFunction('sum(list<int>): int', (list: bigint[]) =>
      list.reduce((total, n) => {
        step();
        return total + n;
      }, 0n),
    )
    .registerFunction('days_between(string, string): int', (from: string, to: string) => {
      step();
      return BigInt(Math.round((parseDay(to) - parseDay(from)) / 86_400_000));
    })
    .registerFunction('days_in_month(string): int', (day: string) => {
      step();
      const d = new Date(parseDay(day));
      return BigInt(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate());
    });
  return env;
}

const BASE = buildEnvironment();

/* ------------------------------------------------------------------------------------------
 * AST helpers
 * ---------------------------------------------------------------------------------------- */

function children(node: ASTNode): ASTNode[] {
  const out: ASTNode[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === 'object' && 'op' in value && 'range' in value) {
      out.push(value as ASTNode);
    }
  };
  if (node.op !== 'value' && node.op !== 'id') visit(node.args);
  return out;
}

function callName(node: ASTNode): string | undefined {
  if (node.op === 'call') return node.args[0];
  if (node.op === 'rcall') return node.args[0];
  return undefined;
}

function wrap(err: unknown, fallback: FormulaErrorCode): FormulaError {
  if (err instanceof FormulaError) return err;
  const cause = err instanceof EvaluationError ? err.cause : undefined;
  if (cause instanceof FormulaError) return cause;
  const message = err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err);
  const range = (err as { range?: { start: number; end: number } } | null)?.range;
  let code = fallback;
  if (err instanceof ParseError)
    code = /limit|exceed|maximum/i.test(message) ? 'formula_too_large' : 'formula_syntax';
  else if (err instanceof CelTypeError) code = 'formula_type';
  else if (err instanceof EvaluationError) code = 'formula_runtime';
  return new FormulaError(code, message, range);
}

/**
 * Step 1 of the sandbox: rewrite every float literal to an exact decimal. The literal's own
 * source text is used, so `0.1` becomes exactly 0.1 and never 0.1000000000000000055...
 */
function rewriteFloats(expression: string): string {
  let ast: ASTNode;
  try {
    ast = BASE.parse(expression).ast;
  } catch (err) {
    throw wrap(err, 'formula_syntax');
  }
  const floats: { start: number; end: number }[] = [];
  const walk = (node: ASTNode): void => {
    if (node.op === 'value' && typeof node.args === 'number') floats.push(node.range);
    children(node).forEach(walk);
  };
  walk(ast);
  let out = expression;
  for (const r of floats.sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, r.start)}decimal("${expression.slice(r.start, r.end)}")${out.slice(r.end)}`;
  }
  return out;
}

/** Steps 2 and 3 of the sandbox: only allowed calls, no nested loops, no floats left. */
function checkStructure(ast: ASTNode): void {
  const walk = (node: ASTNode, inLoop: boolean): void => {
    const name = callName(node);
    if (name !== undefined) {
      if (!ALLOWED_CALLS.has(name)) {
        throw new FormulaError(
          'formula_not_allowed',
          `"${name}" is not allowed in a formula.`,
          node.range,
        );
      }
      if (LOOP_MACROS.has(name)) {
        if (inLoop) {
          throw new FormulaError(
            'formula_not_allowed',
            'Loops (map, filter, all, exists) cannot be placed inside each other.',
            node.range,
          );
        }
        children(node).forEach((child, i) => {
          walk(child, i > 0); // child 0 is the list itself; the rest run per element
        });
        return;
      }
    }
    if (node.op === 'value' && typeof node.args === 'number') {
      throw new FormulaError(
        'formula_not_allowed',
        'Floating-point numbers are not allowed.',
        node.range,
      );
    }
    children(node).forEach((child) => {
      walk(child, inLoop);
    });
  };
  walk(ast, false);
}

/* ------------------------------------------------------------------------------------------
 * Inputs
 * ---------------------------------------------------------------------------------------- */

const celType = (type: InputType): string => (type === 'date' ? 'string' : type);

function convertScalar(name: string, type: InputType, raw: unknown, limits: EngineLimits): unknown {
  const fail = (what: string) =>
    new FormulaError('formula_input', `Input "${name}" must be ${what}.`);
  switch (type) {
    case 'decimal':
    case 'list<decimal>':
      if (typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw)) return new Decimal(raw);
      // A JSON number is taken by its shortest decimal text (what the sender wrote).
      if (typeof raw === 'number' && Number.isFinite(raw)) return new Decimal(String(raw));
      throw fail('a decimal number (for example "12.50")');
    case 'int':
    case 'list<int>':
      if (typeof raw === 'number' && Number.isSafeInteger(raw)) return BigInt(raw);
      if (typeof raw === 'string' && /^-?\d{1,18}$/.test(raw)) return BigInt(raw);
      throw fail('a whole number');
    case 'bool':
      if (typeof raw === 'boolean') return raw;
      throw fail('true or false');
    case 'date':
      if (typeof raw === 'string' && DATE.test(raw)) {
        parseDay(raw);
        return raw;
      }
      throw fail('a date (YYYY-MM-DD)');
    case 'string':
    case 'list<string>':
      if (typeof raw === 'string' && raw.length <= limits.maxStringLength) return raw;
      throw fail(`text of at most ${String(limits.maxStringLength)} characters`);
  }
}

function convertInputs(
  schema: InputSchema,
  given: Record<string, unknown>,
  limits: EngineLimits,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(schema)) {
    const raw = Object.hasOwn(given, name) ? given[name] : field.default;
    if (raw === undefined || raw === null) {
      throw new FormulaError('formula_input', `Input "${name}" is missing.`);
    }
    if (field.type.startsWith('list<')) {
      if (!Array.isArray(raw) || raw.length > limits.maxListLength) {
        throw new FormulaError(
          'formula_input',
          `Input "${name}" must be a list of at most ${String(limits.maxListLength)} items.`,
        );
      }
      out[name] = raw.map((item) => convertScalar(name, field.type, item, limits));
    } else {
      out[name] = convertScalar(name, field.type, raw, limits);
    }
  }
  return out;
}

/** Values back to JSON: exact strings for numbers, so nothing passes through a float. */
export function toJson(value: unknown): FormulaValue {
  if (value instanceof Decimal) return value.toFixed();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(toJson);
  throw new FormulaError('formula_type', 'The formula produced a value of an unsupported type.');
}

/* ------------------------------------------------------------------------------------------
 * Compile and evaluate
 * ---------------------------------------------------------------------------------------- */

export interface CompiledFormula {
  readonly expression: string;
  readonly returnType: ReturnType;
  /** Names of the inputs the formula reads. */
  readonly references: string[];
  evaluate(inputs: Record<string, unknown>, options?: { explain?: boolean }): Evaluation;
}

function environmentFor(schema: InputSchema): Environment {
  const env = BASE.clone();
  for (const [name, field] of Object.entries(schema)) {
    env.registerVariable(name, celType(field.type));
  }
  return env;
}

const NAME = /^[a-z][a-z0-9_]{0,59}$/;

/**
 * Check and prepare a formula. Throws FormulaError with the place of the problem when the
 * text does not parse, uses something not allowed, reads an undeclared name, or does not
 * produce `returnType`.
 */
export function compileFormula(
  expression: string,
  schema: InputSchema,
  returnType: ReturnType,
  limits: EngineLimits = DEFAULT_LIMITS,
): CompiledFormula {
  if (expression.trim().length === 0)
    throw new FormulaError('formula_syntax', 'The formula is empty.');
  if (expression.length > limits.maxExpressionLength) {
    throw new FormulaError(
      'formula_too_large',
      `A formula may have at most ${String(limits.maxExpressionLength)} characters.`,
    );
  }
  for (const [name, field] of Object.entries(schema)) {
    if (!NAME.test(name) || ['decimal', 'int', 'string', 'bool', 'cel'].includes(name)) {
      throw new FormulaError('formula_input', `"${name}" cannot be used as an input name.`);
    }
    if (!(INPUT_TYPES as readonly string[]).includes(field.type)) {
      throw new FormulaError('formula_input', `Input "${name}" has an unknown type.`);
    }
  }
  const env = environmentFor(schema);
  const source = rewriteFloats(expression);
  let program: ParseResult;
  try {
    program = env.parse(source);
  } catch (err) {
    throw wrap(err, 'formula_syntax');
  }
  checkStructure(program.ast);
  const checked = program.check();
  if (!checked.valid) throw wrap(checked.error, 'formula_type');
  // An int result is accepted where a decimal is wanted (it is converted exactly).
  const produced = checked.type ?? 'dyn';
  if (produced !== returnType && !(returnType === 'decimal' && produced === 'int')) {
    throw new FormulaError(
      'formula_type',
      `The formula gives ${produced} but ${returnType} is expected.`,
    );
  }

  const references = Object.keys(schema).filter((name) =>
    identifiers(BASE.parse(expression).ast).has(name),
  );

  const run = (text: string, context: Record<string, unknown>): unknown => {
    budget = {
      steps: 0,
      maxSteps: limits.maxSteps,
      deadline: Date.now() + limits.timeoutMs,
    };
    const started = Date.now();
    try {
      const value: unknown = env.evaluate(text, context);
      if (Date.now() - started > limits.timeoutMs) {
        throw new FormulaError('formula_limit', 'The formula took too long.');
      }
      return value;
    } catch (err) {
      throw wrap(err, 'formula_runtime');
    } finally {
      budget = undefined;
    }
  };

  return {
    expression,
    returnType,
    references,
    evaluate(given, options) {
      const context = convertInputs(schema, given, limits);
      let value = run(source, context);
      if (returnType === 'decimal' && typeof value === 'bigint')
        value = new Decimal(value.toString());
      const result: Evaluation = {
        value: toJson(value),
        inputs: Object.fromEntries(references.map((name) => [name, toJson(context[name])])),
      };
      if (options?.explain === true) result.trace = explain(expression, context, run);
      return result;
    },
  };
}

function identifiers(ast: ASTNode): Set<string> {
  const names = new Set<string>();
  const walk = (node: ASTNode): void => {
    if (node.op === 'id') names.add(node.args);
    children(node).forEach(walk);
  };
  walk(ast);
  return names;
}

/**
 * "How was this calculated": evaluate every sub-expression (innermost first) and list its
 * value. Literals and plain input names are skipped (inputs are listed separately), loop
 * bodies are shown as the whole loop, and only the branch of `a ? b : c` (and the side of
 * `&&` / `||`) that was really evaluated is explained, as the engine itself would.
 */
function explain(
  expression: string,
  context: Record<string, unknown>,
  run: (text: string, context: Record<string, unknown>) => unknown,
): TraceStep[] {
  const steps: TraceStep[] = [];
  const seen = new Set<string>();
  const valueOf = (node: ASTNode): unknown => {
    const text = expression.slice(node.range.start, node.range.end);
    return run(rewriteFloats(text), context);
  };
  const record = (node: ASTNode, value: unknown): void => {
    const text = expression.slice(node.range.start, node.range.end).trim();
    if (seen.has(text)) return;
    seen.add(text);
    steps.push({ expression: text, value: toJson(value) });
  };
  const walk = (node: ASTNode): void => {
    if (node.op === 'value' || node.op === 'id') return;
    const name = callName(node);
    if (name === 'decimal' && node.op === 'call') return; // a literal in another spelling
    if (node.op === '?:') {
      const [cond, yes, no] = node.args;
      walk(cond);
      walk(valueOf(cond) === true ? yes : no);
    } else if (node.op === '&&' || node.op === '||') {
      const [left, right] = node.args;
      walk(left);
      const l = valueOf(left);
      if ((node.op === '&&' && l === true) || (node.op === '||' && l === false)) walk(right);
    } else if (name !== undefined && LOOP_MACROS.has(name)) {
      const receiver = children(node)[0];
      if (receiver !== undefined) walk(receiver);
    } else {
      children(node).forEach(walk);
    }
    record(node, valueOf(node));
  };
  walk(BASE.parse(expression).ast);
  return steps;
}

/* ------------------------------------------------------------------------------------------
 * Test cases
 * ---------------------------------------------------------------------------------------- */

export interface TestCase {
  name: string;
  inputs: Record<string, unknown>;
  /** The expected result: a decimal or int as text, true/false, or text. */
  expected: string | boolean;
}

export interface TestCaseResult {
  name: string;
  passed: boolean;
  expected: string | boolean;
  actual?: FormulaValue;
  error?: { code: FormulaErrorCode; message: string };
}

/** Decimals are compared by value, so "150" passes for 150.00. */
export function sameValue(
  returnType: ReturnType,
  expected: string | boolean,
  actual: FormulaValue,
): boolean {
  if (
    (returnType === 'decimal' || returnType === 'int') &&
    typeof expected === 'string' &&
    typeof actual === 'string'
  ) {
    try {
      return new Decimal(expected).eq(new Decimal(actual));
    } catch {
      return false;
    }
  }
  return expected === actual;
}

export function runTestCases(formula: CompiledFormula, cases: TestCase[]): TestCaseResult[] {
  return cases.map((testCase) => {
    try {
      const { value } = formula.evaluate(testCase.inputs);
      return {
        name: testCase.name,
        passed: sameValue(formula.returnType, testCase.expected, value),
        expected: testCase.expected,
        actual: value,
      };
    } catch (err) {
      const error = wrap(err, 'formula_runtime');
      return {
        name: testCase.name,
        passed: false,
        expected: testCase.expected,
        error: { code: error.code, message: error.message },
      };
    }
  });
}
