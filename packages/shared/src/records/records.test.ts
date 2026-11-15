import { describe, expect, it } from 'vitest';
import { buildJsonSchema, type FieldSpec } from '../entities/index.js';
import {
  buildDataFilter,
  mergeRecordData,
  recordCreateSchema,
  recordLinkCreateSchema,
  recordUpdateSchema,
} from './index.js';

const field = (
  key: string,
  type: FieldSpec['type'],
  extra: Partial<FieldSpec> = {},
): FieldSpec => ({
  key,
  label: { en: key },
  type,
  validations: {},
  required: false,
  sortOrder: 0,
  status: 'published',
  ...extra,
});

const schema = buildJsonSchema([
  field('colour', 'text'),
  field('seats', 'number'),
  field('passed', 'boolean'),
  field('tags', 'multi', { lookupKey: 'tag' }),
  field('fee', 'decimal'),
]);

describe('mergeRecordData', () => {
  it('replaces the sent fields and keeps the others', () => {
    expect(mergeRecordData({ a: 1, b: 'x' }, { b: 'y', c: true })).toEqual({
      a: 1,
      b: 'y',
      c: true,
    });
  });

  it('removes a field sent as not filled in', () => {
    expect(mergeRecordData({ a: 1, b: 'x', c: ['k'] }, { a: null, b: '', c: [] })).toEqual({});
  });
});

describe('buildDataFilter', () => {
  it('builds one containment object with a value of the right kind per field', () => {
    expect(
      buildDataFilter(schema, {
        colour: 'red',
        seats: '4',
        passed: 'false',
        tags: 'urgent',
        fee: '12.50',
      }),
    ).toEqual({
      ok: true,
      contains: { colour: 'red', seats: 4, passed: false, tags: ['urgent'], fee: '12.50' },
    });
  });

  it('reports an unknown field instead of ignoring the filter', () => {
    const result = buildDataFilter(schema, { nope: 'x' });
    expect(result).toEqual({
      ok: false,
      issues: [{ path: 'f.nope', code: 'unknown_field', message: 'This field does not exist.' }],
    });
  });

  it('does not treat an inherited property name as a field', () => {
    expect(buildDataFilter(schema, { constructor: 'x' }).ok).toBe(false);
  });

  it('refuses values of the wrong kind, empty values and repeated parameters', () => {
    const result = buildDataFilter(schema, {
      seats: '4.5',
      passed: 'yes',
      colour: '',
      fee: ['1', '2'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.path).sort()).toEqual([
        'f.colour',
        'f.fee',
        'f.passed',
        'f.seats',
      ]);
    }
  });
});

describe('record bodies', () => {
  it('refuses unknown properties and a hand-typed number', () => {
    expect(recordCreateSchema.safeParse({ data: {}, number: 'X1' }).success).toBe(false);
    expect(recordUpdateSchema.safeParse({ number: 'X1' }).success).toBe(false);
    expect(recordUpdateSchema.safeParse({ companyId: crypto.randomUUID() }).success).toBe(false);
  });

  it('accepts a link to a custom or a built-in record type only', () => {
    const toId = crypto.randomUUID();
    const link = (toEntityType: string) =>
      recordLinkCreateSchema.safeParse({ relationKey: 'about', toEntityType, toId }).success;
    expect(link('vehicle')).toBe(true);
    expect(link('party.party')).toBe(true);
    expect(link('Party')).toBe(false);
    expect(link('a.b.c')).toBe(false);
  });
});
