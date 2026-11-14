/**
 * Permission service: loads what the caller may do and enforces it.
 *
 * Purpose: the one place where the API answers "may this request do X?". Routers built
 * with the CRUD factory, the audit router and every module call `authorize(key)` inside
 * their unit of work; module services call `require(key, record)` when the answer also
 * depends on one record's data scope. The decision itself is the shared `can()` from
 * @fibrex/shared, so the web app hides exactly what this refuses.
 *
 * How access is loaded, and why this way:
 *   1. It is read from the database on every check, never from the access token. The
 *      token's role list is only a label for the audit trail; if permissions came from
 *      it, a change in the matrix would not bite until the token expired. Read fresh, a
 *      removed tick is refused on the very next request.
 *   2. Everything hangs off the caller's membership of the session's company. The
 *      membership, the user and the company must all be active and not deleted; if any
 *      is not, the caller has no roles, so no permissions and nothing in scope. A session
 *      without a company therefore reaches nothing that needs a permission.
 *   3. A role or permission that has been deleted or retired contributes nothing, even
 *      if matrix rows still point at it.
 *   4. Overrides and scopes are read for the session's company only (the tables are
 *      company-scoped, and row-level security would hide other companies anyway).
 *   5. API clients have no permissions yet: API keys and their scopes arrive in part 7d.
 *
 * Depends on: @fibrex/shared (can, resolvePermissions, resolveScopes), kernel/db,
 * kernel/context, kernel/http/errors.ts.
 * Used by: src/main.ts (the `authorize` hook of every router), kernel/permissions/
 * access-admin-*.ts, kernel/auth/user-admin-*.ts, later every module service.
 */
import {
  can,
  resolvePermissions,
  resolveScopes,
  type Access,
  type OverrideEffect,
  type ScopedRecord,
  type ScopeKind,
  type ScopeRow,
} from '@fibrex/shared';
import { requireContext } from '../context/request-context.js';
import type { Db } from '../db/prisma.js';
import type { UnitOfWork } from '../db/unit-of-work.js';
import { ForbiddenError, UnauthenticatedError } from '../http/errors.js';

export class PermissionService {
  private readonly uow: UnitOfWork;

  constructor(uow: UnitOfWork) {
    this.uow = uow;
  }

  /** The access of one user in one company. See the header for the rules. */
  async load(db: Db, userId: string, companyId: string | null): Promise<Access> {
    const none: Access = {
      userId,
      partyId: null,
      companyId,
      roles: [],
      permissions: [],
      scopes: [],
    };
    if (companyId === null) return none;

    // Nested rows are not covered by the soft-delete filter, so each level states it.
    const membership = await db.companyMembership.findFirst({
      where: {
        userId,
        companyId,
        status: 'active',
        user: { status: 'active', deletedAt: null },
        company: { status: 'active', deletedAt: null },
      },
      select: {
        user: { select: { partyId: true } },
        roles: {
          where: { deletedAt: null, role: { deletedAt: null } },
          select: {
            role: {
              select: {
                id: true,
                key: true,
                rolePermissions: {
                  where: { deletedAt: null, permission: { isActive: true } },
                  select: { permission: { select: { key: true } } },
                },
              },
            },
          },
        },
      },
    });
    if (membership === null) return none;

    const roles = membership.roles.map((r) => r.role);
    const overrides = await db.userPermissionOverride.findMany({
      where: { userId, companyId, permission: { isActive: true } },
      select: { effect: true, permission: { select: { key: true } } },
    });
    const scopeRows = await db.dataScope.findMany({
      where: {
        companyId,
        OR: [
          { subjectType: 'user', subjectId: userId },
          { subjectType: 'role', subjectId: { in: roles.map((r) => r.id) } },
        ],
      },
      select: { subjectType: true, subjectId: true, scopeKind: true, scopeValues: true },
    });
    const rowsOf = (subjectType: string, subjectId: string): ScopeRow[] =>
      scopeRows
        .filter((s) => s.subjectType === subjectType && s.subjectId === subjectId)
        .map((s) => ({ scopeKind: s.scopeKind as ScopeKind, values: s.scopeValues }));

    return {
      userId,
      partyId: membership.user.partyId,
      companyId,
      roles: roles.map((r) => r.key).sort(),
      permissions: resolvePermissions({
        rolePermissions: roles.flatMap((r) => r.rolePermissions.map((p) => p.permission.key)),
        overrides: overrides.map((o) => ({
          key: o.permission.key,
          effect: o.effect as OverrideEffect,
        })),
      }),
      scopes: resolveScopes({
        userScopes: rowsOf('user', userId),
        roleScopes: roles.map((r) => rowsOf('role', r.id)),
      }),
    };
  }

  /** The access of whoever is making the current request, in the session's company. */
  current(): Promise<Access> {
    const ctx = requireContext();
    const principal = ctx.principal;
    if (principal === undefined) throw new UnauthenticatedError();
    const companyId = ctx.companyIds[0] ?? null;
    if (principal.kind !== 'user') {
      return Promise.resolve({
        userId: principal.apiClientId,
        partyId: null,
        companyId,
        roles: [],
        permissions: [],
        scopes: [],
      });
    }
    return this.uow.run((db) => this.load(db, principal.userId, companyId));
  }

  /**
   * Throws 403 unless the caller holds `permission` (and, when a record is given, the
   * record is inside their data scope). Returns the access, for further checks.
   */
  async require(permission: string, record?: ScopedRecord): Promise<Access> {
    const access = await this.current();
    if (!can(access, permission, record)) throw new ForbiddenError();
    return access;
  }

  /** The `authorize` hook handed to the CRUD factory and the audit router. */
  readonly authorize = async (permission: string): Promise<void> => {
    await this.require(permission);
  };
}
