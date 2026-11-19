// Tests for the OCR flag rules (phase 3 row 3.6): name match, confidence, expiry, quality.
import { describe, expect, it } from 'vitest';
import { deriveOcrFlags, namesMatch, ocrJobCreateSchema } from './ocr.js';

const today = '2026-11-19';
const good = { value: 'x', confidence: 0.95 };

describe('namesMatch', () => {
  it('ignores case, order, accents and punctuation', () => {
    expect(namesMatch('RAHIM, Abdul', 'Abdul Rahim')).toBe(true);
    expect(namesMatch('José Pérez', 'JOSE PEREZ')).toBe(true);
  });

  it('accepts an extra middle name but not a different person', () => {
    expect(namesMatch('Abdul Karim Rahim', 'Abdul Rahim')).toBe(true);
    expect(namesMatch('Karim Example', 'Rahim Example')).toBe(false);
    expect(namesMatch('', 'Rahim')).toBe(false);
  });
});

describe('deriveOcrFlags', () => {
  const base = { quality: [] as const, expectedNames: ['Rahim Example'], today, duplicate: false };

  it('gives no flag to a clean, matching, valid read', () => {
    const flags = deriveOcrFlags({
      ...base,
      fields: {
        number: good,
        holderName: { value: 'EXAMPLE RAHIM', confidence: 0.9 },
        expiryDate: { value: '2027-01-01', confidence: 0.9 },
      },
    });
    expect(flags).toEqual([]);
  });

  it('flags low confidence, name mismatch, expired and duplicate', () => {
    const flags = deriveOcrFlags({
      ...base,
      duplicate: true,
      fields: {
        number: { value: '123', confidence: 0.4 },
        holderName: { value: 'Someone Else', confidence: 0.9 },
        expiryDate: { value: '2026-11-18', confidence: 0.9 },
      },
    });
    expect(flags).toEqual(['low_confidence', 'name_mismatch', 'expired', 'duplicate']);
  });

  it('ignores the confidence of an empty field and skips the name check without names', () => {
    const flags = deriveOcrFlags({
      ...base,
      expectedNames: [],
      fields: {
        number: good,
        issueDate: { value: null, confidence: 0 },
        holderName: { value: 'Someone Else', confidence: 0.9 },
      },
    });
    expect(flags).toEqual([]);
  });

  it('marks a read with no usable field, or a bad scan, as unreadable or cropped', () => {
    expect(deriveOcrFlags({ ...base, fields: {} })).toEqual(['unreadable']);
    expect(deriveOcrFlags({ ...base, quality: ['cropped'], fields: { number: good } })).toEqual([
      'cropped',
    ]);
  });
});

describe('ocrJobCreateSchema', () => {
  it('needs a file and refuses unknown keys', () => {
    expect(ocrJobCreateSchema.safeParse({}).success).toBe(false);
    const fileObjectId = '0b8f0c8e-5f3a-4d6e-9c1a-2f7d8e9a0b1c';
    expect(ocrJobCreateSchema.safeParse({ fileObjectId }).success).toBe(true);
    expect(ocrJobCreateSchema.safeParse({ fileObjectId, number: '1' }).success).toBe(false);
  });
});
