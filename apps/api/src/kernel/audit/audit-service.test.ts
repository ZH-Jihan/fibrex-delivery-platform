import { describe, expect, it } from 'vitest';
import { validateDbContext } from '../db/unit-of-work.js';
import { csvCell } from './audit-service.js';

describe('csvCell', () => {
  it('quotes text and doubles quotes', () => {
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvCell('say "hi", twice')).toBe('"say ""hi"", twice"');
  });

  it('writes nothing for null and undefined', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('writes objects and arrays as JSON', () => {
    expect(csvCell({ name: { old: 'a', new: 'b' } })).toBe(
      '"{""name"":{""old"":""a"",""new"":""b""}}"',
    );
    expect(csvCell(['admin'])).toBe('"[""admin""]"');
    expect(csvCell(12)).toBe('"12"');
  });

  it('defuses values a spreadsheet would run as a formula', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell('+1')).toBe('"\'+1"');
    expect(csvCell('-1')).toBe('"\'-1"');
    expect(csvCell('@cmd')).toBe('"\'@cmd"');
  });
});

describe('validateDbContext role keys', () => {
  const tenantId = '018f0000-0000-7000-8000-000000000001';

  it('accepts ordinary role keys', () => {
    expect(() => {
      validateDbContext({ tenantId, companyIds: [], roleKeys: ['super_admin', 'hr.manager'] });
    }).not.toThrow();
  });

  it('rejects a key that could add another entry to the array literal', () => {
    for (const bad of ['a,b', 'a}', '{a', '', 'a b', '"a"']) {
      expect(() => {
        validateDbContext({ tenantId, companyIds: [], roleKeys: [bad] });
      }).toThrow(/roleKeys/);
    }
  });
});
