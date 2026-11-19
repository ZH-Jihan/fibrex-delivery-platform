// Tests for phase 3 row 3.3a: the flat employee form and its conversion to API bodies.
import { describe, expect, it } from 'vitest';
import { employeeEditToUpdate, employeeFormSchema, employeeFormToCreate } from './index.js';

describe('employee form', () => {
  it('needs a name and phones in international form', () => {
    expect(employeeFormSchema.safeParse({}).success).toBe(false);
    expect(employeeFormSchema.safeParse({ displayName: 'A', phones: '5555 1234' }).success).toBe(
      false,
    );
    expect(
      employeeFormSchema.safeParse({ displayName: 'A', phones: '+974 5555 1234, +880 1711 000000' })
        .success,
    ).toBe(true);
  });

  it('refuses a sponsor for a company sponsorship', () => {
    const r = employeeFormSchema.safeParse({
      displayName: 'A',
      sponsorship: 'company',
      sponsorPartyId: '3f0c2c3e-4a35-4b0b-9f0b-6a1f2a1c9d11',
    });
    expect(r.success).toBe(false);
  });

  it('builds the create body with names, phones and first placement', () => {
    const values = employeeFormSchema.parse({
      displayName: 'Rahim',
      nameBn: 'Rahim BN',
      phones: '+974 5555 1234, +97466667777',
      qid: '29850000001',
      nationalityCode: 'bd',
      profession: 'rider',
    });
    const body = employeeFormToCreate(values);
    expect(body.person?.phones).toEqual(['+97455551234', '+97466667777']);
    expect(body.person?.names).toEqual({ en: 'Rahim', bn: 'Rahim BN' });
    expect(body.person?.nationalityCode).toBe('BD');
    expect(body.placement?.profession).toBe('rider');
    expect(body.sponsorship).toBe('company');
  });

  it('sends null for cleared edit boxes', () => {
    expect(employeeEditToUpdate({ sponsorship: 'company' })).toEqual({
      sponsorship: 'company',
      sponsorPartyId: null,
      recruitingAgentPartyId: null,
      joiningDate: null,
    });
  });
});
