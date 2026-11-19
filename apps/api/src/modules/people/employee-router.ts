/**
 * Employees API (PLAN 5.12): the employment master on top of the party model.
 *
 *   /employees                         CRUD factory (list, read, create, update, delete, restore)
 *   POST /employees/duplicate-check    who already has this QID, passport or phone
 *
 * Creating an employee, step by step (one transaction, so nothing is left half made):
 *   1. The person: either an existing party (`partyId`, a live person of the same company
 *      that is not an employee yet) or a new one (`person`).
 *   2. For a new person, look for the same QID, passport or phone in the company first.
 *      Same QID or passport: refused (409 identity_in_use) with the holder, because one
 *      document number cannot belong to two people; link the existing party instead.
 *      Same phone only: refused (409 possible_duplicate) unless the caller acknowledges it,
 *      because family members do share phones.
 *   3. Create the party, its phones, WhatsApp, e-mail, QID and passport (sealed, hashed and
 *      masked by the party module), then score duplicates by name and birth date.
 *   4. Give the party the `employee` role from the joining date.
 *   5. Take the next employee code (number sequence `employee`, E0001 ...) in this
 *      transaction, so a failed create gives the number back.
 *   6. Start in the initial state of the `people.employee` machine (`active` when no
 *      machine exists yet) and write the first state history row.
 *   7. Open the first employment period and, when given, the first placement.
 *   8. Tell the workflow engine (an "on create" workflow that cannot start fails the create).
 *
 * Other rules:
 *   - `statusCode` is never accepted in a body: the state service moves it (POST
 *     /transitions/people.employee/{id}) with dated history.
 *   - Switching sponsorship to `company` clears the sponsor; a sponsor needs `outside`.
 *   - Lists carry the person's name from the party module; `q` searches name and code.
 *
 * Depends on: express, zod, @fibrex/shared (people schemas), kernel/db, kernel/http,
 * kernel/numbering, kernel/states (initial state), modules/party (PartyService through its
 * index), ./placement-router.ts (first period and placement). Used by: ./index.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  employeeCreateSchema,
  employeeDuplicateCheckSchema,
  employeeUpdateSchema,
  type EmployeeCreateInput,
  type EmployeeDuplicateCheckInput,
} from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../../kernel/db/prisma.js';
import { createRepository, type Repository } from '../../kernel/db/repository.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { createCrudRouter } from '../../kernel/http/crud-router.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  UnprocessableError,
} from '../../kernel/http/errors.js';
import { registerRoute } from '../../kernel/http/openapi.js';
import type { NumberingService } from '../../kernel/numbering/numbering-service.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import type { StateService } from '../../kernel/states/state-service.js';
import type { PartyService } from '../party/index.js';
import { fromDate, isoToday, toDate } from './dates.js';
import { createPeriodRepository, createPlacementRepository } from './placement-router.js';

export type EmployeeRow = NonNullable<Awaited<ReturnType<Db['employee']['findFirst']>>>;
/** A row with the person's name, read from the party module for responses. */
export type EmployeeView = EmployeeRow & { displayName?: string };

export const EMPLOYEE_ENTITY = 'people.employee';
export const EMPLOYEE_NUMBER_KEY = 'employee';
/** Owner's choice (phase 3 plan, question 4): E0001, E0002 ... editable in Numbering. */
export const EMPLOYEE_NUMBER_DEFAULTS = { format: 'E{0000}', padding: 4 } as const;
const FALLBACK_STATUS = 'active';

const date = z.iso.date();
const employeeFilter = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  statusCode: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,39}$/)
    .optional(),
  sponsorship: z.enum(['company', 'outside']).optional(),
  partyId: z.uuid().optional(),
});
const employeeItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    branchId: z.uuid().nullable(),
    partyId: z.uuid(),
    displayName: z.string(),
    employeeCode: z.string(),
    statusCode: z.string(),
    sponsorship: z.string(),
    sponsorPartyId: z.uuid().nullable(),
    recruitingAgentPartyId: z.uuid().nullable(),
    joiningDate: date.nullable(),
    customFields: z.record(z.string(), z.unknown()),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Employee' });

const matchItem = z.object({
  partyId: z.uuid(),
  displayName: z.string(),
  reasons: z.array(z.enum(['qid', 'passport', 'phone'])),
  employeeId: z.uuid().nullable(),
  employeeCode: z.string().nullable(),
});
const duplicateCheckResponse = z
  .object({ matches: z.array(matchItem) })
  .meta({ id: 'EmployeeDuplicateCheck' });

export function toEmployeeItem(row: EmployeeView) {
  return {
    id: row.id,
    companyId: row.companyId,
    branchId: row.branchId,
    partyId: row.partyId,
    displayName: row.displayName ?? '',
    employeeCode: row.employeeCode,
    statusCode: row.statusCode,
    sponsorship: row.sponsorship,
    sponsorPartyId: row.sponsorPartyId,
    recruitingAgentPartyId: row.recruitingAgentPartyId,
    joiningDate: fromDate(row.joiningDate),
    customFields: row.customFields as Record<string, unknown>,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

/** The company of a new row: named in the body, or the session's only company. */
export function companyFor(requested: string | undefined): string {
  const { context } = currentUnit();
  const id = requested ?? (context.companyIds.length === 1 ? context.companyIds[0] : undefined);
  if (id === undefined) {
    throw new BadRequestError('company_required', 'State which company this belongs to.');
  }
  if (!context.companyIds.includes(id)) {
    throw new ForbiddenError('You do not have access to this company');
  }
  return id;
}

export interface EmployeeServiceDeps {
  parties: PartyService;
  numbering: NumberingService;
  states?: Pick<StateService, 'initialCode' | 'recordStart'>;
  /** Workflow engine hook (step 8). */
  onCreated?: (entityType: string, id: string) => Promise<void>;
}

type DuplicateMatch = z.infer<typeof matchItem>;

/** Matches for the duplicate check, with the employee record when the party has one. */
async function duplicateMatches(
  parties: PartyService,
  input: EmployeeDuplicateCheckInput & { companyId: string },
): Promise<DuplicateMatch[]> {
  const matches = await parties.findMatches(input);
  if (matches.length === 0) return [];
  const employees = await currentUnit().db.employee.findMany({
    where: { companyId: input.companyId, partyId: { in: matches.map((m) => m.partyId) } },
    select: { id: true, partyId: true, employeeCode: true },
  });
  return matches.map((m) => {
    const employee = employees.find((e) => e.partyId === m.partyId);
    return { ...m, employeeId: employee?.id ?? null, employeeCode: employee?.employeeCode ?? null };
  });
}

/** Adds the person's name to rows for responses. */
async function withNames(parties: PartyService, rows: EmployeeRow[]): Promise<EmployeeView[]> {
  const names = await parties.names(rows.map((r) => r.partyId));
  return rows.map((r) => ({ ...r, displayName: names.get(r.partyId) ?? '' }));
}

export function createEmployeeRepository(deps: EmployeeServiceDeps): Repository<EmployeeView> {
  const { parties, numbering, states } = deps;
  const base = createRepository<EmployeeRow>({ model: 'employee', scope: 'company' });
  const periods = createPeriodRepository();
  const placements = createPlacementRepository();
  const named = async (row: EmployeeRow): Promise<EmployeeView> =>
    (await withNames(parties, [row]))[0] ?? row;

  /** Steps 1 to 3: the party id of the employee-to-be. */
  async function personFor(body: EmployeeCreateInput, companyId: string): Promise<string> {
    if (body.partyId !== undefined) {
      const party = await parties.get(body.partyId);
      if (party?.companyId !== companyId || party.mergedIntoId !== null) {
        throw new UnprocessableError('party_not_found', 'No such person in this company.');
      }
      if (party.kind !== 'person') {
        throw new UnprocessableError('not_a_person', 'An organisation cannot be an employee.');
      }
      const existing = await currentUnit().db.employee.findFirst({
        where: { companyId, partyId: party.id, deletedAt: null },
        select: { employeeCode: true },
      });
      if (existing !== null) {
        throw new ConflictError(
          'already_employee',
          `This person is already employee ${existing.employeeCode}.`,
        );
      }
      return party.id;
    }
    const person = body.person;
    if (person === undefined) throw new BadRequestError('person_required', 'Give a person.');
    const phones = [
      ...(person.phones ?? []),
      ...(person.whatsapp === undefined ? [] : [person.whatsapp]),
    ];
    // Step 2.
    const matches = await duplicateMatches(parties, {
      companyId,
      qid: person.qid,
      passport: person.passport,
      phones,
    });
    const sameDocument = matches.filter((m) => m.reasons.some((r) => r !== 'phone'));
    if (sameDocument.length > 0) {
      throw new ConflictError(
        'identity_in_use',
        'A person with this QID or passport already exists. Link that person instead.',
        { matches: sameDocument },
      );
    }
    if (matches.length > 0 && body.acknowledgeDuplicates !== true) {
      throw new ConflictError(
        'possible_duplicate',
        'A person with the same phone number exists. Check, then confirm to go ahead.',
        { matches },
      );
    }
    // Step 3.
    const party = await parties.createPerson({
      companyId,
      displayName: person.displayName,
      names: person.names,
      dateOfBirth: person.dateOfBirth,
      gender: person.gender,
      nationalityCode: person.nationalityCode,
    });
    for (const [index, phone] of [...new Set(person.phones ?? [])].entries()) {
      await parties.addContact(party.id, companyId, 'phone', phone, index === 0);
    }
    if (person.whatsapp !== undefined) {
      await parties.addContact(party.id, companyId, 'whatsapp', person.whatsapp, true);
    }
    if (person.email !== undefined) {
      await parties.addContact(party.id, companyId, 'email', person.email, true);
    }
    if (person.qid !== undefined)
      await parties.addIdentifier(party.id, companyId, 'qid', person.qid);
    if (person.passport !== undefined) {
      await parties.addIdentifier(party.id, companyId, 'passport', person.passport);
    }
    await parties.scanDuplicates(party.id);
    return party.id;
  }

  return {
    list: async (options) => {
      const page = await base.list(options);
      return { ...page, items: await withNames(parties, page.items) };
    },
    get: async (id) => named(await base.get(id)),
    create: async (data) => {
      const body = data as EmployeeCreateInput;
      const companyId = companyFor(body.companyId);
      const partyId = await personFor(body, companyId);
      const start = body.joiningDate ?? isoToday();
      // Step 4.
      await parties.ensureRole(partyId, companyId, 'employee', start);
      // Step 5.
      const { number } = await numbering.allocate(EMPLOYEE_NUMBER_KEY, {
        companyId,
        defaults: EMPLOYEE_NUMBER_DEFAULTS,
      });
      // Step 6.
      const statusCode = (await states?.initialCode(EMPLOYEE_ENTITY)) ?? FALLBACK_STATUS;
      const row = await base.create({
        companyId,
        partyId,
        employeeCode: number,
        statusCode,
        branchId: body.branchId ?? null,
        sponsorship: body.sponsorship ?? 'company',
        sponsorPartyId: body.sponsorPartyId ?? null,
        recruitingAgentPartyId: body.recruitingAgentPartyId ?? null,
        joiningDate: body.joiningDate == null ? null : toDate(body.joiningDate),
        customFields: body.customFields ?? {},
      });
      if (states !== undefined && (await states.initialCode(EMPLOYEE_ENTITY)) !== null) {
        await states.recordStart(EMPLOYEE_ENTITY, row.id, companyId, statusCode);
      }
      // Step 7.
      await periods.create({ companyId, employeeId: row.id, startDate: start });
      if (body.placement !== undefined) {
        await placements.create({
          ...body.placement,
          companyId,
          employeeId: row.id,
          validFrom: body.placement.validFrom ?? start,
        });
      }
      // Step 8.
      await deps.onCreated?.(EMPLOYEE_ENTITY, row.id);
      return named(row);
    },
    update: async (id, version, changes) => {
      const next: Record<string, unknown> = { ...changes };
      if ('joiningDate' in next) {
        next.joiningDate = typeof next.joiningDate === 'string' ? toDate(next.joiningDate) : null;
      }
      if (next.sponsorship === 'company') {
        next.sponsorPartyId = null;
      } else if (typeof next.sponsorPartyId === 'string' && next.sponsorship === undefined) {
        const current = await base.get(id);
        if (current.sponsorship !== 'outside') {
          throw new UnprocessableError(
            'sponsor_needs_outside',
            'A sponsor is named only for an outside sponsorship.',
          );
        }
      }
      return named(await base.update(id, version, next));
    },
    softDelete: async (id, version, reason) => named(await base.softDelete(id, version, reason)),
    restore: async (id, version) => named(await base.restore(id, version)),
  };
}

export interface EmployeeRouterDeps extends EmployeeServiceDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  repository: Repository<EmployeeView>;
}

export function createEmployeeRouter(deps: EmployeeRouterDeps): Router {
  const { uow, registry, permissions, parties, repository } = deps;
  const router = Router();

  // Registered before the factory so "duplicate-check" is not read as an id.
  router.post('/employees/duplicate-check', async (req, res) => {
    const body = employeeDuplicateCheckSchema.parse(req.body);
    const matches = await uow.run(async () => {
      await permissions.require('people.employee.create');
      return duplicateMatches(parties, { ...body, companyId: companyFor(body.companyId) });
    });
    res.json({ matches });
  });

  router.use(
    createCrudRouter(
      { uow, authorize: permissions.authorize, registry },
      {
        path: '/employees',
        resource: 'people.employee',
        tag: 'Employees',
        repository,
        schemas: {
          create: employeeCreateSchema,
          update: employeeUpdateSchema,
          item: employeeItem,
          filter: employeeFilter,
        },
        toItem: toEmployeeItem,
        toWhere: (f) => {
          const { q, statusCode, sponsorship, partyId } = f as z.infer<typeof employeeFilter>;
          return {
            ...(statusCode === undefined ? {} : { statusCode }),
            ...(sponsorship === undefined ? {} : { sponsorship }),
            ...(partyId === undefined ? {} : { partyId }),
            ...(q === undefined
              ? {}
              : {
                  OR: [
                    { employeeCode: { contains: q, mode: 'insensitive' } },
                    { party: { displayName: { contains: q, mode: 'insensitive' } } },
                  ],
                }),
          };
        },
      },
    ),
  );

  registerRoute(registry, {
    method: 'post',
    path: '/employees/duplicate-check',
    tags: ['Employees'],
    summary: 'People who already have this QID, passport or phone',
    request: {
      body: { content: { 'application/json': { schema: employeeDuplicateCheckSchema } } },
    },
    responses: {
      200: {
        description: 'Matches',
        content: { 'application/json': { schema: duplicateCheckResponse } },
      },
    },
  });
  return router;
}
