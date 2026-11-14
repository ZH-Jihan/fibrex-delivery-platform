/**
 * Attachable record types.
 *
 * Purpose: a file can be attached to a record of any module, but only to a type that module
 * has declared here, with the permissions that guard it. So the files module never needs to
 * know another module's tables, and an attachment can never leak a file to someone who
 * cannot see the record it hangs on (SPEC 2.13: modules talk through interfaces).
 *
 * Depends on: kernel/db (Db type). Used by: ./files-service.ts, ./attachment-router.ts and
 * every module that accepts attachments (registered in src/main.ts).
 */
import type { Db } from '../../kernel/db/prisma.js';
import { NotFoundError, ValidationError } from '../../kernel/http/errors.js';

export interface AttachableType {
  /** '<schema>.<table>', as stored in file_attachment.entity_type. */
  entityType: string;
  /** Needed to see the record's files and to download them. */
  readPermission: string;
  /** Needed to attach, replace, relabel or remove files of the record. */
  attachPermission: string;
  /** True when the record exists and the caller can see it (row-level security applies). */
  exists(db: Db, id: string): Promise<boolean>;
}

export class AttachableRegistry {
  private readonly types = new Map<string, AttachableType>();

  register(type: AttachableType): void {
    if (this.types.has(type.entityType)) {
      throw new Error(`Attachable type ${type.entityType} is already registered`);
    }
    this.types.set(type.entityType, type);
  }

  /** Throws a field error for a type nobody registered. */
  get(entityType: string): AttachableType {
    const type = this.types.get(entityType);
    if (type === undefined) {
      throw new ValidationError([
        {
          path: 'entityType',
          code: 'unknown_entity_type',
          message: `Files cannot be attached to ${entityType}`,
        },
      ]);
    }
    return type;
  }

  /** Like get(), and also 404 when the record is missing or hidden from the caller. */
  async getExisting(db: Db, entityType: string, entityId: string): Promise<AttachableType> {
    const type = this.get(entityType);
    if (!(await type.exists(db, entityId))) throw new NotFoundError();
    return type;
  }

  all(): AttachableType[] {
    return [...this.types.values()];
  }
}
