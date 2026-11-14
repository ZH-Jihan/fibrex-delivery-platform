import { describe, expect, it } from 'vitest';
import {
  can,
  inScope,
  resolvePermissions,
  resolveScopes,
  toScopeSet,
  UNRESTRICTED_SCOPE,
  type Access,
  type ScopeSet,
} from './index.js';

const USER = '00000000-0000-7000-8000-000000000001';
const PARTY = '00000000-0000-7000-8000-000000000002';
const ZONE_1 = '00000000-0000-7000-8000-0000000000a1';
const ZONE_2 = '00000000-0000-7000-8000-0000000000a2';
const PLATFORM_1 = '00000000-0000-7000-8000-0000000000b1';
const BRANCH_1 = '00000000-0000-7000-8000-0000000000c1';

function access(permissions: string[], scopes: ScopeSet[] = [UNRESTRICTED_SCOPE]): Access {
  return { userId: USER, partyId: PARTY, companyId: 'c', roles: ['r'], permissions, scopes };
}

describe('resolvePermissions', () => {
  it('gives what a role grants', () => {
    expect(resolvePermissions({ rolePermissions: ['a.read', 'a.update'], overrides: [] })).toEqual([
      'a.read',
      'a.update',
    ]);
  });

  it('lets a user deny beat a role grant', () => {
    const keys = resolvePermissions({
      rolePermissions: ['a.read', 'a.update'],
      overrides: [{ key: 'a.update', effect: 'deny' }],
    });
    expect(keys).toEqual(['a.read']);
  });

  it('lets a user grant add what no role has', () => {
    const keys = resolvePermissions({
      rolePermissions: ['a.read'],
      overrides: [{ key: 'b.approve', effect: 'grant' }],
    });
    expect(keys).toEqual(['a.read', 'b.approve']);
  });

  it('lets deny beat a grant override for the same key, in either order', () => {
    for (const overrides of [
      [
        { key: 'a.read', effect: 'grant' as const },
        { key: 'a.read', effect: 'deny' as const },
      ],
      [
        { key: 'a.read', effect: 'deny' as const },
        { key: 'a.read', effect: 'grant' as const },
      ],
    ]) {
      expect(resolvePermissions({ rolePermissions: [], overrides })).toEqual([]);
    }
  });

  it('allows nothing by default', () => {
    expect(resolvePermissions({ rolePermissions: [], overrides: [] })).toEqual([]);
  });
});

describe('can', () => {
  it('refuses without access, and a key that is not held', () => {
    expect(can(undefined, 'a.read')).toBe(false);
    expect(can(null, 'a.read')).toBe(false);
    expect(can(access(['a.read']), 'a.update')).toBe(false);
    expect(can(access(['a.read']), 'a.read')).toBe(true);
  });

  it('does not treat a key as a prefix or pattern', () => {
    expect(can(access(['a.read']), 'a')).toBe(false);
    expect(can(access(['a.*']), 'a.read')).toBe(false);
  });

  it('checks the record scope as well as the permission', () => {
    const own = access(['a.read'], [toScopeSet([{ scopeKind: 'own', values: [] }])]);
    expect(can(own, 'a.read', { ownerUserId: USER })).toBe(true);
    expect(can(own, 'a.read', { ownerUserId: 'someone-else' })).toBe(false);
    // The permission itself still comes first.
    expect(can(own, 'a.update', { ownerUserId: USER })).toBe(false);
  });
});

describe('data scope', () => {
  const ownOnly = [toScopeSet([{ scopeKind: 'own', values: [] }])];
  const zoneOnly = [toScopeSet([{ scopeKind: 'zone', values: [ZONE_1] }])];

  it('own: only the records of the user or of the person behind the login', () => {
    const a = access([], ownOnly);
    expect(inScope(a, { ownerUserId: USER })).toBe(true);
    expect(inScope(a, { ownerPartyId: PARTY })).toBe(true);
    expect(inScope(a, { ownerPartyId: 'other' })).toBe(false);
    expect(inScope(a, {})).toBe(false);
  });

  it('own: a login with no person never matches a record with no owner', () => {
    const a: Access = { ...access([], ownOnly), partyId: null };
    expect(inScope(a, { ownerPartyId: null })).toBe(false);
    expect(inScope(a, { ownerUserId: null })).toBe(false);
  });

  it('zone: only records in an allowed zone; a record without a zone is refused', () => {
    const a = access([], zoneOnly);
    expect(inScope(a, { zoneId: ZONE_1 })).toBe(true);
    expect(inScope(a, { zoneId: ZONE_2 })).toBe(false);
    expect(inScope(a, {})).toBe(false);
    expect(inScope(a, { zoneId: null })).toBe(false);
  });

  it('several limits on one subject must all match', () => {
    const a = access(
      [],
      [
        toScopeSet([
          { scopeKind: 'zone', values: [ZONE_1] },
          { scopeKind: 'platform', values: [PLATFORM_1] },
        ]),
      ],
    );
    expect(inScope(a, { zoneId: ZONE_1, platformId: PLATFORM_1 })).toBe(true);
    expect(inScope(a, { zoneId: ZONE_1, platformId: 'other' })).toBe(false);
    expect(inScope(a, { zoneId: ZONE_1 })).toBe(false);
  });

  it('own plus a limit on one subject admits either', () => {
    const a = access(
      [],
      [
        toScopeSet([
          { scopeKind: 'own', values: [] },
          { scopeKind: 'branch', values: [BRANCH_1] },
        ]),
      ],
    );
    expect(inScope(a, { ownerUserId: USER, branchId: 'other' })).toBe(true);
    expect(inScope(a, { ownerUserId: 'other', branchId: BRANCH_1 })).toBe(true);
    expect(inScope(a, { ownerUserId: 'other', branchId: 'other' })).toBe(false);
  });

  it('roles add up: any role that admits the record is enough', () => {
    const scopes = resolveScopes({
      userScopes: [],
      roleScopes: [[{ scopeKind: 'own', values: [] }], [{ scopeKind: 'zone', values: [ZONE_2] }]],
    });
    const a = access([], scopes);
    expect(inScope(a, { ownerUserId: USER })).toBe(true);
    expect(inScope(a, { zoneId: ZONE_2 })).toBe(true);
    expect(inScope(a, { zoneId: ZONE_1 })).toBe(false);
  });

  it('a role with no scope rows is not restricted', () => {
    const scopes = resolveScopes({
      userScopes: [],
      roleScopes: [[{ scopeKind: 'own', values: [] }], []],
    });
    expect(inScope(access([], scopes), { zoneId: ZONE_1 })).toBe(true);
  });

  it('scopes on the user replace those of the roles', () => {
    const scopes = resolveScopes({
      userScopes: [{ scopeKind: 'zone', values: [ZONE_1] }],
      roleScopes: [[]],
    });
    expect(scopes).toHaveLength(1);
    const a = access([], scopes);
    expect(inScope(a, { zoneId: ZONE_1 })).toBe(true);
    expect(inScope(a, { zoneId: ZONE_2 })).toBe(false);
  });

  it('"all" admits everything, and no scope set admits nothing', () => {
    const all = access([], [toScopeSet([{ scopeKind: 'all', values: [] }])]);
    expect(inScope(all, {})).toBe(true);
    expect(inScope(access([], []), { ownerUserId: USER })).toBe(false);
    expect(resolveScopes({ userScopes: [], roleScopes: [] })).toEqual([]);
  });
});
