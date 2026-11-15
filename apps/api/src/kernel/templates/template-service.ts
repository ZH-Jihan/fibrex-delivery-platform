/**
 * Template service: which published version of a template applies.
 *
 * Purpose: other modules ask for "template `loan.statement`, language `bn`, company X, today"
 * and get one frozen version to render. Rules, in order:
 *   1. only published, undeleted versions whose `valid_from` has arrived are candidates;
 *   2. the requested language wins; if none exists, English (`en`) is used;
 *   3. within a language, a version made for this company beats a tenant-wide one;
 *   4. then the newest `valid_from`, then the highest version number.
 * Runs inside the caller's unit of work (row-level security applies).
 *
 * Depends on: kernel/db unit of work. Used by: ./template-router.ts, the PDF worker (2.7b).
 */
import type { Db } from '../db/prisma.js';
import { currentUnit } from '../db/unit-of-work.js';
import { NotFoundError } from '../http/errors.js';

export type TemplateRow = NonNullable<Awaited<ReturnType<Db['template']['findFirst']>>>;
export type TemplateVersionRow = NonNullable<
  Awaited<ReturnType<Db['templateVersion']['findFirst']>>
>;

export interface ResolveOptions {
  language: string;
  companyId: string;
  /** The day the document is for; defaults to today. */
  onDate?: Date;
}

export class TemplateService {
  /** The version to render, plus its template; NotFoundError when nothing is published. */
  async resolve(
    key: string,
    options: ResolveOptions,
  ): Promise<{ template: TemplateRow; version: TemplateVersionRow }> {
    const { db } = currentUnit();
    const template = await db.template.findFirst({ where: { key, deletedAt: null } });
    if (template === null) throw new NotFoundError(`No template "${key}".`);
    const onDate = options.onDate ?? new Date();
    const candidates = await db.templateVersion.findMany({
      where: {
        templateId: template.id,
        status: 'published',
        deletedAt: null,
        validFrom: { lte: onDate },
        language: { in: [options.language, 'en'] },
        OR: [{ companyId: null }, { companyId: options.companyId }],
      },
    });
    const rank = (v: TemplateVersionRow): [number, number, number, number] => [
      v.language === options.language ? 1 : 0,
      v.companyId === null ? 0 : 1,
      v.validFrom.getTime(),
      v.versionNo,
    ];
    candidates.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      for (let i = 0; i < ra.length; i += 1) {
        const diff = (rb[i] ?? 0) - (ra[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    });
    const version = candidates[0];
    if (version === undefined) {
      throw new NotFoundError(`Template "${key}" has no published version for this language.`);
    }
    return { template, version };
  }
}
