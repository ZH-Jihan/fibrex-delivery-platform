/**
 * Document types and document requirements API (PLAN 5.12), plus their seed:
 *
 *   /document-types         CRUD factory (people.document_type.*)
 *   /document-requirements  CRUD factory (people.document_requirement.*)
 *
 * Rules, and why:
 *   1. Types are data (SPEC 2.6). The standard ones are seeded per company with
 *      is_system = true; they can be renamed and given their own alert windows, but never
 *      deleted (409 here, and a CHECK in the database). Code and owner kind are fixed after
 *      creation, because documents already rely on them.
 *   2. A requirement names a type for people (applies_to = party) and, optionally, a
 *      condition: a sandboxed formula (never eval) that must give true or false over the
 *      employee's sponsorship, profession and nationality. It is compiled on every write,
 *      so a broken condition is refused at once instead of breaking the missing-documents
 *      report later.
 *
 * Depends on: express, zod, @fibrex/formula, @fibrex/shared (document schemas), kernel/db,
 * kernel/http. Used by: ./index.ts, ./document-router.ts (DocumentTypeRow), src/seed/seed.ts
 * (seedDocumentTypes through ./index.ts).
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { compileFormula, FormulaError, type InputSchema } from '@fibrex/formula';
import {
  documentRequirementCreateSchema,
  documentRequirementUpdateSchema,
  documentTypeCreateSchema,
  documentTypeUpdateSchema,
} from '@fibrex/shared';
import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { Db } from '../../kernel/db/prisma.js';
import { createRepository, type Repository } from '../../kernel/db/repository.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { createCrudRouter } from '../../kernel/http/crud-router.js';
import { ConflictError, ValidationError } from '../../kernel/http/errors.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';

export type DocumentTypeRow = NonNullable<Awaited<ReturnType<Db['documentType']['findFirst']>>>;
export type RequirementRow = NonNullable<
  Awaited<ReturnType<Db['documentRequirement']['findFirst']>>
>;

const stamps = {
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
};
const stampsOf = (row: DocumentTypeRow | RequirementRow) => ({
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  deletedAt: row.deletedAt?.toISOString() ?? null,
});

const typeItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    code: z.string(),
    name: z.record(z.string(), z.string()),
    appliesTo: z.string(),
    hasExpiry: z.boolean(),
    hasNumber: z.boolean(),
    multiPage: z.boolean(),
    alertWindows: z.array(z.number().int()).nullable(),
    isSystem: z.boolean(),
    ...stamps,
  })
  .meta({ id: 'DocumentType' });
const toTypeItem = (row: DocumentTypeRow) => ({
  id: row.id,
  companyId: row.companyId,
  code: row.code,
  name: row.name as Record<string, string>,
  appliesTo: row.appliesTo,
  hasExpiry: row.hasExpiry,
  hasNumber: row.hasNumber,
  multiPage: row.multiPage,
  // Prisma reads a NULL int[] as []; the API says null ("company default").
  alertWindows: row.alertWindows.length === 0 ? null : row.alertWindows,
  isSystem: row.isSystem,
  ...stampsOf(row),
});
const typeFilter = z.object({ appliesTo: z.enum(['party', 'vehicle', 'company']).optional() });

const requirementItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    documentTypeId: z.uuid(),
    conditionExpr: z.string().nullable(),
    appliesToProfession: z.string().nullable(),
    ...stamps,
  })
  .meta({ id: 'DocumentRequirement' });
const toRequirementItem = (row: RequirementRow) => ({
  id: row.id,
  companyId: row.companyId,
  documentTypeId: row.documentTypeId,
  conditionExpr: row.conditionExpr,
  appliesToProfession: row.appliesToProfession,
  ...stampsOf(row),
});
const requirementFilter = z.object({ documentTypeId: z.uuid().optional() });

/** What a requirement condition may read about the employee (rule 2). */
export const REQUIREMENT_INPUTS: InputSchema = {
  sponsorship: { type: 'string', description: 'company or outside' },
  profession: { type: 'string', description: 'Profession code of the current placement' },
  nationality: { type: 'string', description: 'Two-letter country code', default: '' },
};

function checkCondition(expr: unknown): void {
  if (typeof expr !== 'string') return;
  try {
    compileFormula(expr, REQUIREMENT_INPUTS, 'bool');
  } catch (err) {
    if (!(err instanceof FormulaError)) throw err;
    throw new ValidationError([{ path: 'conditionExpr', code: err.code, message: err.message }]);
  }
}

/** Alert windows: null in the API is stored as an empty array; both mean the company default. */
function windowsColumn(data: Record<string, unknown>): Record<string, unknown> {
  if (!('alertWindows' in data)) return data;
  const windows = data.alertWindows;
  // Sorted largest first and without repeats, so the expiry job reads them in order.
  const sorted = Array.isArray(windows)
    ? [...new Set(windows as number[])].sort((a, b) => b - a)
    : [];
  return { ...data, alertWindows: sorted };
}

export function createDocumentTypeRepository(): Repository<DocumentTypeRow> {
  const base = createRepository<DocumentTypeRow>({ model: 'documentType', scope: 'company' });
  return {
    ...base,
    create: (data) => base.create(windowsColumn({ ...data, isSystem: false })),
    update: (id, version, changes) => base.update(id, version, windowsColumn(changes)),
    softDelete: async (id, version, reason) => {
      const row = await base.get(id);
      if (row.isSystem) {
        throw new ConflictError(
          'system_document_type',
          'A standard document type cannot be deleted. Rename it or change its alerts instead.',
        );
      }
      return base.softDelete(id, version, reason);
    },
  };
}

export function createRequirementRepository(): Repository<RequirementRow> {
  const base = createRepository<RequirementRow>({ model: 'documentRequirement', scope: 'company' });
  return {
    ...base,
    create: async (data) => {
      const type = await currentUnit().db.documentType.findFirst({
        where: { id: String(data.documentTypeId), deletedAt: null },
        select: { appliesTo: true, companyId: true },
      });
      if (type?.appliesTo !== 'party') {
        throw new ValidationError([
          {
            path: 'documentTypeId',
            code: 'unknown_document_type',
            message: 'No such document type for people in this company',
          },
        ]);
      }
      checkCondition(data.conditionExpr);
      // The requirement sits in the company of its type.
      return base.create({ ...data, companyId: type.companyId });
    },
    update: (id, version, changes) => {
      checkCondition(changes.conditionExpr);
      return base.update(id, version, changes);
    },
  };
}

export interface DocumentTypeRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  types: Repository<DocumentTypeRow>;
  requirements: Repository<RequirementRow>;
}

const definedOnly = (f: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));

export function createDocumentTypeRouter(deps: DocumentTypeRouterDeps): Router {
  const { uow, registry, permissions, types, requirements } = deps;
  const crud = { uow, authorize: permissions.authorize, registry };
  const router = Router();
  router.use(
    createCrudRouter(crud, {
      path: '/document-types',
      resource: 'people.document_type',
      tag: 'Document types',
      repository: types,
      schemas: {
        create: documentTypeCreateSchema,
        update: documentTypeUpdateSchema,
        item: typeItem,
        filter: typeFilter,
      },
      toItem: toTypeItem,
      toWhere: definedOnly,
    }),
  );
  router.use(
    createCrudRouter(crud, {
      path: '/document-requirements',
      resource: 'people.document_requirement',
      tag: 'Document requirements',
      repository: requirements,
      schemas: {
        create: documentRequirementCreateSchema,
        update: documentRequirementUpdateSchema,
        item: requirementItem,
        filter: requirementFilter,
      },
      toItem: toRequirementItem,
      toWhere: definedOnly,
    }),
  );
  return router;
}

interface SeedType {
  code: string;
  name: { en: string; ar: string; bn: string };
  appliesTo: 'party' | 'vehicle';
  hasNumber: boolean;
  multiPage: boolean;
  /** Required for every worker (owner answer 2026-11-19); 'outside' = only for outside sponsorship. */
  required: 'always' | 'outside' | 'no';
}

/** The standard types (PLAN 3.10) and who must hold them (phase 3 plan question 3). */
const STANDARD_TYPES: readonly SeedType[] = [
  {
    code: 'qid',
    name: { en: 'QID', ar: 'البطاقة الشخصية', bn: 'কিউআইডি' },
    appliesTo: 'party',
    hasNumber: true,
    multiPage: true,
    required: 'always',
  },
  {
    code: 'driving_licence',
    name: { en: 'Driving licence', ar: 'رخصة القيادة', bn: 'ড্রাইভিং লাইসেন্স' },
    appliesTo: 'party',
    hasNumber: true,
    multiPage: true,
    required: 'always',
  },
  {
    code: 'istimara',
    name: { en: 'Istimara', ar: 'الاستمارة', bn: 'ইস্তিমারা' },
    appliesTo: 'vehicle',
    hasNumber: true,
    multiPage: false,
    required: 'no',
  },
  {
    code: 'passport',
    name: { en: 'Passport', ar: 'جواز السفر', bn: 'পাসপোর্ট' },
    appliesTo: 'party',
    hasNumber: true,
    multiPage: true,
    required: 'always',
  },
  {
    code: 'food_handling',
    name: { en: 'Food handling certificate', ar: 'شهادة تداول الأغذية', bn: 'খাদ্য পরিচালনা সনদ' },
    appliesTo: 'party',
    hasNumber: true,
    multiPage: false,
    required: 'always',
  },
  {
    code: 'health_card',
    name: { en: 'Health card', ar: 'البطاقة الصحية', bn: 'হেলথ কার্ড' },
    appliesTo: 'party',
    hasNumber: true,
    multiPage: false,
    required: 'always',
  },
  {
    code: 'insurance',
    name: { en: 'Insurance', ar: 'التأمين', bn: 'বীমা' },
    appliesTo: 'party',
    hasNumber: true,
    multiPage: false,
    required: 'always',
  },
  {
    code: 'agreement',
    name: { en: 'Agreement', ar: 'الاتفاقية', bn: 'চুক্তিপত্র' },
    appliesTo: 'party',
    hasNumber: false,
    multiPage: true,
    required: 'outside',
  },
];

/**
 * Seeds the standard document types and their requirements for one company, only those
 * missing (a type the administrator already has keeps its settings). Runs as the owner
 * role inside the seed transaction. Returns how many types were added.
 */
export async function seedDocumentTypes(
  client: Pick<pg.PoolClient, 'query'>,
  tenantId: string,
  companyId: string,
): Promise<number> {
  let added = 0;
  for (const type of STANDARD_TYPES) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO people.document_type
         (tenant_id, company_id, code, name, applies_to, has_expiry, has_number, multi_page, is_system)
       SELECT $1, $2, $3, $4, $5, true, $6, $7, true
       WHERE NOT EXISTS (SELECT 1 FROM people.document_type
                         WHERE company_id = $2 AND code = $3 AND deleted_at IS NULL)
       RETURNING id`,
      [tenantId, companyId, type.code, type.name, type.appliesTo, type.hasNumber, type.multiPage],
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) continue;
    added += 1;
    if (type.required === 'no') continue;
    await client.query(
      `INSERT INTO people.document_requirement (tenant_id, company_id, document_type_id, condition_expr)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, companyId, id, type.required === 'outside' ? 'sponsorship == "outside"' : null],
    );
  }
  return added;
}
