/**
 * Recycle bin: one place that lists soft-deleted records of every module and restores them
 * (SPEC 2.3).
 *
 * Purpose: a module registers each of its record types once (entity type, repository and
 * how to name a record). The recycle bin then works for that type without any code in the
 * module. Listing and restoring go through the module's repository, so tenancy (RLS),
 * optimistic locking and unique-value conflicts behave exactly as everywhere else, and
 * the restore is audited by the database trigger like any other change.
 *
 * Depends on: ../db/repository.ts, ../http/errors.ts.
 * Used by: ./audit-router.ts; modules register their types at start-up (from commit 8).
 */
import type { BaseRow, Repository } from '../db/repository.js';
import { NotFoundError } from '../http/errors.js';

export interface RecycleBinType<TRow extends BaseRow = BaseRow> {
  /** '<schema>.<table>', the same value the audit log uses, e.g. 'platform.branch'. */
  entityType: string;
  /** Module the type belongs to (the schema name), for the per-module filter. */
  moduleKey: string;
  /** Name of the type shown to users, e.g. 'Branch'. */
  label: string;
  repository: Repository<TRow>;
  /** Short text that identifies one record to a person, e.g. its code and name. */
  describe: (row: TRow) => string;
}

export interface RecycleBinTypeSummary {
  entityType: string;
  moduleKey: string;
  label: string;
  /** Deleted records of this type the caller can see. */
  count: number;
}

export interface RecycleBinItem {
  entityType: string;
  id: string;
  description: string;
  deletedAt: string | null;
  deletedBy: string | null;
  deleteReason: string | null;
  version: number;
}

export interface RecycleBinPage {
  items: RecycleBinItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** The soft-delete columns every mutable table has next to BaseRow. */
type DeletedRow = BaseRow & { deletedBy?: string | null; deleteReason?: string | null };

export class RecycleBin {
  private readonly types = new Map<string, RecycleBinType>();

  register<TRow extends BaseRow>(type: RecycleBinType<TRow>): void {
    if (this.types.has(type.entityType)) {
      throw new Error(`Recycle bin: ${type.entityType} is already registered`);
    }
    this.types.set(type.entityType, type as unknown as RecycleBinType);
  }

  private find(entityType: string): RecycleBinType {
    const type = this.types.get(entityType);
    // An unknown type and an empty one look the same to the caller.
    if (type === undefined) throw new NotFoundError();
    return type;
  }

  /** Registered types (of one module when given) with their number of deleted records. */
  async summary(moduleKey?: string): Promise<RecycleBinTypeSummary[]> {
    const result: RecycleBinTypeSummary[] = [];
    for (const type of this.types.values()) {
      if (moduleKey !== undefined && type.moduleKey !== moduleKey) continue;
      // One at a time: all run on the transaction's single connection.
      const page = await type.repository.list({ deleted: true, page: 1, pageSize: 1 });
      result.push({
        entityType: type.entityType,
        moduleKey: type.moduleKey,
        label: type.label,
        count: page.total,
      });
    }
    return result.sort((a, b) => a.entityType.localeCompare(b.entityType));
  }

  /** Deleted records of one type, most recently deleted first. */
  async list(entityType: string, page: number, pageSize: number): Promise<RecycleBinPage> {
    const type = this.find(entityType);
    const result = await type.repository.list({
      deleted: true,
      page,
      pageSize,
      orderBy: [{ deletedAt: 'desc' }, { id: 'desc' }],
    });
    return {
      items: result.items.map((row) => this.toItem(type, row)),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    };
  }

  /**
   * Restores one deleted record. The version is read and used in the same transaction, so
   * a restore from the list is one click, yet two people restoring at once cannot both win.
   */
  async restore(entityType: string, id: string): Promise<RecycleBinItem> {
    const type = this.find(entityType);
    const found = await type.repository.list({
      deleted: true,
      where: { id },
      page: 1,
      pageSize: 1,
    });
    const row = found.items[0];
    if (row === undefined) throw new NotFoundError();
    const restored = await type.repository.restore(id, row.version);
    return this.toItem(type, restored);
  }

  private toItem(type: RecycleBinType, row: BaseRow): RecycleBinItem {
    const deleted = row as DeletedRow;
    return {
      entityType: type.entityType,
      id: row.id,
      description: type.describe(row),
      deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
      deletedBy: deleted.deletedBy ?? null,
      deleteReason: deleted.deleteReason ?? null,
      version: row.version,
    };
  }
}
