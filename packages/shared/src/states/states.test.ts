// Tests for the state-machine schemas and the checks of a move (phase 2 row 2.10).
import { describe, expect, it } from 'vitest';
import {
  checkTransition,
  missingRequiredFields,
  stateFormSchema,
  stateTransitionFormSchema,
  transitionRequestSchema,
} from './index.js';

const codes = (issues: { path: string; code: string }[]) =>
  issues.map((i) => `${i.path}:${i.code}`);
const plain = { requiredFields: [], reasonRequired: false, hasReasonList: false };
const facts = { data: {}, today: '2026-11-16' };

describe('state schemas', () => {
  it('a state needs an English label and cannot be first and final', () => {
    const base = { code: 'draft', category: 'open', isInitial: true, isFinal: false };
    expect(stateFormSchema.safeParse({ ...base, labels: { en: 'Draft' } }).success).toBe(true);
    expect(stateFormSchema.safeParse({ ...base, labels: { bn: 'x' } }).success).toBe(false);
    expect(
      stateFormSchema.safeParse({ ...base, labels: { en: 'Draft' }, isFinal: true }).success,
    ).toBe(false);
    expect(stateFormSchema.safeParse({ ...base, code: 'Draft', labels: { en: 'D' } }).success).toBe(
      false,
    );
    const coloured = stateFormSchema.parse({ ...base, labels: { en: 'D' }, colour: '#1F7A4D' });
    expect(coloured.colour).toBe('#1f7a4d');
  });

  it('a transition goes to a different state and lists each field once', () => {
    const base = {
      fromCode: 'draft',
      toCode: 'approved',
      requiredFields: [],
      reasonRequired: false,
    };
    expect(stateTransitionFormSchema.safeParse(base).success).toBe(true);
    expect(stateTransitionFormSchema.safeParse({ ...base, toCode: 'draft' }).success).toBe(false);
    expect(
      stateTransitionFormSchema.safeParse({ ...base, requiredFields: ['a', 'a'] }).success,
    ).toBe(false);
    expect(
      stateTransitionFormSchema.safeParse({ ...base, permissionKey: 'not a key' }).success,
    ).toBe(false);
  });

  it('a move request takes no unknown properties', () => {
    expect(transitionRequestSchema.safeParse({ toCode: 'approved' }).success).toBe(true);
    expect(transitionRequestSchema.safeParse({ toCode: 'approved', state: 'x' }).success).toBe(
      false,
    );
    expect(
      transitionRequestSchema.safeParse({ toCode: 'approved', effectiveDate: '16/11/2026' })
        .success,
    ).toBe(false);
  });
});

describe('checks of a move', () => {
  it('lists the required fields that are empty', () => {
    expect(missingRequiredFields(['a', 'b', 'c', 'd'], { a: 'x', b: '', c: null, d: 0 })).toEqual([
      'b',
      'c',
    ]);
    const rule = { ...plain, requiredFields: ['plate', 'seats'] };
    expect(codes(checkTransition(rule, {}, { ...facts, data: { seats: 4 } }))).toEqual([
      'data.plate:required_for_transition',
    ]);
  });

  it('needs a listed reason when there is a list, otherwise a note', () => {
    const listed = { ...plain, reasonRequired: true, hasReasonList: true };
    expect(codes(checkTransition(listed, { note: 'because' }, facts))).toEqual([
      'reasonId:reason_required',
    ]);
    expect(
      checkTransition(listed, { reasonId: '018f0000-0000-7000-8000-000000000001' }, facts),
    ).toEqual([]);
    const written = { ...plain, reasonRequired: true };
    expect(codes(checkTransition(written, {}, facts))).toEqual(['note:reason_required']);
    expect(checkTransition(written, { note: 'because' }, facts)).toEqual([]);
    // Not required: nothing is asked for.
    expect(checkTransition(plain, {}, facts)).toEqual([]);
  });

  it('keeps the effective date between the previous move and today', () => {
    const last = { ...facts, lastEffectiveDate: '2026-11-10' };
    expect(checkTransition(plain, { effectiveDate: '2026-11-10' }, last)).toEqual([]);
    expect(checkTransition(plain, { effectiveDate: '2026-11-16' }, last)).toEqual([]);
    expect(codes(checkTransition(plain, { effectiveDate: '2026-11-17' }, last))).toEqual([
      'effectiveDate:effective_date_future',
    ]);
    expect(codes(checkTransition(plain, { effectiveDate: '2026-11-09' }, last))).toEqual([
      'effectiveDate:effective_date_before_previous',
    ]);
    // No date given means today.
    expect(checkTransition(plain, {}, { ...facts, lastEffectiveDate: '2026-11-16' })).toEqual([]);
  });
});
