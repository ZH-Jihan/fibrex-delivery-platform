/**
 * Public entry point of @fibrex/formula: the sandboxed CEL engine with decimal arithmetic.
 *
 * Depends on: ./engine. Used by: apps/api kernel/formulas (and the web admin preview later).
 */
export {
  compileFormula,
  DEFAULT_LIMITS,
  FormulaError,
  runTestCases,
  sameValue,
  toJson,
  type CompiledFormula,
  type EngineLimits,
  type EvaluateOptions,
  type Evaluation,
  type RateHit,
  type RateLookup,
  type RateUse,
  type FormulaErrorCode,
  type FormulaValue,
  type InputField,
  type InputSchema,
  type TestCase,
  type TestCaseResult,
  type TraceStep,
} from './engine.js';
