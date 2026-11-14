/**
 * Permission resolution: the single `can()` used by the API and the web app (SPEC 2.1).
 *
 * Purpose: decide "may this user do this action, on this record?" from data only. No role
 * name is ever tested in code; everything comes from the permission matrix, the per-user
 * overrides and the data scopes stored in the `iam` tables. The API loads those rows into
 * an `Access` object on every request and enforces it; the web app receives the same
 * object from `GET /me/permissions` and uses the same function to hide what would be
 * refused anyway.
 *
 * Rules, in order (resolvePermissions):
 *   1. A user override with effect "deny" wins over everything.
 *   2. A user override with effect "grant" gives the permission even if no role has it.
 *   3. Otherwise the permission is held when at least one of the user's roles in the
 *      current company has it ticked in the matrix.
 *   4. Otherwise it is refused. Nothing is allowed by default.
 *
 * Record-level scope (resolveScopes, inScope): which records the permission applies to.
 *   - Each subject (the user, or one of their roles) has one "scope set" built from its
 *     data_scope rows in the current company.
 *   - Scopes set on the user replace the scopes of their roles, the same way a user
 *     override takes priority over the role.
 *   - Without user scopes, roles add up: a record is in scope when ANY role's set admits
 *     it. A role with no scope rows is not restricted (it admits every record of the
 *     company), because restriction is the exception that an administrator configures.
 *   - Inside one set, a record is admitted when the set says "all"; or the set says "own"
 *     and the record belongs to the user; or the set limits by platform, zone or branch
 *     and the record matches EVERY limited dimension. A record that does not state a
 *     limited dimension is refused (fail closed).
 *   - A user with no scope set at all (no roles) has nothing in scope.
 *
 * Depends on: nothing. Used by: apps/api kernel/permissions, apps/web lib (route guards
 * and hidden buttons).
 */

export type ScopeKind = 'own' | 'platform' | 'zone' | 'branch' | 'all';
export type OverrideEffect = 'grant' | 'deny';

/** One data_scope row. */
export interface ScopeRow {
  scopeKind: ScopeKind;
  values: readonly string[];
}

/** What one subject (the user or one role) may see. */
export interface ScopeSet {
  all: boolean;
  own: boolean;
  platform: readonly string[];
  zone: readonly string[];
  branch: readonly string[];
}

/** Everything `can()` needs about the caller in their current company. */
export interface Access {
  userId: string;
  /** The person behind the login, when linked; used by the "own" scope. */
  partyId: string | null;
  companyId: string | null;
  roles: readonly string[];
  /** Effective permission keys, after overrides. */
  permissions: readonly string[];
  /** A record is in scope when any one set admits it; an empty list admits nothing. */
  scopes: readonly ScopeSet[];
}

/** The facts about a record that scopes are checked against. State what the record has. */
export interface ScopedRecord {
  ownerUserId?: string | null;
  ownerPartyId?: string | null;
  platformId?: string | null;
  zoneId?: string | null;
  branchId?: string | null;
}

export const UNRESTRICTED_SCOPE: ScopeSet = {
  all: true,
  own: false,
  platform: [],
  zone: [],
  branch: [],
};

/** Applies the override rules to the keys granted by the user's roles. */
export function resolvePermissions(input: {
  rolePermissions: Iterable<string>;
  overrides: Iterable<{ key: string; effect: OverrideEffect }>;
}): string[] {
  const held = new Set(input.rolePermissions);
  const denied = new Set<string>();
  for (const o of input.overrides) {
    if (o.effect === 'deny') denied.add(o.key);
    else held.add(o.key);
  }
  // Deny is removed last, so it also beats a grant override for the same key.
  for (const key of denied) held.delete(key);
  return [...held].sort();
}

/** Folds one subject's data_scope rows into a scope set. No rows: not restricted. */
export function toScopeSet(rows: readonly ScopeRow[]): ScopeSet {
  if (rows.length === 0) return UNRESTRICTED_SCOPE;
  const of = (kind: ScopeKind) => rows.filter((r) => r.scopeKind === kind);
  const values = (kind: ScopeKind) => [...new Set(of(kind).flatMap((r) => r.values))];
  return {
    all: of('all').length > 0,
    own: of('own').length > 0,
    platform: values('platform'),
    zone: values('zone'),
    branch: values('branch'),
  };
}

/** Scopes set on the user replace those of the roles; otherwise one set per role. */
export function resolveScopes(input: {
  userScopes: readonly ScopeRow[];
  /** One entry per role the user holds, with that role's rows (possibly none). */
  roleScopes: readonly (readonly ScopeRow[])[];
}): ScopeSet[] {
  if (input.userScopes.length > 0) return [toScopeSet(input.userScopes)];
  return input.roleScopes.map(toScopeSet);
}

function admits(set: ScopeSet, access: Access, record: ScopedRecord): boolean {
  if (set.all) return true;
  if (set.own) {
    if (record.ownerUserId != null && record.ownerUserId === access.userId) return true;
    if (
      record.ownerPartyId != null &&
      access.partyId !== null &&
      record.ownerPartyId === access.partyId
    ) {
      return true;
    }
  }
  const limits: [readonly string[], string | null | undefined][] = [
    [set.platform, record.platformId],
    [set.zone, record.zoneId],
    [set.branch, record.branchId],
  ];
  const active = limits.filter(([allowed]) => allowed.length > 0);
  if (active.length === 0) return false;
  return active.every(([allowed, value]) => value != null && allowed.includes(value));
}

/** Whether the record is one the caller's data scope reaches. */
export function inScope(access: Access, record: ScopedRecord): boolean {
  return access.scopes.some((set) => admits(set, access, record));
}

/**
 * May the caller do this? `permission` is a catalogue key such as "iam.user.update".
 * Pass `record` when the action is on one record, so its data scope is checked too.
 */
export function can(
  access: Access | null | undefined,
  permission: string,
  record?: ScopedRecord,
): boolean {
  if (access == null) return false;
  if (!access.permissions.includes(permission)) return false;
  return record === undefined ? true : inScope(access, record);
}
