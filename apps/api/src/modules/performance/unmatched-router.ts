/**
 * Unmatched riders queue API (phase 4 row 4.5b; PLAN 5.13).
 *
 *   GET  /unmatched-identifiers                        list (status, platform, search)
 *   GET  /unmatched-identifiers/{id}/candidates        employees to link: suggested by the sheet name, or searched
 *   POST /unmatched-identifiers/{id}/link              link the Falcon ID to an existing person
 *   POST /unmatched-identifiers/{id}/create-employee   make an employee from the sheet row, with the ID linked
 *   POST /unmatched-identifiers/{id}/ignore            close the row with a reason
 *   POST /unmatched-identifiers/re-resolve             row 4.5c repair: re-check open rows (see reResolveOpenRows)
 *
 * Linking or creating is one transaction: the platform identifier (type `falcon_id` for Snoonu)
 * is added to the person with a valid-from date (default: the first date the id was seen), the
 * stored `daily_performance` rows of that id that have no person yet are re-stored with the
 * person, and the queue row is marked linked or created. Audit comes from the table triggers
 * (queue row, identifier, employee and every re-stored figure row), so a refused step leaves
 * nothing behind.
 *
 * Business rules:
 *   - One Falcon ID has one holder at a time. Linking is refused (409 `identifier_in_use`)
 *     when another person holds the ID in a period that overlaps the new one (the database
 *     exclusion rule is the last guard).
 *   - A person may hold several Falcon IDs (an old and a new one); each has its own dates.
 *   - `daily_performance` is retire-only: attaching a person retires the old row and stores
 *     a copy with the person, in the same run, on the same date. One current row per person
 *     per date: if the person already has figures for a date under another ID, that date stays
 *     unmatched and is counted in `leftUnmatched` (never silently merged).
 *   - Rows dated before the valid-from date are not attached (the person did not hold the ID).
 *
 * Depends on: express, zod, @fibrex/shared, kernel/db, kernel/http, kernel/permissions,
 * ../party (PartyService), ../people (EmployeeDirectory), ./sync-service.ts (identifierTypeFor).
 * Used by: ./index.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  sheetPhoneToInternational,
  sheetProfessionCode,
  unmatchedCandidatesQuerySchema,
  unmatchedCreateEmployeeSchema,
  unmatchedIgnoreSchema,
  unmatchedLinkSchema,
  unmatchedListQuerySchema,
  UNMATCHED_STATUSES,
} from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../kernel/db/prisma.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../kernel/http/errors.js';
import { registerRoute } from '../../kernel/http/openapi.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import { createAuditService } from '../../kernel/audit/audit-service.js';
import {
  IDENTIFIER_START_UNKNOWN,
  holderOn,
  normaliseIdentifierValue,
  type IdentifierHolder,
  type PartyService,
} from '../party/index.js';
import type { EmployeeCandidate, EmployeeDirectory } from '../people/index.js';
import { identifierTypeFor } from './sync-service.js';

const idParams = z.object({ id: z.uuid() });
const day = z.iso.date();
const END_OF_TIME = '9999-12-31';

const reResolveResult = z
  .object({
    openRowsChecked: z.number().int(),
    identifiersBackdated: z.number().int(),
    figureRowsAttached: z.number().int(),
    rowsLinked: z.number().int(),
    stillOpen: z.number().int(),
  })
  .meta({ id: 'UnmatchedReResolveResult' });

const item = z
  .object({
    id: z.uuid(),
    clientPlatformId: z.uuid(),
    platformCode: z.string(),
    platformName: z.string(),
    externalId: z.string(),
    firstSeen: day,
    lastSeen: day,
    status: z.enum(UNMATCHED_STATUSES),
    /** Sum of orders in the stored figures for this ID. */
    ordersSeen: z.number().int(),
    daysSeen: z.number().int(),
    sheetName: z.string().nullable(),
    sheetPhone: z.string().nullable(),
    sheetProfession: z.string().nullable(),
    sheetPlate: z.string().nullable(),
    sheetZone: z.string().nullable(),
    resolvedPartyId: z.uuid().nullable(),
    resolvedPartyName: z.string().nullable(),
    resolvedOn: day.nullable(),
    ignoreReason: z.string().nullable(),
  })
  .meta({ id: 'UnmatchedIdentifier' });
const page = z
  .object({
    items: z.array(item),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .meta({ id: 'UnmatchedIdentifierPage' });
const candidate = z.object({
  employeeId: z.uuid(),
  partyId: z.uuid(),
  displayName: z.string(),
  employeeCode: z.string(),
  statusCode: z.string(),
  phone: z.string().nullable(),
});
const candidates = z
  .object({ suggested: z.array(candidate), results: z.array(candidate) })
  .meta({ id: 'UnmatchedCandidates' });
const resolved = z
  .object({
    id: z.uuid(),
    status: z.enum(UNMATCHED_STATUSES),
    partyId: z.uuid().nullable(),
    employeeId: z.uuid().nullable(),
    employeeCode: z.string().nullable(),
    validFrom: day.nullable(),
    /** Stored figure rows now attached to the person. */
    attachedRows: z.number().int(),
    /** Rows of this ID left without a person (before the valid-from date, or a clash). */
    leftUnmatched: z.number().int(),
    /** False when the sheet named a zone that is not an organisation zone. */
    zoneMatched: z.boolean().nullable(),
  })
  .meta({ id: 'UnmatchedResolved' });

const toDay = (text: string) => new Date(`${text}T00:00:00.000Z`);
const fromDay = (value: Date) => value.toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

export interface UnmatchedRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  parties: PartyService;
  directory: EmployeeDirectory;
}

type QueueRow = NonNullable<Awaited<ReturnType<Db['unmatchedIdentifier']['findFirst']>>>;

export function createUnmatchedRouter(deps: UnmatchedRouterDeps): Router {
  const { uow, registry, permissions, parties, directory } = deps;
  const audit = createAuditService();
  const router = Router();

  /** The open queue row of this id, or an error. */
  async function openRow(id: string): Promise<QueueRow> {
    const row = await currentUnit().db.unmatchedIdentifier.findFirst({
      where: { id, deletedAt: null },
    });
    if (row === null) throw new NotFoundError();
    if (row.status !== 'open') {
      throw new ConflictError(
        'already_resolved',
        `This ID is already ${row.status}; nothing more to do.`,
      );
    }
    return row;
  }

  async function platformOf(row: QueueRow) {
    const platform = await currentUnit().db.clientPlatform.findFirst({
      where: { id: row.clientPlatformId, deletedAt: null },
      select: { id: true, code: true, name: true },
    });
    if (platform === null) throw new NotFoundError('The platform of this ID no longer exists');
    return platform;
  }

  /**
   * Step 1 of linking: nobody else may hold this ID in a period overlapping [validFrom, open).
   * The same person already holding it is fine (nothing to add). The database exclusion rule
   * still guards the insert; this check only gives a readable message and the holder's name.
   */
  async function checkHolder(
    row: QueueRow,
    idType: string,
    partyId: string,
    validFrom: string,
  ): Promise<'add' | 'held'> {
    const holders = await parties.identifierHolders(
      row.companyId,
      idType,
      [row.externalId],
      validFrom,
      END_OF_TIME,
    );
    const other = holders.find((h) => h.partyId !== partyId);
    if (other !== undefined) {
      const name = (await parties.names([other.partyId])).get(other.partyId) ?? 'another person';
      throw new ConflictError(
        'identifier_in_use',
        `Falcon ID ${row.externalId} is already held by ${name} from ${other.validFrom}${other.validTo === null ? '' : ` to ${other.validTo}`}, which overlaps ${validFrom} onward. End their period first, or pick a later start date.`,
        { holderPartyId: other.partyId, holderName: name },
      );
    }
    return holders.length > 0 ? 'held' : 'add';
  }

  /**
   * Steps 2 and 3: the stored rows of this ID with no person get the person. The table is
   * retire-only, so each row is retired and stored again with the person (same run, same
   * date and figures). Returns how many were attached and how many were left alone.
   */
  async function attachRows(row: QueueRow, partyOn: (date: string) => string | null) {
    const { db, context } = currentUnit();
    const open = await db.dailyPerformance.findMany({
      where: {
        clientPlatformId: row.clientPlatformId,
        externalId: row.externalId,
        partyId: null,
        isCurrent: true,
      },
    });
    // Each date goes to whoever held the id on that date (nobody = stays without a person).
    const eligible = open.flatMap((r) => {
      const partyId = partyOn(fromDay(r.businessDate));
      return partyId === null ? [] : [{ r, partyId }];
    });
    // One current row per person per date: dates where the person already has figures stay
    // unmatched (the person's other ID owns that date).
    const taken = new Set(
      (eligible.length === 0
        ? []
        : await db.dailyPerformance.findMany({
            where: {
              clientPlatformId: row.clientPlatformId,
              partyId: { in: [...new Set(eligible.map((e) => e.partyId))] },
              isCurrent: true,
              businessDate: { in: eligible.map((e) => e.r.businessDate) },
            },
            select: { partyId: true, businessDate: true },
          })
      ).map((r) => `${r.partyId ?? ''}|${fromDay(r.businessDate)}`),
    );
    const move = eligible.filter((e) => !taken.has(`${e.partyId}|${fromDay(e.r.businessDate)}`));
    // Retire first: the partial unique index allows one current row per id and date.
    for (const { r } of move) {
      await db.dailyPerformance.update({
        where: { id_businessDate: { id: r.id, businessDate: r.businessDate } },
        data: { isCurrent: false },
      });
    }
    if (move.length > 0) {
      await db.dailyPerformance.createMany({
        data: move.map(({ r, partyId }) => ({
          tenantId: r.tenantId,
          companyId: r.companyId,
          syncRunId: r.syncRunId,
          clientPlatformId: r.clientPlatformId,
          businessDate: r.businessDate,
          partyId,
          externalId: r.externalId,
          ordersCompleted: r.ordersCompleted,
          loginAt: r.loginAt,
          shiftStart: r.shiftStart,
          lateMinutes: r.lateMinutes,
          workingMinutes: r.workingMinutes,
          onlineMinutes: r.onlineMinutes,
          accepted: r.accepted,
          rejected: r.rejected,
          cancelled: r.cancelled,
          earnings: r.earnings,
          cod: r.cod,
          currency: r.currency,
          metrics: r.metrics as Prisma.InputJsonValue,
          createdBy: context.userId,
        })),
      });
    }
    return { attached: move.length, leftUnmatched: open.length - move.length };
  }

  /** Closes the queue row as linked or created. */
  async function close(
    row: QueueRow,
    status: 'linked' | 'created',
    partyId: string,
  ): Promise<void> {
    await currentUnit().db.unmatchedIdentifier.update({
      where: { id: row.id },
      data: { status, resolvedPartyId: partyId, resolvedOn: toDay(today()) },
    });
  }

  /**
   * Who may receive this row's figures: the holder of the id on each date, from the same
   * lookup the sync uses, limited to `partyId` (linking one person never hands dates to
   * someone else).
   */
  async function holdersOf(row: QueueRow, idType: string, partyId: string) {
    const holders = await parties.identifierHolders(
      row.companyId,
      idType,
      [row.externalId],
      IDENTIFIER_START_UNKNOWN,
      END_OF_TIME,
    );
    return (date: string) => {
      const holder = holderOn(holders, row.externalId, date);
      return holder === partyId ? partyId : null;
    };
  }

  /**
   * Row 4.5c, one-time repair (idempotent): re-resolves the open queue rows against the
   * identifiers that exist now. Before 4.5c the employee import dated a Falcon ID from the
   * import day when the sheet had no joining date, so a sync of earlier days found no holder.
   * In one transaction:
   *   1. For each open row, find every period of its id (the one lookup, `identifierHolders`).
   *   2. A period is moved back to "start unknown" only when all of these hold: its person's
   *      employee was made by the employee import with no joining date; its start is the day
   *      the identifier was written (the old default, never edited by hand; one day either way
   *      for the time zone); and it is the earliest period of that id (nobody held it before,
   *      so the one-holder rule cannot be broken). Anything else is left as it is.
   *   3. The id's stored figure rows without a person get the holder of each date (retire and
   *      copy, same rule as linking: one current row per person per date).
   *   4. A row with no person-less figures left and a holder on its last-seen date is closed as
   *      linked to that holder; otherwise it stays open for a person to decide.
   * Running it again finds nothing more to do. Every change is audited by the table triggers,
   * plus one `repair` audit entry with the counts.
   */
  async function reResolveOpenRows() {
    const { db } = currentUnit();
    const rows = await db.unmatchedIdentifier.findMany({
      where: { status: 'open', deletedAt: null },
      orderBy: { externalId: 'asc' },
    });
    const platforms = new Map(
      (
        await db.clientPlatform.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.clientPlatformId))] } },
          select: { id: true, code: true },
        })
      ).map((p) => [p.id, identifierTypeFor(p.code)]),
    );

    // Step 1: every period of every open id, per company and identifier type.
    const holders: IdentifierHolder[] = [];
    const groups = new Map<string, { companyId: string; idType: string; ids: string[] }>();
    for (const row of rows) {
      const idType = platforms.get(row.clientPlatformId);
      if (idType === undefined) continue;
      const key = `${row.companyId}|${idType}`;
      const group = groups.get(key) ?? { companyId: row.companyId, idType, ids: [] };
      group.ids.push(row.externalId);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      holders.push(
        ...(await parties.identifierHolders(
          group.companyId,
          group.idType,
          group.ids,
          IDENTIFIER_START_UNKNOWN,
          END_OF_TIME,
        )),
      );
    }

    // Step 2: move import-day starts back, only where it is safe (see above).
    const imported = await directory.importedWithoutJoiningDate([
      ...new Set(holders.map((h) => h.partyId)),
    ]);
    const dayDiff = (a: string, b: string) =>
      Math.abs(new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) /
      86_400_000;
    let identifiersBackdated = 0;
    for (const h of holders) {
      if (!imported.has(h.partyId)) continue;
      if (h.validFrom <= IDENTIFIER_START_UNKNOWN || dayDiff(h.validFrom, h.createdOn) > 1)
        continue;
      const earlier = holders.some(
        (o) =>
          o.identifierId !== h.identifierId && o.value === h.value && o.validFrom < h.validFrom,
      );
      if (earlier) continue;
      await parties.moveIdentifierStart(h.identifierId, h.version, IDENTIFIER_START_UNKNOWN);
      h.validFrom = IDENTIFIER_START_UNKNOWN;
      identifiersBackdated += 1;
    }

    // Steps 3 and 4: attach figures to each date's holder, close what is fully resolved.
    let linked = 0;
    let figureRowsAttached = 0;
    for (const row of rows) {
      if (!platforms.has(row.clientPlatformId)) continue;
      const own = holders.filter((h) => h.value === normaliseIdentifierValue(row.externalId));
      if (own.length === 0) continue;
      const moved = await attachRows(row, (date) => holderOn(own, row.externalId, date));
      figureRowsAttached += moved.attached;
      const holder = holderOn(own, row.externalId, fromDay(row.lastSeen));
      if (moved.leftUnmatched === 0 && holder !== null) {
        await close(row, 'linked', holder);
        linked += 1;
      }
    }
    const result = {
      openRowsChecked: rows.length,
      identifiersBackdated,
      figureRowsAttached,
      rowsLinked: linked,
      stillOpen: rows.length - linked,
    };
    await audit.record({
      action: 'repair',
      moduleKey: 'performance',
      entityType: 'performance.unmatched_identifier',
      meta: { repair: 're-resolve-open-rows', ...result },
    });
    return result;
  }

  router.post('/unmatched-identifiers/re-resolve', async (_req, res) => {
    const result = await uow.run(async () => {
      await permissions.require('performance.unmatched.resolve');
      return reResolveOpenRows();
    });
    res.json(result);
  });

  router.get('/unmatched-identifiers', async (req, res) => {
    const query = unmatchedListQuerySchema.parse(req.query);
    const result = await uow.run(async (db) => {
      await permissions.require('performance.unmatched.read');
      const where: Prisma.UnmatchedIdentifierWhereInput = {
        deletedAt: null,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.platform === undefined ? {} : { clientPlatformId: query.platform }),
        ...(query.search === undefined
          ? {}
          : {
              OR: [
                { externalId: { contains: query.search, mode: 'insensitive' } },
                { sheetName: { contains: query.search, mode: 'insensitive' } },
                { sheetPhone: { contains: query.search } },
              ],
            }),
      };
      const [rows, total] = await Promise.all([
        db.unmatchedIdentifier.findMany({
          where,
          orderBy: [{ lastSeen: 'desc' }, { externalId: 'asc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
        db.unmatchedIdentifier.count({ where }),
      ]);
      const platforms = await db.clientPlatform.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.clientPlatformId))] } },
        select: { id: true, code: true, name: true },
      });
      const names = await parties.names(
        rows.flatMap((r) => (r.resolvedPartyId === null ? [] : [r.resolvedPartyId])),
      );
      // Orders and days from the stored figures of these ids (every current row, matched or not).
      const figures =
        rows.length === 0
          ? []
          : await db.dailyPerformance.groupBy({
              by: ['clientPlatformId', 'externalId'],
              where: {
                isCurrent: true,
                externalId: { in: rows.map((r) => r.externalId) },
                clientPlatformId: { in: platforms.map((p) => p.id) },
              },
              _sum: { ordersCompleted: true },
              _count: { _all: true },
            });
      const figureOf = (r: QueueRow) =>
        figures.find(
          (f) => f.clientPlatformId === r.clientPlatformId && f.externalId === r.externalId,
        );
      return {
        items: rows.map((r) => {
          const platform = platforms.find((p) => p.id === r.clientPlatformId);
          const figure = figureOf(r);
          return {
            id: r.id,
            clientPlatformId: r.clientPlatformId,
            platformCode: platform?.code ?? '',
            platformName: platform?.name ?? '',
            externalId: r.externalId,
            firstSeen: fromDay(r.firstSeen),
            lastSeen: fromDay(r.lastSeen),
            status: r.status as (typeof UNMATCHED_STATUSES)[number],
            ordersSeen: figure?._sum.ordersCompleted ?? 0,
            daysSeen: figure?._count._all ?? 0,
            sheetName: r.sheetName,
            sheetPhone: r.sheetPhone,
            sheetProfession: r.sheetProfession,
            sheetPlate: r.sheetPlate,
            sheetZone: r.sheetZone,
            resolvedPartyId: r.resolvedPartyId,
            resolvedPartyName:
              r.resolvedPartyId === null ? null : (names.get(r.resolvedPartyId) ?? null),
            resolvedOn: r.resolvedOn === null ? null : fromDay(r.resolvedOn),
            ignoreReason: r.ignoreReason,
          };
        }),
        total,
        page: query.page,
        pageSize: query.pageSize,
      };
    });
    res.json(result);
  });

  router.get('/unmatched-identifiers/:id/candidates', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const query = unmatchedCandidatesQuerySchema.parse(req.query);
    const result = await uow.run(async (db) => {
      await permissions.require('performance.unmatched.resolve');
      const row = await db.unmatchedIdentifier.findFirst({ where: { id, deletedAt: null } });
      if (row === null) throw new NotFoundError();
      const suggested: EmployeeCandidate[] =
        row.sheetName === null
          ? []
          : await directory.suggestByName(row.companyId, row.sheetName, 5);
      const results: EmployeeCandidate[] =
        query.q === undefined ? [] : await directory.search(row.companyId, query.q, query.limit);
      return { suggested, results };
    });
    res.json(result);
  });

  router.post('/unmatched-identifiers/:id/link', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const body = unmatchedLinkSchema.parse(req.body);
    const result = await uow.run(async () => {
      await permissions.require('performance.unmatched.resolve');
      const row = await openRow(id);
      const platform = await platformOf(row);

      // Who is the person: an employee, or a plain party.
      let partyId: string;
      let employee: EmployeeCandidate | null;
      if (body.employeeId !== undefined) {
        employee = await directory.get(body.employeeId);
        if (employee === null)
          throw new UnprocessableError('employee_not_found', 'No such employee.');
        partyId = employee.partyId;
      } else {
        const party = await parties.get(body.partyId ?? '');
        if (party?.companyId !== row.companyId || party.mergedIntoId !== null) {
          throw new UnprocessableError('party_not_found', 'No such person in this company.');
        }
        partyId = party.id;
        employee = await directory.employeeOfParty(partyId);
      }

      const validFrom = body.validFrom ?? fromDay(row.firstSeen);
      const idType = identifierTypeFor(platform.code);
      if ((await checkHolder(row, idType, partyId, validFrom)) === 'add') {
        await parties.addIdentifier(
          partyId,
          row.companyId,
          idType,
          row.externalId,
          validFrom,
          row.clientPlatformId,
        );
      }
      const moved = await attachRows(row, await holdersOf(row, idType, partyId));
      await close(row, 'linked', partyId);
      return {
        id,
        status: 'linked' as const,
        partyId,
        employeeId: employee?.employeeId ?? null,
        employeeCode: employee?.employeeCode ?? null,
        validFrom,
        attachedRows: moved.attached,
        leftUnmatched: moved.leftUnmatched,
        zoneMatched: null,
      };
    });
    res.json(result);
  });

  router.post('/unmatched-identifiers/:id/create-employee', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const body = unmatchedCreateEmployeeSchema.parse(req.body ?? {});
    const result = await uow.run(async () => {
      await permissions.require('performance.unmatched.resolve');
      await permissions.require('people.employee.create');
      const row = await openRow(id);
      const platform = await platformOf(row);

      const displayName = body.displayName ?? row.sheetName ?? '';
      if (displayName.trim() === '') {
        throw new UnprocessableError(
          'name_required',
          'The sheet gave no name for this ID. Type the name to create the employee.',
        );
      }
      const profession = body.profession ?? sheetProfessionCode(row.sheetProfession);
      if (profession === null) {
        throw new UnprocessableError(
          'profession_required',
          'The sheet does not say clearly whether this is a rider or a driver. Choose one.',
        );
      }
      // A phone typed by the user must be valid; one read from the sheet is used when it can be.
      const typedPhone =
        body.phone === undefined ? undefined : sheetPhoneToInternational(body.phone);
      if (body.phone !== undefined && typedPhone === null) {
        throw new UnprocessableError(
          'phone_invalid',
          'Use an international number, for example +97455550101, or an 8-digit Qatar number.',
        );
      }
      const phone = typedPhone ?? sheetPhoneToInternational(row.sheetPhone);
      const validFrom = body.joiningDate ?? fromDay(row.firstSeen);

      // The ID check comes before anything is written, so a refusal leaves no half-made person.
      // (The new person cannot hold the ID yet, so any holder is "another person".)
      const idType = identifierTypeFor(platform.code);
      await checkHolder(row, idType, '00000000-0000-0000-0000-000000000000', validFrom);

      const created = await directory.create({
        companyId: row.companyId,
        displayName: displayName.trim(),
        phone,
        profession,
        clientPlatformId: row.clientPlatformId,
        zoneName: row.sheetZone,
        joiningDate: validFrom,
        acknowledgeDuplicates: body.acknowledgeDuplicates === true,
      });
      await parties.addIdentifier(
        created.partyId,
        row.companyId,
        idType,
        row.externalId,
        validFrom,
        row.clientPlatformId,
      );
      const moved = await attachRows(row, await holdersOf(row, idType, created.partyId));
      await close(row, 'created', created.partyId);
      return {
        id,
        status: 'created' as const,
        partyId: created.partyId,
        employeeId: created.employeeId,
        employeeCode: created.employeeCode,
        validFrom,
        attachedRows: moved.attached,
        leftUnmatched: moved.leftUnmatched,
        zoneMatched: created.zoneMatched,
      };
    });
    res.status(201).json(result);
  });

  router.post('/unmatched-identifiers/:id/ignore', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const body = unmatchedIgnoreSchema.parse(req.body);
    const result = await uow.run(async (db) => {
      await permissions.require('performance.unmatched.resolve');
      const row = await openRow(id);
      await db.unmatchedIdentifier.update({
        where: { id: row.id },
        data: { status: 'ignored', ignoreReason: body.reason, resolvedOn: toDay(today()) },
      });
      return {
        id,
        status: 'ignored' as const,
        partyId: null,
        employeeId: null,
        employeeCode: null,
        validFrom: null,
        attachedRows: 0,
        leftUnmatched: 0,
        zoneMatched: null,
      };
    });
    res.json(result);
  });

  const tags = ['Unmatched riders'];
  const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
  registerRoute(registry, {
    method: 'get',
    path: '/unmatched-identifiers',
    tags,
    summary: 'Sheet IDs with no person, with what the sheet says about them',
    request: { query: unmatchedListQuerySchema },
    responses: { 200: { description: 'The queue', content: json(page) } },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/unmatched-identifiers/re-resolve',
    tags,
    summary:
      'Re-check every open ID against the identifiers held now and attach their figures (one-time repair, safe to repeat)',
    responses: { 200: { description: 'What the repair did', content: json(reResolveResult) } },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/unmatched-identifiers/{id}/candidates',
    tags,
    summary: 'Employees to link: best name matches first, then a search by name, phone or code',
    request: { params: idParams, query: unmatchedCandidatesQuerySchema },
    responses: { 200: { description: 'Candidates', content: json(candidates) } },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/unmatched-identifiers/{id}/link',
    tags,
    summary: 'Link the ID to an existing person and attach their stored figures',
    request: { params: idParams, body: { content: json(unmatchedLinkSchema) } },
    responses: { 200: { description: 'Linked', content: json(resolved) } },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/unmatched-identifiers/{id}/create-employee',
    tags,
    summary: 'Create an employee from the sheet row, link the ID and attach their figures',
    request: { params: idParams, body: { content: json(unmatchedCreateEmployeeSchema) } },
    responses: { 201: { description: 'Created', content: json(resolved) } },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/unmatched-identifiers/{id}/ignore',
    tags,
    summary: 'Ignore the ID, with a reason',
    request: { params: idParams, body: { content: json(unmatchedIgnoreSchema) } },
    responses: { 200: { description: 'Ignored', content: json(resolved) } },
  });
  return router;
}
