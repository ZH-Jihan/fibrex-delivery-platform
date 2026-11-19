import { describe, expect, it } from 'vitest';
import { bulkUploadCreateSchema, suggestPartyId } from './bulk-upload.js';

const people = [
  { id: 'a', names: ['Rahim Uddin'] },
  { id: 'b', names: ['Karim Hossain'] },
  { id: 'c', names: ['Karim Hossain Ali'] },
];

describe('suggestPartyId', () => {
  it('suggests the one person whose name matches, in any word order', () => {
    expect(suggestPartyId('UDDIN RAHIM', people)).toBe('a');
  });
  it('suggests nobody when two people match', () => {
    expect(suggestPartyId('Karim Hossain', people)).toBeNull();
  });
  it('suggests nobody for no match, no name or a blank name', () => {
    expect(suggestPartyId('Someone Else', people)).toBeNull();
    expect(suggestPartyId(null, people)).toBeNull();
    expect(suggestPartyId('  ', people)).toBeNull();
  });
});

describe('bulkUploadCreateSchema', () => {
  const id = '0192f0a0-0000-7000-8000-000000000001';
  it('accepts one to fifty distinct files', () => {
    expect(bulkUploadCreateSchema.safeParse({ fileObjectIds: [id] }).success).toBe(true);
  });
  it('refuses none, repeats and too many', () => {
    expect(bulkUploadCreateSchema.safeParse({ fileObjectIds: [] }).success).toBe(false);
    expect(bulkUploadCreateSchema.safeParse({ fileObjectIds: [id, id] }).success).toBe(false);
  });
});
