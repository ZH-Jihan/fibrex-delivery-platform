import { describe, expect, it } from 'vitest';
import {
  buildJsonSchema,
  entityKeyPattern,
  layoutProblems,
  layoutSchema,
  listConfigSchema,
  parseFieldValidations,
  textPatternProblem,
  stripAbsent,
  systemEntityKeyPattern,
  validateRecordData,
  type FieldSpec,
} from './index.js';

const field = (over: Partial<FieldSpec> & Pick<FieldSpec, 'key' | 'type'>): FieldSpec => ({
  label: { en: over.key },
  validations: {},
  required: false,
  sortOrder: 0,
  status: 'published',
  ...over,
});

const FIELDS: FieldSpec[] = [
  field({
    key: 'plate',
    type: 'text',
    required: true,
    sortOrder: 1,
    validations: { maxLength: 8, pattern: '^[A-Z0-9]+$' },
  }),
  field({ key: 'odometer', type: 'number', sortOrder: 2, validations: { min: 0, max: 999999 } }),
  field({
    key: 'cost',
    type: 'decimal',
    sortOrder: 3,
    validations: { min: '0', max: '5000.00', scale: 2 },
  }),
  field({ key: 'inspected_on', type: 'date', sortOrder: 4, validations: { min: '2026-01-01' } }),
  field({ key: 'result', type: 'dropdown', sortOrder: 5, lookupKey: 'inspection_result' }),
  field({
    key: 'faults',
    type: 'multi',
    sortOrder: 6,
    lookupKey: 'fault',
    validations: { maxItems: 2 },
  }),
  field({ key: 'passed', type: 'boolean', sortOrder: 7 }),
  field({ key: 'inspector', type: 'party_ref', sortOrder: 8 }),
  field({ key: 'old_note', type: 'text', sortOrder: 9, required: true, status: 'retired' }),
];
const schema = buildJsonSchema(FIELDS);
const ID = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('keys', () => {
  it('tells custom keys from built-in ones', () => {
    expect(entityKeyPattern.test('vehicle_inspection')).toBe(true);
    expect(entityKeyPattern.test('party.party')).toBe(false);
    expect(systemEntityKeyPattern.test('party.party')).toBe(true);
    expect(systemEntityKeyPattern.test('Party.party')).toBe(false);
  });
});

describe('parseFieldValidations', () => {
  it('accepts what a type allows and refuses the rest', () => {
    expect(parseFieldValidations('text', { minLength: 2, maxLength: 10 }).ok).toBe(true);
    expect(parseFieldValidations('text', { minLength: 10, maxLength: 2 }).ok).toBe(false);
    expect(parseFieldValidations('text', { min: 1 }).ok).toBe(false);
    expect(parseFieldValidations('decimal', { min: '10.5', max: '9' }).ok).toBe(false);
    expect(parseFieldValidations('decimal', { min: 10 }).ok).toBe(false);
    expect(parseFieldValidations('date', { min: '2026-02-30' }).ok).toBe(false);
    expect(parseFieldValidations('boolean', { anything: 1 }).ok).toBe(false);
    expect(parseFieldValidations('boolean', undefined)).toEqual({ ok: true, value: {} });
  });

  it('refuses patterns that could run away', () => {
    expect(textPatternProblem('^[A-Z]{3}-\\d{4}$')).toBeNull();
    expect(textPatternProblem('(a+)+$')).not.toBeNull();
    expect(textPatternProblem('(a)\\1')).not.toBeNull();
    expect(textPatternProblem('[')).not.toBeNull();
    expect(parseFieldValidations('text', { pattern: '(x*)*' }).ok).toBe(false);
  });
});

describe('buildJsonSchema', () => {
  it('orders properties, requires only fields in use, refuses unknown properties', () => {
    expect(Object.keys(schema.properties)[0]).toBe('plate');
    expect(schema.required).toEqual(['plate']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.old_note?.['x-retired']).toBe(true);
  });

  it('maps each type', () => {
    expect(schema.properties.plate).toMatchObject({ type: 'string', maxLength: 8 });
    expect(schema.properties.odometer).toMatchObject({ type: 'integer', minimum: 0 });
    expect(schema.properties.cost).toMatchObject({
      type: 'string',
      pattern: '^-?\\d{1,14}(\\.\\d{1,2})?$',
      'x-decimal': { scale: 2, min: '0', max: '5000.00' },
    });
    expect(schema.properties.inspected_on).toMatchObject({
      format: 'date',
      formatMinimum: '2026-01-01',
    });
    expect(schema.properties.result).toMatchObject({
      type: 'string',
      'x-lookup': 'inspection_result',
    });
    expect(schema.properties.faults).toMatchObject({
      type: 'array',
      uniqueItems: true,
      maxItems: 2,
    });
    expect(schema.properties.inspector).toMatchObject({ format: 'uuid', 'x-ref': 'party' });
    expect(buildJsonSchema([field({ key: 'note', type: 'text' })]).properties.note?.maxLength).toBe(
      4000,
    );
  });
});

describe('validateRecordData', () => {
  const codes = (data: unknown) =>
    validateRecordData(schema, data).map((i) => `${i.path}:${i.code}`);

  it('accepts valid data', () => {
    expect(
      codes({
        plate: 'AB1234',
        odometer: 1200,
        cost: '250.50',
        inspected_on: '2026-03-01',
        result: 'pass',
        faults: ['brakes'],
        passed: true,
        inspector: ID,
        old_note: 'kept from before',
      }),
    ).toEqual([]);
  });

  it('treats null, empty text and an empty list as not filled in', () => {
    expect(codes({ plate: '' })).toEqual(['plate:required']);
    expect(codes({ plate: null })).toEqual(['plate:required']);
    expect(codes({ plate: 'A1', faults: [], cost: null })).toEqual([]);
    expect(stripAbsent({ plate: 'A1', faults: [], cost: null, passed: false })).toEqual({
      plate: 'A1',
      passed: false,
    });
  });

  it('reports every problem at once', () => {
    expect(
      codes({
        plate: 'ab-123456',
        odometer: 1.5,
        cost: '5000.01',
        inspected_on: '2025-12-31',
        faults: ['a', 'a'],
        passed: 'yes',
        inspector: 'someone',
        colour: 'red',
      }),
    ).toEqual([
      'colour:unknown_field',
      'plate:max_length',
      'odometer:type',
      'cost:maximum',
      'inspected_on:minimum',
      'faults:unique',
      'passed:type',
      'inspector:format',
    ]);
  });

  it('checks decimals exactly and as text', () => {
    expect(codes({ plate: 'A1', cost: '5000.00' })).toEqual([]);
    expect(codes({ plate: 'A1', cost: '12.345' })).toEqual(['cost:pattern']);
    expect(codes({ plate: 'A1', cost: 12.5 })).toEqual(['cost:type']);
    expect(codes({ plate: 'A1', cost: '-0.01' })).toEqual(['cost:minimum']);
  });

  it('refuses data that is not an object', () => {
    expect(codes([])).toEqual([':type']);
    expect(codes(null)).toEqual([':type']);
  });
});

describe('layouts', () => {
  it('accepts empty layouts and finds unknown or repeated fields', () => {
    const empty = {
      listConfig: listConfigSchema.parse({}),
      formLayout: layoutSchema.parse({}),
      detailLayout: layoutSchema.parse({}),
    };
    expect(layoutProblems(empty, ['plate'])).toEqual([]);
    const problems = layoutProblems(
      {
        listConfig: listConfigSchema.parse({
          columns: ['number', 'plate', 'gone'],
          sort: { field: 'nothing', direction: 'asc' },
        }),
        formLayout: layoutSchema.parse({
          sections: [{ title: { bn: 'x' }, fields: ['plate', 'plate', 'missing'] }],
        }),
        detailLayout: layoutSchema.parse({}),
      },
      ['plate'],
    );
    expect(problems.map((p) => `${p.path}:${p.code}`)).toEqual([
      'listConfig.columns:unknown_field',
      'listConfig.sort:unknown_field',
      'formLayout:english_label_required',
      'formLayout:duplicate_field',
      'formLayout:unknown_field',
    ]);
  });
});
