import { describe, expect, it } from 'vitest';
import {
  normaliseHeader,
  sheetColumnMappingSchema,
  SNOONU_DEFAULT_MAPPING,
} from './column-mapping.js';

describe('sheet column mapping', () => {
  it('the Snoonu default maps the match key and the two core metrics as required', () => {
    expect(SNOONU_DEFAULT_MAPPING.fields.public_id?.required).toBe(true);
    expect(SNOONU_DEFAULT_MAPPING.metrics.delivered?.required).toBe(true);
    expect(SNOONU_DEFAULT_MAPPING.metrics.working_hours?.required).toBe(true);
    expect(SNOONU_DEFAULT_MAPPING.fields.break_start).toMatchObject({ column: 'F', type: 'time' });
  });

  it('refuses a mapping without Public ID, data above the headers or bad keys', () => {
    const fields = { ...SNOONU_DEFAULT_MAPPING.fields };
    delete fields.public_id;
    expect(sheetColumnMappingSchema.safeParse({ ...SNOONU_DEFAULT_MAPPING, fields }).success).toBe(
      false,
    );
    expect(
      sheetColumnMappingSchema.safeParse({ ...SNOONU_DEFAULT_MAPPING, firstDataRow: 3 }).success,
    ).toBe(false);
    expect(
      sheetColumnMappingSchema.safeParse({
        ...SNOONU_DEFAULT_MAPPING,
        metrics: { 'Bad Key': { aliases: ['x'] } },
      }).success,
    ).toBe(false);
  });

  it('compares headers without case, spaces or punctuation', () => {
    expect(normaliseHeader('  Late Log-In  By Min ')).toBe('late log in by min');
    expect(normaliseHeader('Driver / Rider')).toBe(normaliseHeader('driver rider'));
    expect(normaliseHeader('1st of the month')).toBe('1st of the month');
  });
});
