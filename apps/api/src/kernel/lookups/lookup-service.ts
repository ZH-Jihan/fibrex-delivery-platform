/**
 * Lookup service (PLAN 3.7 `lookup_type`, `lookup_value`): the dropdown lists the business
 * may change without a release.
 *
 * What it gives other code: the active values of a list in display order, and a check that a
 * code belongs to a list (custom fields in 2.5 and every module that stores a lookup code
 * use `has`). The lists themselves are data; this file never names one.
 *
 * Rules:
 *   - only live, active values are offered to new records; inactive ones stay readable by
 *     the admin screen (`includeInactive`) so old records keep their meaning;
 *   - order is `sort_order`, then the code, so equal sort numbers still give a stable list.
 *
 * Row-level security applies as to any query: the unit of work has set the tenant context.
 *
 * Depends on: kernel/db/unit-of-work.ts, kernel/http/errors.ts, @fibrex/shared lookups.
 * Used by: lookup-router.ts (`GET /lookups/:key`), later the entity engine (2.5) and modules.
 */
import type { LookupLabels } from '@fibrex/shared';
import { currentUnit } from '../db/unit-of-work.js';
import { NotFoundError } from '../http/errors.js';

export interface LookupOption {
  id: string;
  code: string;
  labels: LookupLabels;
  parentId: string | null;
  sortOrder: number;
  active: boolean;
  meta: Record<string, unknown>;
}

export interface LookupList {
  key: string;
  name: string;
  allowHierarchy: boolean;
  items: LookupOption[];
}

export class LookupService {
  /** The values of the list `key`; throws NotFoundError when the list does not exist. */
  async values(key: string, options: { includeInactive?: boolean } = {}): Promise<LookupList> {
    const { db } = currentUnit();
    const type = await db.lookupType.findFirst({ where: { key, deletedAt: null } });
    if (type === null) throw new NotFoundError();
    const rows = await db.lookupValue.findMany({
      where: {
        lookupTypeId: type.id,
        deletedAt: null,
        ...(options.includeInactive === true ? {} : { active: true }),
      },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
    return {
      key: type.key,
      name: type.name,
      allowHierarchy: type.allowHierarchy,
      items: rows.map((row) => ({
        id: row.id,
        code: row.code,
        labels: row.labels as LookupLabels,
        parentId: row.parentId,
        sortOrder: row.sortOrder,
        active: row.active,
        meta: row.meta as Record<string, unknown>,
      })),
    };
  }

  /** True when `code` is an active value of the list `key` (false for an unknown list). */
  async has(key: string, code: string): Promise<boolean> {
    const { db } = currentUnit();
    const found = await db.lookupValue.findFirst({
      where: { code, active: true, deletedAt: null, type: { key, deletedAt: null } },
      select: { id: true },
    });
    return found !== null;
  }
}
