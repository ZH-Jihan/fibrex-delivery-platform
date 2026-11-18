/**
 * Templates API (phase 2 plan row 2.7a): wording with merge fields, versioned.
 *
 *   /templates                              CRUD: a template (key, kind, record type)
 *   /template-versions                      CRUD: the texts; filter templateId, language, status
 *   POST /template-versions/{id}/publish    freeze a draft and retire the version it replaces
 *   POST /template-versions/{id}/preview    render with sample data (HTML; the PDF comes in 2.7b)
 *
 * The plan names the versions route `/templates/:id/versions`; versions are served flat
 * (`/template-versions?templateId=`), like lookup values, so the one CRUD factory gives them
 * the same behaviour as every other resource.
 *
 * Rules on top of the plain permissions, and why:
 *   1. A template's key and kind never change: other modules look templates up by key and
 *      expect the kind they were written for.
 *   2. A new version always starts as a draft and takes the next number for its template and
 *      language. Its body, subject and CSS must compile (checked on every save).
 *   3. Only a draft can be edited or deleted. A published version is frozen because produced
 *      documents name it; change the wording by making a new version.
 *   4. Publishing retires the published version it replaces (same template, language and
 *      company scope). A version that starts in the future replaces only versions that would
 *      start no earlier; the current one stays in force until the new date arrives.
 *   5. A template with live versions is not deleted until they are.
 *
 * Depends on: express, zod, kernel/db, kernel/http, kernel/permissions, ./template-render.
 * Used by: src/main.ts, the recycle bin.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/prisma.js';
import { VersionConflictError } from '../db/optimistic-lock.js';
import { createRepository, type Repository } from '../db/repository.js';
import { currentUnit, type UnitOfWork } from '../db/unit-of-work.js';
import { createCrudRouter, parseIfMatch } from '../http/crud-router.js';
import { ConflictError, UnprocessableError, ValidationError } from '../http/errors.js';
import { problemSchema, registerRoute } from '../http/openapi.js';
import type { PermissionService } from '../permissions/permission-service.js';
import { cssProblem, renderVersion, templateProblem } from './template-render.js';

export type TemplateRow = NonNullable<Awaited<ReturnType<Db['template']['findFirst']>>>;
export type TemplateVersionRow = NonNullable<
  Awaited<ReturnType<Db['templateVersion']['findFirst']>>
>;

const keyPattern = /^[a-z][a-z0-9_.]{0,59}$/;
const entityKeyPattern = /^[a-z][a-z0-9_]{0,49}(\.[a-z][a-z0-9_]{0,49})?$/;
const kinds = ['pdf', 'email', 'whatsapp', 'sms', 'push'] as const;
const papers = ['A4', 'A5', 'Letter'] as const;

const templateCreate = z.strictObject({
  key: z.string().trim().regex(keyPattern, 'lower-case letters, digits, _ and .'),
  kind: z.enum(kinds),
  entityKey: z.string().trim().regex(entityKeyPattern).nullable().default(null),
  name: z.string().trim().min(1).max(200),
});
const templateUpdate = z
  .strictObject({
    entityKey: z.string().trim().regex(entityKeyPattern).nullable(),
    name: z.string().trim().min(1).max(200),
  })
  .partial();
const templateItem = z
  .object({
    id: z.uuid(),
    key: z.string(),
    kind: z.enum(kinds),
    entityKey: z.string().nullable(),
    name: z.string(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Template' });

const language = z
  .string()
  .trim()
  .regex(/^[a-z]{2,3}$/, 'a language code such as en or bn');
const day = z.iso.date();
const versionCreate = z.strictObject({
  templateId: z.uuid(),
  companyId: z.uuid().nullable().default(null),
  language,
  subject: z.string().max(500).nullable().default(null),
  body: z.string().min(1).max(200_000),
  css: z.string().max(50_000).default(''),
  paper: z.enum(papers).default('A4'),
  validFrom: day.optional(),
  providerTemplateId: z.string().max(200).nullable().default(null),
});
const versionUpdate = z
  .strictObject({
    subject: z.string().max(500).nullable(),
    body: z.string().min(1).max(200_000),
    css: z.string().max(50_000),
    paper: z.enum(papers),
    validFrom: day,
    providerTemplateId: z.string().max(200).nullable(),
  })
  .partial();
const versionItem = z
  .object({
    id: z.uuid(),
    templateId: z.uuid(),
    companyId: z.uuid().nullable(),
    language: z.string(),
    versionNo: z.number().int(),
    subject: z.string().nullable(),
    body: z.string(),
    css: z.string(),
    paper: z.enum(papers),
    status: z.enum(['draft', 'published', 'retired']),
    validFrom: day,
    providerTemplateId: z.string().nullable(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'TemplateVersion' });
const versionFilter = z.object({
  templateId: z.uuid().optional(),
  language: language.optional(),
  status: z.enum(['draft', 'published', 'retired']).optional(),
});

const previewBody = z.strictObject({
  data: z.record(z.string(), z.unknown()).default({}),
});
const previewResult = z
  .object({ subject: z.string().nullable(), body: z.string(), html: z.string() })
  .meta({ id: 'TemplatePreview' });

export function toTemplateItem(row: TemplateRow) {
  return {
    id: row.id,
    key: row.key,
    kind: row.kind,
    entityKey: row.entityKey,
    name: row.name,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

export function toVersionItem(row: TemplateVersionRow) {
  return {
    id: row.id,
    templateId: row.templateId,
    companyId: row.companyId,
    language: row.language,
    versionNo: row.versionNo,
    subject: row.subject,
    body: row.body,
    css: row.css,
    paper: row.paper,
    status: row.status,
    validFrom: row.validFrom.toISOString().slice(0, 10),
    providerTemplateId: row.providerTemplateId,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

const invalid = (path: string, message: string, code: string) =>
  new ValidationError([{ path, message, code }]);

/** Rule 2: the texts of a version must compile. */
function checkTexts(texts: { body?: string; subject?: string | null; css?: string }): void {
  if (texts.body !== undefined) {
    const problem = templateProblem(texts.body);
    if (problem !== undefined) throw invalid('body', problem, 'template_syntax');
  }
  if (texts.subject !== undefined && texts.subject !== null) {
    const problem = templateProblem(texts.subject);
    if (problem !== undefined) throw invalid('subject', problem, 'template_syntax');
  }
  if (texts.css !== undefined) {
    const problem = cssProblem(texts.css);
    if (problem !== undefined) throw invalid('css', problem, 'css_not_allowed');
  }
}

/** The repository behind `/templates` and the recycle bin; adds rules 1 and 5. */
export function createTemplateRepository(): Repository<TemplateRow> {
  const base = createRepository<TemplateRow>({ model: 'template', scope: 'tenant' });
  return {
    ...base,
    softDelete: async (id, version, reason) => {
      const { db } = currentUnit();
      const versions = await db.templateVersion.count({
        where: { templateId: id, deletedAt: null },
      });
      if (versions > 0) {
        throw new ConflictError(
          'template_has_versions',
          'Delete the versions of this template first.',
          {
            versions,
          },
        );
      }
      return base.softDelete(id, version, reason);
    },
  };
}

/** The repository behind `/template-versions` and the recycle bin; adds rules 2 to 4. */
export function createTemplateVersionRepository(): Repository<TemplateVersionRow> {
  const base = createRepository<TemplateVersionRow>({ model: 'templateVersion', scope: 'tenant' });
  return {
    ...base,
    create: async (data) => {
      const body = data as z.infer<typeof versionCreate>;
      checkTexts(body);
      const { db } = currentUnit();
      const template = await db.template.findFirst({
        where: { id: body.templateId, deletedAt: null },
      });
      if (template === null) {
        throw invalid('templateId', 'This template does not exist.', 'unknown_template');
      }
      if (body.companyId !== null) {
        const company = await db.company.findFirst({ where: { id: body.companyId } });
        if (company === null) {
          throw invalid('companyId', 'This company does not exist.', 'unknown_company');
        }
      }
      // The number counts deleted versions too: the unique index does, and a number must
      // never name two different texts. Raw SQL because the soft-delete extension hides
      // deleted rows from Prisma reads (aggregate included).
      const highest = await db.$queryRaw<{ n: number }[]>`
        SELECT coalesce(max(version_no), 0)::int AS n FROM cfg.template_version
         WHERE template_id = ${body.templateId}::uuid AND language = ${body.language}`;
      // Written directly, not through the repository: it treats company_id as a system
      // column and drops it for tenant-wide tables, but here it is a real choice
      // (NULL = every company). The database triggers still stamp the audit columns.
      return db.templateVersion.create({
        data: {
          tenantId: currentUnit().context.tenantId,
          templateId: body.templateId,
          companyId: body.companyId,
          language: body.language,
          versionNo: (highest[0]?.n ?? 0) + 1,
          subject: body.subject,
          body: body.body,
          css: body.css,
          paper: body.paper,
          status: 'draft',
          ...(body.validFrom === undefined ? {} : { validFrom: new Date(body.validFrom) }),
          providerTemplateId: body.providerTemplateId,
        },
      });
    },
    update: async (id, version, changes) => {
      const current = await base.get(id);
      if (current.status !== 'draft') {
        throw new UnprocessableError(
          'template_version_frozen',
          'A published version cannot be edited; make a new version.',
        );
      }
      const body = changes as z.infer<typeof versionUpdate>;
      checkTexts(body);
      return base.update(id, version, {
        ...body,
        ...(body.validFrom === undefined ? {} : { validFrom: new Date(body.validFrom) }),
      });
    },
    softDelete: async (id, version, reason) => {
      const current = await base.get(id);
      if (current.status === 'published') {
        throw new UnprocessableError(
          'template_version_published',
          'A published version cannot be deleted; publish its replacement first.',
        );
      }
      return base.softDelete(id, version, reason);
    },
  };
}

export interface TemplateRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
}

export function createTemplateRouter(deps: TemplateRouterDeps): Router {
  const { uow, registry, permissions } = deps;
  const router = Router();
  const crud = { uow, authorize: permissions.authorize, registry };
  const versions = createTemplateVersionRepository();
  const idParams = z.object({ id: z.uuid() });
  const tags = ['Templates'];

  router.use(
    createCrudRouter<TemplateRow>(crud, {
      path: '/templates',
      resource: 'platform.template',
      tag: 'Templates',
      repository: createTemplateRepository(),
      schemas: { create: templateCreate, update: templateUpdate, item: templateItem },
      toItem: toTemplateItem,
    }),
  );
  router.use(
    createCrudRouter<TemplateVersionRow>(crud, {
      path: '/template-versions',
      resource: 'platform.template_version',
      tag: 'Templates',
      repository: versions,
      schemas: {
        create: versionCreate,
        update: versionUpdate,
        item: versionItem,
        filter: versionFilter,
      },
      toItem: toVersionItem,
      toWhere: (filter) => filter,
    }),
  );

  router.post('/template-versions/:id/publish', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const expected = parseIfMatch(req.get('If-Match'));
    try {
      const row = await uow.run(async () => {
        await permissions.require('platform.template_version.publish');
        const current = await versions.get(id);
        if (current.status !== 'draft') {
          throw new UnprocessableError(
            'template_version_not_draft',
            'Only a draft can be published.',
          );
        }
        const { db } = currentUnit();
        // Rule 4: retire what this version replaces (same template, language, company scope).
        await db.templateVersion.updateMany({
          where: {
            templateId: current.templateId,
            language: current.language,
            companyId: current.companyId,
            status: 'published',
            deletedAt: null,
            ...(current.validFrom.getTime() <= Date.now()
              ? {}
              : { validFrom: { gte: current.validFrom } }),
          },
          data: { status: 'retired' },
        });
        return versions.update(id, expected, { status: 'published' });
      });
      res
        .status(200)
        .setHeader('ETag', `"${String(row.version)}"`)
        .json(toVersionItem(row));
    } catch (err) {
      if (err instanceof VersionConflictError) {
        throw err.presentedWith((row) => toVersionItem(row as unknown as TemplateVersionRow));
      }
      throw err;
    }
  });

  router.post('/template-versions/:id/preview', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const body = previewBody.parse(req.body);
    const result = await uow.run(async () => {
      await permissions.require('platform.template_version.preview');
      const version = await versions.get(id);
      const { db } = currentUnit();
      const template = await db.template.findFirst({ where: { id: version.templateId } });
      try {
        return renderVersion(
          {
            kind: template?.kind ?? 'pdf',
            subject: version.subject,
            body: version.body,
            css: version.css,
            paper: version.paper,
          },
          body.data,
        );
      } catch (err) {
        throw new UnprocessableError(
          'template_render_failed',
          err instanceof Error ? err.message : 'The template could not be rendered.',
        );
      }
    });
    res.json(result);
  });

  const problem = (description: string) => ({
    description,
    content: { 'application/problem+json': { schema: problemSchema } },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/template-versions/{id}/publish',
    tags,
    summary: 'Publish a draft version and retire the one it replaces (If-Match required)',
    request: { params: idParams },
    responses: {
      200: {
        description: 'The published version',
        content: { 'application/json': { schema: versionItem } },
      },
      404: problem('No such version'),
      409: problem('Version conflict'),
      422: problem('Not a draft'),
    },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/template-versions/{id}/preview',
    tags,
    summary: 'Render a version with sample data (HTML)',
    request: {
      params: idParams,
      body: { content: { 'application/json': { schema: previewBody } } },
    },
    responses: {
      200: {
        description: 'The rendered text and HTML',
        content: { 'application/json': { schema: previewResult } },
      },
      404: problem('No such version'),
      422: problem('The template could not be rendered'),
    },
  });

  return router;
}
