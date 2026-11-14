/**
 * Access administration: who may change whose access, and how the changes are stored.
 *
 * Purpose: the rules behind the roles screen, the permission matrix, and a user's
 * companies, roles, overrides and data scope (SPEC 2.1). The routers check the plain
 * permission first (for example `iam.user.manage_access`); this service adds the rules
 * that stop a holder of that permission from using it to gain more than they were given.
 * None of them names a role: all are driven by `iam.role_grantable` and the matrix.
 *
 * Rules, and why:
 *   R1. Giving out roles. A caller who holds `iam.role.assign_any` may give any role in
 *       any company of the tenant. Anyone else may give only the roles that one of their
 *       own roles is allowed to give (`role_grantable`), and only in the company they are
 *       working in. This is "Admin can create only the roles Super Admin allows".
 *   R2. Managing a user. A caller may change, lock, reset or delete a user only when
 *       every role that user holds, in any company, is one the caller could give out
 *       (R1). Without this an Admin could change a Super Admin's email address, send a
 *       reset link to it and take the account over.
 *   R3. Never yourself. Nobody changes their own roles, overrides or scope, or locks or
 *       deletes their own account: a second person is always needed.
 *   R4. Override grants. A caller can grant another user only a permission the caller
 *       holds. Deny overrides and removals are not limited this way (they only narrow).
 *   R5. The matrix cannot be saved in a way that takes `iam.permission_matrix.update`
 *       from the person saving it: otherwise one wrong tick locks everyone out of the
 *       screen that would undo it.
 *   R6. Built-in roles cannot be deleted; a role that members still hold cannot be
 *       deleted; a role's key never changes (permissions and audit rows refer to it).
 *
 * Storage: rows are never physically deleted. Unticking a box, removing a role or a
 * company soft-deletes the row (the unique indexes cover live rows only, so ticking it
 * again inserts a new row and the history of both stays in the audit log).
 *
 * Every method must be called inside a unit of work.
 *
 * Depends on: @fibrex/shared (can), ./permission-service.ts, kernel/db, kernel/http/errors.
 * Used by: ./access-admin-router.ts, kernel/auth/user-admin-router.ts.
 */
import { can, type Access, type OverrideEffect, type ScopeKind } from '@fibrex/shared';
import type { Db } from '../db/prisma.js';
import { createRepository, type Repository } from '../db/repository.js';
import { currentUnit } from '../db/unit-of-work.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '../http/errors.js';
import type { PermissionService } from './permission-service.js';

export type RoleRow = NonNullable<Awaited<ReturnType<Db['role']['findFirst']>>>;

export interface MembershipInput {
  companyId: string;
  roleIds: string[];
  isDefault: boolean;
  status: 'active' | 'suspended';
}
export interface OverrideInput {
  permissionKey: string;
  effect: OverrideEffect;
  reason?: string | undefined;
}
export interface ScopeInput {
  scopeKind: ScopeKind;
  values: string[];
}
export interface MatrixChange {
  roleId: string;
  permissionKey: string;
  granted: boolean;
}

const PERMISSION_MATRIX_UPDATE = 'iam.permission_matrix.update';
const ASSIGN_ANY = 'iam.role.assign_any';

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

function invalid(path: string, code: string, message: string): ValidationError {
  return new ValidationError([{ path, code, message }]);
}

function requireCompany(access: Access): string {
  if (access.companyId === null) {
    throw new BadRequestError('company_required', 'Choose a company to work in first.');
  }
  return access.companyId;
}

export class AccessAdminService {
  private readonly permissions: PermissionService;

  constructor(deps: { permissions: PermissionService }) {
    this.permissions = deps.permissions;
  }

  private get db(): Db {
    return currentUnit().db;
  }

  /** The columns that mark a row as removed, stamped with who removed it. */
  private gone(access: Access, reason: string) {
    return { deletedAt: new Date(), deletedBy: access.userId, deleteReason: reason };
  }

  // -----------------------------------------------------------------------------------
  // R1, R2, R3: who may give which role, and who may manage whom
  // -----------------------------------------------------------------------------------

  /** The roles the caller may give out: every role ("any"), or a list of role ids. */
  async assignableRoles(access: Access): Promise<'any' | ReadonlySet<string>> {
    if (can(access, ASSIGN_ANY)) return 'any';
    const rows = await this.db.roleGrantable.findMany({
      where: {
        grantor: { key: { in: [...access.roles] }, deletedAt: null },
        grantable: { deletedAt: null },
      },
      select: { grantableRoleId: true },
    });
    return new Set(rows.map((r) => r.grantableRoleId));
  }

  /** R2 and R3. Throws 403 unless the caller may manage this user. */
  async assertCanManageUser(access: Access, userId: string): Promise<void> {
    if (userId === access.userId) {
      throw new ForbiddenError('You cannot do this to your own account');
    }
    const assignable = await this.assignableRoles(access);
    if (assignable === 'any') return;
    const held = await this.db.membershipRole.findMany({
      where: { membership: { userId, deletedAt: null }, role: { deletedAt: null } },
      select: { roleId: true },
    });
    if (held.some((h) => !assignable.has(h.roleId))) {
      throw new ForbiddenError('This user holds a role you are not allowed to manage');
    }
  }

  private async assertUserExists(userId: string): Promise<void> {
    const user = await this.db.userAccount.findFirst({
      where: { id: userId },
      select: { id: true },
    });
    if (user === null) throw new NotFoundError();
  }

  // -----------------------------------------------------------------------------------
  // Roles (R6) and which roles a role may give out
  // -----------------------------------------------------------------------------------

  /** The repository behind `/roles`, with the rules of R6 added to delete. */
  roleRepository(): Repository<RoleRow> {
    const base = createRepository<RoleRow>({ model: 'role', scope: 'tenant' });
    return {
      ...base,
      softDelete: async (id, expectedVersion, reason) => {
        const role = await base.get(id);
        if (role.isBuiltin) {
          throw new UnprocessableError('builtin_role', 'Built-in roles cannot be deleted');
        }
        const holders = await this.db.membershipRole.count({
          where: { roleId: id, membership: { deletedAt: null } },
        });
        if (holders > 0) {
          throw new ConflictError(
            'role_in_use',
            'Users still hold this role. Remove it from them first.',
            {
              holders,
            },
          );
        }
        return base.softDelete(id, expectedVersion, reason);
      },
    };
  }

  private async assertRolesExist(roleIds: readonly string[], path: string): Promise<void> {
    const unique = [...new Set(roleIds)];
    if (unique.length === 0) return;
    const found = await this.db.role.count({ where: { id: { in: unique } } });
    if (found !== unique.length)
      throw invalid(path, 'unknown_role', 'One of the roles does not exist');
  }

  async grantableRoles(roleId: string): Promise<string[]> {
    const role = await this.db.role.findFirst({ where: { id: roleId }, select: { id: true } });
    if (role === null) throw new NotFoundError();
    const rows = await this.db.roleGrantable.findMany({
      where: { grantorRoleId: roleId, grantable: { deletedAt: null } },
      select: { grantableRoleId: true },
    });
    return rows.map((r) => r.grantableRoleId).sort();
  }

  /** Replaces the list of roles that holders of `roleId` may give out. */
  async saveGrantableRoles(access: Access, roleId: string, roleIds: string[]): Promise<string[]> {
    const before = await this.grantableRoles(roleId);
    const after = [...new Set(roleIds)];
    await this.assertRolesExist(after, 'roleIds');
    const removed = before.filter((id) => !after.includes(id));
    const added = after.filter((id) => !before.includes(id));
    if (removed.length > 0) {
      await this.db.roleGrantable.updateMany({
        where: { grantorRoleId: roleId, grantableRoleId: { in: removed } },
        data: this.gone(access, 'removed'),
      });
    }
    if (added.length > 0) {
      const { tenantId } = currentUnit().context;
      await this.db.roleGrantable.createMany({
        data: added.map((grantableRoleId) => ({
          tenantId,
          grantorRoleId: roleId,
          grantableRoleId,
        })),
      });
    }
    return this.grantableRoles(roleId);
  }

  // -----------------------------------------------------------------------------------
  // Permission catalogue and matrix (R5)
  // -----------------------------------------------------------------------------------

  async catalogue() {
    const rows = await this.db.permission.findMany({
      where: { isActive: true },
      orderBy: [{ moduleKey: 'asc' }, { key: 'asc' }],
    });
    return rows.map((p) => ({
      key: p.key,
      moduleKey: p.moduleKey,
      resource: p.resource,
      action: p.action,
      description: p.description,
    }));
  }

  async matrix() {
    const roles = await this.db.role.findMany({
      orderBy: { key: 'asc' },
      select: { id: true, key: true, name: true, isBuiltin: true },
    });
    const grants = await this.db.rolePermission.findMany({
      where: { role: { deletedAt: null }, permission: { isActive: true } },
      select: { roleId: true, permission: { select: { key: true } } },
    });
    return {
      roles,
      permissions: await this.catalogue(),
      grants: grants.map((g) => ({ roleId: g.roleId, permissionKey: g.permission.key })),
    };
  }

  /**
   * Applies ticked and unticked boxes. Only the boxes sent are touched, so two people
   * editing different rows of the matrix do not overwrite each other.
   */
  async saveMatrix(
    access: Access,
    changes: readonly MatrixChange[],
  ): Promise<{ granted: number; revoked: number }> {
    // 1. The same box twice in one save is ambiguous: refuse rather than pick one.
    const boxes = new Set(changes.map((c) => `${c.roleId}:${c.permissionKey}`));
    if (boxes.size !== changes.length) {
      throw invalid('changes', 'duplicate', 'The same box appears more than once');
    }
    // 2. Every role and key must exist.
    await this.assertRolesExist(
      changes.map((c) => c.roleId),
      'changes',
    );
    const keys = [...new Set(changes.map((c) => c.permissionKey))];
    const permissions = await this.db.permission.findMany({
      where: { key: { in: keys }, isActive: true },
      select: { id: true, key: true },
    });
    if (permissions.length !== keys.length) {
      throw invalid('changes', 'unknown_permission', 'One of the permissions does not exist');
    }
    const idOfKey = new Map(permissions.map((p) => [p.key, p.id]));

    // 3. Compare with what is ticked now, so saving the same state twice writes nothing.
    const existing = await this.db.rolePermission.findMany({
      where: {
        roleId: { in: [...new Set(changes.map((c) => c.roleId))] },
        permissionId: { in: permissions.map((p) => p.id) },
      },
      select: { id: true, roleId: true, permissionId: true },
    });
    const liveId = new Map(existing.map((e) => [`${e.roleId}:${e.permissionId}`, e.id]));
    const { tenantId } = currentUnit().context;
    const toCreate: { tenantId: string; roleId: string; permissionId: string }[] = [];
    const toRemove: string[] = [];
    for (const change of changes) {
      const permissionId = idOfKey.get(change.permissionKey);
      // Cannot happen (step 2 found every key); stated so a gap can never write a row.
      if (permissionId === undefined) continue;
      const rowId = liveId.get(`${change.roleId}:${permissionId}`);
      if (change.granted && rowId === undefined) {
        toCreate.push({ tenantId, roleId: change.roleId, permissionId });
      } else if (!change.granted && rowId !== undefined) {
        toRemove.push(rowId);
      }
    }
    if (toRemove.length > 0) {
      await this.db.rolePermission.updateMany({
        where: { id: { in: toRemove } },
        data: this.gone(access, 'unticked'),
      });
    }
    if (toCreate.length > 0) await this.db.rolePermission.createMany({ data: toCreate });

    // 4. R5: re-read the caller's own access as it now stands. Throwing rolls the whole
    //    save back, so nothing is half-applied.
    const after = await this.permissions.load(this.db, access.userId, access.companyId);
    if (!can(after, PERMISSION_MATRIX_UPDATE)) {
      throw new UnprocessableError(
        'would_lock_out',
        'This change would remove your own right to edit the permission matrix',
      );
    }
    return { granted: toCreate.length, revoked: toRemove.length };
  }

  // -----------------------------------------------------------------------------------
  // A user's companies and roles (R1, R2, R3)
  // -----------------------------------------------------------------------------------

  async memberships(userId: string): Promise<(MembershipInput & { id: string })[]> {
    await this.assertUserExists(userId);
    const rows = await this.db.companyMembership.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      include: { roles: { where: { deletedAt: null }, select: { roleId: true } } },
    });
    return rows.map((m) => ({
      id: m.id,
      companyId: m.companyId,
      roleIds: m.roles.map((r) => r.roleId).sort(),
      isDefault: m.isDefault,
      status: m.status as MembershipInput['status'],
    }));
  }

  /**
   * The companies a save of this user's memberships must be allowed to write in.
   *
   * Every membership row is audited in the company it belongs to, and the database lets
   * a transaction write audit rows only for the companies in its context. A caller who
   * may give any role in any company (R1) therefore needs a transaction that covers the
   * companies being changed, not just the one their session is in. The router opens
   * that wider transaction with exactly this list. Everyone else gets their current
   * company only, which is all R1 lets them change. Tenant isolation is not affected: a
   * company id of another tenant in the list matches no row.
   */
  async membershipCompanies(
    access: Access,
    userId: string,
    input: readonly MembershipInput[],
  ): Promise<string[]> {
    const current = requireCompany(access);
    if ((await this.assignableRoles(access)) !== 'any') return [current];
    const before = await this.db.companyMembership.findMany({
      where: { userId },
      select: { companyId: true },
    });
    return [
      ...new Set([current, ...before.map((m) => m.companyId), ...input.map((m) => m.companyId)]),
    ];
  }

  /**
   * Replaces the user's companies and roles with `input`.
   *
   * Steps:
   *   1. R2/R3: the caller must be allowed to manage this user at all.
   *   2. Shape: one entry per company; when there are entries, exactly one is the default
   *      (the company a new session starts in).
   *   3. Work out, per company, whether anything changes. Only changed companies are
   *      checked and written, so a caller limited to one company can save a user who
   *      also belongs to others, as long as those entries are sent back unchanged.
   *   4. R1 for every changed company, and for every role being added.
   *   5. Write: removals are soft deletes; the default flag is cleared before it is set
   *      elsewhere because the database allows one default per user.
   * The router signs the user out afterwards: their tokens name the old roles.
   */
  async saveMemberships(access: Access, userId: string, input: readonly MembershipInput[]) {
    await this.assertUserExists(userId);
    await this.assertCanManageUser(access, userId);

    const companies = input.map((m) => m.companyId);
    if (new Set(companies).size !== companies.length) {
      throw invalid('memberships', 'duplicate', 'A company appears more than once');
    }
    if (input.length > 0 && input.filter((m) => m.isDefault).length !== 1) {
      throw invalid('memberships', 'default_required', 'Mark exactly one company as the default');
    }

    const before = await this.memberships(userId);
    const beforeOf = new Map(before.map((m) => [m.companyId, m]));
    const afterOf = new Map(
      input.map((m) => [m.companyId, { ...m, roleIds: [...new Set(m.roleIds)] }]),
    );
    const assignable = await this.assignableRoles(access);
    const mayGive = (roleId: string) => assignable === 'any' || assignable.has(roleId);

    const changed: string[] = [];
    for (const companyId of new Set([...beforeOf.keys(), ...afterOf.keys()])) {
      const b = beforeOf.get(companyId);
      const a = afterOf.get(companyId);
      const same =
        a !== undefined &&
        b?.status === a.status &&
        b.isDefault === a.isDefault &&
        sameSet(b.roleIds, a.roleIds);
      if (same) continue;
      changed.push(companyId);
      if (assignable !== 'any' && companyId !== access.companyId) {
        throw new ForbiddenError('You can change access only in the company you are working in');
      }
      const added = (a?.roleIds ?? []).filter((id) => !(b?.roleIds ?? []).includes(id));
      if (!added.every(mayGive)) {
        throw new ForbiddenError('You are not allowed to give out one of these roles');
      }
    }
    if (changed.length === 0) return { changed: false, memberships: before };

    await this.assertRolesExist(
      [...afterOf.values()].flatMap((m) => m.roleIds),
      'memberships',
    );
    const newCompanies = changed.filter((id) => !beforeOf.has(id));
    if (newCompanies.length > 0) {
      const found = await this.db.company.count({
        where: { id: { in: newCompanies }, status: 'active' },
      });
      if (found !== newCompanies.length) {
        throw invalid(
          'memberships',
          'unknown_company',
          'One of the companies does not exist or is inactive',
        );
      }
    }

    const { tenantId } = currentUnit().context;
    await this.db.companyMembership.updateMany({
      where: { userId, isDefault: true, companyId: { in: changed } },
      data: { isDefault: false },
    });
    for (const companyId of changed) {
      const b = beforeOf.get(companyId);
      const a = afterOf.get(companyId);
      if (a === undefined && b !== undefined) {
        await this.db.membershipRole.updateMany({
          where: { membershipId: b.id },
          data: this.gone(access, 'membership_removed'),
        });
        await this.db.companyMembership.updateMany({
          where: { id: b.id },
          data: this.gone(access, 'removed'),
        });
        continue;
      }
      if (a === undefined) continue;
      let membershipId: string;
      if (b === undefined) {
        const created = await this.db.companyMembership.create({
          data: { tenantId, userId, companyId, status: a.status, isDefault: a.isDefault },
        });
        membershipId = created.id;
      } else {
        membershipId = b.id;
        await this.db.companyMembership.updateMany({
          where: { id: b.id },
          data: { status: a.status, isDefault: a.isDefault },
        });
        const dropped = b.roleIds.filter((id) => !a.roleIds.includes(id));
        if (dropped.length > 0) {
          await this.db.membershipRole.updateMany({
            where: { membershipId, roleId: { in: dropped } },
            data: this.gone(access, 'removed'),
          });
        }
      }
      const added = a.roleIds.filter((id) => !(b?.roleIds ?? []).includes(id));
      if (added.length > 0) {
        await this.db.membershipRole.createMany({
          data: added.map((roleId) => ({ tenantId, membershipId, roleId })),
        });
      }
    }
    return { changed: true, memberships: await this.memberships(userId) };
  }

  // -----------------------------------------------------------------------------------
  // Per-user overrides in the current company (R2, R3, R4)
  // -----------------------------------------------------------------------------------

  async overrides(access: Access, userId: string): Promise<Required<OverrideInput>[]> {
    await this.assertUserExists(userId);
    const rows = await this.db.userPermissionOverride.findMany({
      where: { userId, companyId: requireCompany(access), permission: { isActive: true } },
      select: { effect: true, reason: true, permission: { select: { key: true } } },
    });
    return rows
      .map((o) => ({
        permissionKey: o.permission.key,
        effect: o.effect as OverrideEffect,
        reason: o.reason ?? '',
      }))
      .sort((a, b) => a.permissionKey.localeCompare(b.permissionKey));
  }

  /** Replaces the user's overrides in the caller's current company. */
  async saveOverrides(access: Access, userId: string, input: readonly OverrideInput[]) {
    const companyId = requireCompany(access);
    await this.assertUserExists(userId);
    await this.assertCanManageUser(access, userId);

    const keys = input.map((o) => o.permissionKey);
    if (new Set(keys).size !== keys.length) {
      throw invalid('overrides', 'duplicate', 'A permission appears more than once');
    }
    const permissions = await this.db.permission.findMany({
      where: { key: { in: keys }, isActive: true },
      select: { id: true, key: true },
    });
    if (permissions.length !== keys.length) {
      throw invalid('overrides', 'unknown_permission', 'One of the permissions does not exist');
    }
    const idOfKey = new Map(permissions.map((p) => [p.key, p.id]));

    const existing = await this.db.userPermissionOverride.findMany({
      where: { userId, companyId },
      select: { id: true, effect: true, reason: true, permission: { select: { key: true } } },
    });
    const existingOf = new Map(existing.map((e) => [e.permission.key, e]));

    for (const o of input) {
      const current = existingOf.get(o.permissionKey);
      // R4 applies to a grant that is new, or that used to be a deny.
      if (o.effect === 'grant' && current?.effect !== 'grant' && !can(access, o.permissionKey)) {
        throw new ForbiddenError('You cannot grant a permission you do not hold yourself');
      }
    }

    const removed = existing.filter((e) => !keys.includes(e.permission.key)).map((e) => e.id);
    if (removed.length > 0) {
      await this.db.userPermissionOverride.updateMany({
        where: { id: { in: removed } },
        data: this.gone(access, 'removed'),
      });
    }
    const { tenantId } = currentUnit().context;
    for (const o of input) {
      const current = existingOf.get(o.permissionKey);
      const reason = o.reason ?? null;
      const permissionId = idOfKey.get(o.permissionKey);
      // Cannot happen (every key was found above); stated so a gap never writes a row.
      if (permissionId === undefined) continue;
      if (current === undefined) {
        await this.db.userPermissionOverride.create({
          data: { tenantId, companyId, userId, permissionId, effect: o.effect, reason },
        });
      } else if (current.effect !== o.effect || current.reason !== reason) {
        await this.db.userPermissionOverride.updateMany({
          where: { id: current.id },
          data: { effect: o.effect, reason },
        });
      }
    }
    return this.overrides(access, userId);
  }

  // -----------------------------------------------------------------------------------
  // Data scope of a user or a role in the current company (R2, R3)
  // -----------------------------------------------------------------------------------

  async scopes(
    access: Access,
    subjectType: 'user' | 'role',
    subjectId: string,
  ): Promise<ScopeInput[]> {
    await this.assertSubjectExists(subjectType, subjectId);
    const rows = await this.db.dataScope.findMany({
      where: { companyId: requireCompany(access), subjectType, subjectId },
      orderBy: { scopeKind: 'asc' },
    });
    return rows.map((s) => ({
      scopeKind: s.scopeKind as ScopeKind,
      values: [...s.scopeValues].sort(),
    }));
  }

  private async assertSubjectExists(subjectType: 'user' | 'role', subjectId: string) {
    if (subjectType === 'user') return this.assertUserExists(subjectId);
    const role = await this.db.role.findFirst({ where: { id: subjectId }, select: { id: true } });
    if (role === null) throw new NotFoundError();
  }

  /**
   * Replaces the data scope of a user or a role in the caller's current company.
   * "own" and "all" take no values; "zone", "branch" and "platform" need at least one.
   * Zones and branches must exist in this company. Client platforms are checked from the
   * phase that adds their table; until then their ids are stored as given.
   */
  async saveScopes(
    access: Access,
    subjectType: 'user' | 'role',
    subjectId: string,
    input: readonly ScopeInput[],
  ): Promise<ScopeInput[]> {
    const companyId = requireCompany(access);
    await this.assertSubjectExists(subjectType, subjectId);
    if (subjectType === 'user') await this.assertCanManageUser(access, subjectId);

    const kinds = input.map((s) => s.scopeKind);
    if (new Set(kinds).size !== kinds.length) {
      throw invalid('scopes', 'duplicate', 'A kind of scope appears more than once');
    }
    for (const s of input) {
      const takesValues = s.scopeKind !== 'own' && s.scopeKind !== 'all';
      if (takesValues !== s.values.length > 0) {
        throw invalid(
          'scopes',
          'invalid_values',
          takesValues ? `Choose at least one ${s.scopeKind}` : `"${s.scopeKind}" takes no values`,
        );
      }
    }
    const valuesOf = (kind: ScopeKind) => [
      ...new Set(input.filter((s) => s.scopeKind === kind).flatMap((s) => s.values)),
    ];
    const zones = valuesOf('zone');
    if (zones.length > 0) {
      const found = await this.db.orgUnit.count({
        where: { id: { in: zones }, kind: 'zone', companyId },
      });
      if (found !== zones.length)
        throw invalid('scopes', 'unknown_zone', 'One of the zones does not exist');
    }
    const branches = valuesOf('branch');
    if (branches.length > 0) {
      const found = await this.db.branch.count({ where: { id: { in: branches }, companyId } });
      if (found !== branches.length) {
        throw invalid('scopes', 'unknown_branch', 'One of the branches does not exist');
      }
    }

    const existing = await this.db.dataScope.findMany({
      where: { companyId, subjectType, subjectId },
      select: { id: true, scopeKind: true, scopeValues: true },
    });
    const removed = existing
      .filter((e) => !kinds.includes(e.scopeKind as ScopeKind))
      .map((e) => e.id);
    if (removed.length > 0) {
      await this.db.dataScope.updateMany({
        where: { id: { in: removed } },
        data: this.gone(access, 'removed'),
      });
    }
    const { tenantId } = currentUnit().context;
    for (const s of input) {
      const values = [...new Set(s.values)];
      const current = existing.find((e) => e.scopeKind === s.scopeKind);
      if (current === undefined) {
        await this.db.dataScope.create({
          data: {
            tenantId,
            companyId,
            subjectType,
            subjectId,
            scopeKind: s.scopeKind,
            scopeValues: values,
          },
        });
      } else if (!sameSet(current.scopeValues, values)) {
        await this.db.dataScope.updateMany({
          where: { id: current.id },
          data: { scopeValues: values },
        });
      }
    }
    return this.scopes(access, subjectType, subjectId);
  }
}
