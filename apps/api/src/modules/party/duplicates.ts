/**
 * Duplicate detection and review.
 *
 * Purpose: a person or organisation must exist once (SPEC 2.8). After every create or
 * change of a party, `detectDuplicates` compares it with the other live parties of the
 * same company and records likely matches in party_duplicate_candidate, where staff
 * review them (dismiss, or merge in ./merge.ts).
 *
 * How a match is scored (why: names alone are weak, a shared phone or birth date makes
 * them strong, and a wrong merge is costly, so only likely pairs are listed):
 *   - same phone / WhatsApp / e-mail on both parties        0.75
 *   - similar name (trigram similarity >= 0.5)              similarity x 0.8
 *   - similar name AND same date of birth                   0.9 (at least)
 *   - two or more independent reasons                       +0.1 (never above 1)
 * A pair is listed from 0.6 upwards. A pair staff already dismissed stays dismissed.
 * The same identifier (QID, Falcon ID) on two parties is not scored here: the database
 * refuses it outright in overlapping periods (party_identifier_no_overlap).
 *
 * Depends on: kernel/db, kernel/permissions. Used by: ./party-router.ts, ./merge.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../../kernel/db/prisma.js';
import type { UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { NotFoundError } from '../../kernel/http/errors.js';
import { registerRoute } from '../../kernel/http/openapi.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';

export const DUPLICATE_LIST_THRESHOLD = 0.6;
const NAME_SIMILARITY_MIN = 0.5;

interface Reason {
  code: 'same_contact' | 'similar_name' | 'same_birth_date';
  detail: string;
}

interface Match {
  score: number;
  reasons: Reason[];
}

function addMatch(found: Map<string, Match>, otherId: string, score: number, reason: Reason): void {
  const match = found.get(otherId) ?? { score: 0, reasons: [] };
  match.score = Math.max(match.score, score);
  match.reasons.push(reason);
  found.set(otherId, match);
}

/** Compares one party with the rest of its company and records the likely matches. */
export async function detectDuplicates(db: Db, partyId: string): Promise<number> {
  const party = await db.party.findFirst({ where: { id: partyId, mergedIntoId: null } });
  if (party === null) return 0;
  const found = new Map<string, Match>();

  // 1. Shared contact values.
  const contacts = await db.partyContact.findMany({
    where: { partyId },
    select: { kind: true, value: true },
  });
  for (const contact of contacts) {
    const others = await db.partyContact.findMany({
      where: {
        companyId: party.companyId,
        kind: contact.kind,
        value: contact.value,
        partyId: { not: partyId },
        party: { deletedAt: null, mergedIntoId: null },
      },
      select: { partyId: true },
    });
    for (const other of others) {
      addMatch(found, other.partyId, 0.75, {
        code: 'same_contact',
        detail: `Same ${contact.kind}`,
      });
    }
  }

  // 2. Similar names (pg_trgm), and whether the birth date agrees.
  const similar = await db.$queryRaw<{ id: string; sim: number; date_of_birth: Date | null }[]>`
    SELECT id, similarity(display_name, ${party.displayName})::float8 AS sim, date_of_birth
      FROM party.party
     WHERE company_id = ${party.companyId}::uuid
       AND id <> ${party.id}::uuid
       AND kind = ${party.kind}
       AND deleted_at IS NULL
       AND merged_into_id IS NULL
       AND display_name % ${party.displayName}`;
  for (const row of similar) {
    if (row.sim < NAME_SIMILARITY_MIN) continue;
    const sameBirth =
      party.dateOfBirth !== null &&
      row.date_of_birth !== null &&
      party.dateOfBirth.getTime() === row.date_of_birth.getTime();
    addMatch(found, row.id, row.sim * 0.8, {
      code: 'similar_name',
      detail: `Names are ${String(Math.round(row.sim * 100))}% alike`,
    });
    if (sameBirth) {
      addMatch(found, row.id, 0.9, { code: 'same_birth_date', detail: 'Same date of birth' });
    }
  }

  // 3. Record the pairs worth a person's attention.
  let recorded = 0;
  for (const [otherId, match] of found) {
    const independent = new Set(match.reasons.map((r) => (r.code === 'same_contact' ? 'c' : 'n')))
      .size;
    const score = Math.min(1, match.score + (independent > 1 ? 0.1 : 0));
    if (score < DUPLICATE_LIST_THRESHOLD) continue;
    const [a, b] = partyId < otherId ? [partyId, otherId] : [otherId, partyId];
    const existing = await db.partyDuplicateCandidate.findFirst({
      where: { partyAId: a, partyBId: b },
    });
    const rounded = Math.round(score * 1000) / 1000;
    if (existing === null) {
      await db.partyDuplicateCandidate.create({
        data: {
          tenantId: party.tenantId,
          companyId: party.companyId,
          partyAId: a,
          partyBId: b,
          score: rounded,
          reasons: match.reasons as unknown as object[],
        },
      });
      recorded += 1;
    } else if (existing.status === 'open') {
      await db.partyDuplicateCandidate.update({
        where: { id: existing.id },
        data: { score: rounded, reasons: match.reasons as unknown as object[] },
      });
    }
    // dismissed or merged: a person already decided, so it is left alone.
  }
  return recorded;
}

const idParams = z.object({ id: z.uuid() });
const listQuery = z.object({
  status: z.enum(['open', 'dismissed', 'merged']).default('open'),
  partyId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
const dismissBody = z.strictObject({ version: z.number().int().min(1) });
const partyRef = z.object({ id: z.uuid(), displayName: z.string(), kind: z.string() });
const candidateItem = z
  .object({
    id: z.uuid(),
    partyA: partyRef,
    partyB: partyRef,
    score: z.number(),
    reasons: z.array(z.object({ code: z.string(), detail: z.string() })),
    status: z.string(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'PartyDuplicate' });

export interface DuplicateRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
}

export function createDuplicateRouter(deps: DuplicateRouterDeps): Router {
  const { uow, registry, permissions } = deps;
  const router = Router();

  router.get('/party-duplicates', async (req, res) => {
    const query = listQuery.parse(req.query);
    const result = await uow.run(async (db) => {
      await permissions.require('party.duplicate.read');
      const where = {
        status: query.status,
        ...(query.partyId === undefined
          ? {}
          : { OR: [{ partyAId: query.partyId }, { partyBId: query.partyId }] }),
      };
      const rows = await db.partyDuplicateCandidate.findMany({
        where,
        include: {
          partyA: { select: { id: true, displayName: true, kind: true } },
          partyB: { select: { id: true, displayName: true, kind: true } },
        },
        orderBy: [{ score: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      });
      const total = await db.partyDuplicateCandidate.count({ where });
      return { rows, total };
    });
    res.json({
      items: result.rows.map((row) => ({
        id: row.id,
        partyA: row.partyA,
        partyB: row.partyB,
        score: Number(row.score),
        reasons: row.reasons,
        status: row.status,
        version: row.version,
        createdAt: row.createdAt.toISOString(),
      })),
      total: result.total,
      page: query.page,
      pageSize: query.pageSize,
    });
  });

  router.post('/party-duplicates/:id/dismiss', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { version } = dismissBody.parse(req.body);
    await uow.run(async (db) => {
      await permissions.require('party.duplicate.update');
      // One statement checks the version and writes, like every other change.
      const rows = await db.partyDuplicateCandidate.updateManyAndReturn({
        where: { id, version, status: 'open' },
        data: { status: 'dismissed' },
      });
      if (rows.length === 0) throw new NotFoundError('No open duplicate with that version');
    });
    res.status(204).end();
  });

  router.post('/parties/:id/detect-duplicates', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const recorded = await uow.run(async (db) => {
      await permissions.require('party.duplicate.update');
      const party = await db.party.findFirst({ where: { id }, select: { id: true } });
      if (party === null) throw new NotFoundError();
      return detectDuplicates(db, id);
    });
    res.json({ newCandidates: recorded });
  });

  registerRoute(registry, {
    method: 'get',
    path: '/party-duplicates',
    tags: ['Party duplicates'],
    summary: 'Likely duplicate parties, best match first',
    request: { query: listQuery },
    responses: {
      200: {
        description: 'One page',
        content: {
          'application/json': {
            schema: z.object({
              items: z.array(candidateItem),
              total: z.number().int(),
              page: z.number().int(),
              pageSize: z.number().int(),
            }),
          },
        },
      },
    },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/party-duplicates/{id}/dismiss',
    tags: ['Party duplicates'],
    summary: 'Say these two are not the same party',
    request: {
      params: idParams,
      body: { content: { 'application/json': { schema: dismissBody } } },
    },
    responses: { 204: { description: 'Dismissed' } },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/parties/{id}/detect-duplicates',
    tags: ['Party duplicates'],
    summary: 'Look for duplicates of one party now',
    request: { params: idParams },
    responses: {
      200: {
        description: 'How many new candidates were found',
        content: { 'application/json': { schema: z.object({ newCandidates: z.number().int() }) } },
      },
    },
  });
  return router;
}
