import { describe, expect, it } from 'vitest';
import { labelsProblem, lookupCodePattern, lookupKeyPattern, lookupLabel } from './index.js';

describe('lookupLabel', () => {
  it('prefers the wanted language, then English, then any label, then the code', () => {
    expect(lookupLabel({ en: 'Motorbike', bn: 'মোটরবাইক' }, 'bn', 'motorbike')).toBe('মোটরবাইক');
    expect(lookupLabel({ en: 'Motorbike' }, 'ur', 'motorbike')).toBe('Motorbike');
    expect(lookupLabel({ hi: 'बाइक' }, 'ur', 'motorbike')).toBe('बाइक');
    expect(lookupLabel({}, 'en', 'motorbike')).toBe('motorbike');
  });
  it('treats blank labels as missing', () => {
    expect(lookupLabel({ en: 'Car', bn: '  ' }, 'bn', 'car')).toBe('Car');
  });
});

describe('labelsProblem and patterns', () => {
  it('requires an English label', () => {
    expect(labelsProblem({ en: 'Car' })).toBeNull();
    expect(labelsProblem({ bn: 'x' })).not.toBeNull();
    expect(labelsProblem({ en: ' ' })).not.toBeNull();
  });
  it('checks keys and codes', () => {
    expect(lookupKeyPattern.test('vehicle_type')).toBe(true);
    expect(lookupKeyPattern.test('Vehicle')).toBe(false);
    expect(lookupCodePattern.test('bank_transfer')).toBe(true);
    expect(lookupCodePattern.test('_x')).toBe(false);
  });
});

describe('lookup forms', () => {
  it('turns the label boxes into labels and drops blanks', async () => {
    const { labelsFromForm, lookupValueFormSchema } = await import('./index.js');
    const form = lookupValueFormSchema.parse({ code: 'car', labelEn: 'Car', labelBn: 'গাড়ি' });
    expect(labelsFromForm(form)).toEqual({ en: 'Car', bn: 'গাড়ি' });
    expect(form.sortOrder).toBe(0);
    expect(form.active).toBe(true);
    expect(lookupValueFormSchema.safeParse({ code: 'car', labelEn: ' ' }).success).toBe(false);
  });
});
