/**
 * Employee directory: the people module's service interface for other modules (SPEC 2.13).
 *
 * Purpose: lets the performance module's unmatched riders queue find an employee to link
 * (search by name, phone or code, and the best name matches for a sheet name) and create an
 * employee from sheet details, without importing anything of the people module but this
 * service. Employees are always created through the same repository the API uses, so the
 * numbering, status, first employment period, placement and audit rules are the same.
 * Depends on: ./employee-router.ts (repository), kernel/db, @fibrex/shared (types).
 * Used by: ./index.ts (exported), src/main.ts (passed to the performance module).
 * Every method runs inside the caller's unit of work (it uses `currentUnit()`).
 */
import type { EmployeeCreateInput } from '@fibrex/shared';
import type { Repository } from '../../kernel/db/repository.js';
import { currentUnit } from '../../kernel/db/unit-of-work.js';
import type { EmployeeView } from './employee-router.js';

export interface EmployeeCandidate {
  employeeId: string;
  partyId: string;
  displayName: string;
  employeeCode: string;
  statusCode: string;
  /** The primary phone, when the person has one. */
  phone: string | null;
}

export interface NewEmployeeFromSheet {
  companyId: string;
  displayName: string;
  /** International form (+974...), or null to add no phone. */
  phone: string | null;
  /** A code of the `profession` lookup. */
  profession: string;
  clientPlatformId: string;
  /** Zone as the sheet names it; matched to an organisation unit of kind zone by name. */
  zoneName: string | null;
  joiningDate: string;
  acknowledgeDuplicates: boolean;
}

export interface CreatedEmployee {
  employeeId: string;
  partyId: string;
  employeeCode: string;
  /** False when a zone was named but no organisation zone has that name; null when none was named. */
  zoneMatched: boolean | null;
}

export interface EmployeeDirectory {
  /** Live employees whose name, code or phone contains `q`. */
  search(companyId: string, q: string, limit: number): Promise<EmployeeCandidate[]>;
  /** Employees whose name shares words with `name`, best first. */
  suggestByName(companyId: string, name: string, limit: number): Promise<EmployeeCandidate[]>;
  /** The employee record of this person, when there is one. */
  employeeOfParty(partyId: string): Promise<EmployeeCandidate | null>;
  /** One employee by id. */
  get(employeeId: string): Promise<EmployeeCandidate | null>;
  create(input: NewEmployeeFromSheet): Promise<CreatedEmployee>;
  /**
   * Row 4.5c: of these persons, the ones whose live employee record was made by the employee
   * import with no joining date (their platform ids were dated from the import day before the
   * fix, see employee-import.ts `falconStart`). Used only by the one-time unmatched repair.
   */
  importedWithoutJoiningDate(partyIds: readonly string[]): Promise<Set<string>>;
}

/** Lower-case words of three or more letters or digits. */
function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).slice(0, 12);
}

interface Row {
  id: string;
  partyId: string;
  employeeCode: string;
  statusCode: string;
  party: { displayName: string; contacts: { value: string; isPrimary: boolean }[] };
}

const select = {
  id: true,
  partyId: true,
  employeeCode: true,
  statusCode: true,
  party: {
    select: {
      displayName: true,
      contacts: {
        where: { kind: 'phone', deletedAt: null },
        select: { value: true, isPrimary: true },
        orderBy: { isPrimary: 'desc' as const },
      },
    },
  },
};

const toCandidate = (row: Row): EmployeeCandidate => ({
  employeeId: row.id,
  partyId: row.partyId,
  displayName: row.party.displayName,
  employeeCode: row.employeeCode,
  statusCode: row.statusCode,
  phone: row.party.contacts[0]?.value ?? null,
});

export function createEmployeeDirectory(repository: Repository<EmployeeView>): EmployeeDirectory {
  return {
    async search(companyId, q, limit) {
      const digits = q.replace(/[^0-9]/g, '');
      const rows = await currentUnit().db.employee.findMany({
        where: {
          companyId,
          deletedAt: null,
          OR: [
            { employeeCode: { contains: q, mode: 'insensitive' } },
            { party: { displayName: { contains: q, mode: 'insensitive' } } },
            // Phones are stored as +974...; search the digits so "5555 0101" finds them.
            ...(digits.length >= 4
              ? [
                  {
                    party: { contacts: { some: { value: { contains: digits }, deletedAt: null } } },
                  },
                ]
              : []),
          ],
        },
        select,
        orderBy: [{ party: { displayName: 'asc' } }],
        take: limit,
      });
      return rows.map(toCandidate);
    },

    async suggestByName(companyId, name, limit) {
      const wanted = words(name);
      if (wanted.length === 0) return [];
      const rows = await currentUnit().db.employee.findMany({
        where: {
          companyId,
          deletedAt: null,
          OR: wanted.map((w) => ({
            party: { displayName: { contains: w, mode: 'insensitive' as const } },
          })),
        },
        select,
        take: 200,
      });
      // Rank by how many of the sheet's words the name holds; an exact name comes first.
      const exact = name.trim().toLowerCase();
      return rows
        .map((row) => {
          const own = new Set(words(row.party.displayName));
          const score =
            wanted.filter((w) => own.has(w)).length +
            (row.party.displayName.trim().toLowerCase() === exact ? 100 : 0);
          return { row, score };
        })
        .filter((x) => x.score > 0)
        .sort(
          (a, b) =>
            b.score - a.score || a.row.party.displayName.localeCompare(b.row.party.displayName),
        )
        .slice(0, limit)
        .map((x) => toCandidate(x.row));
    },

    async employeeOfParty(partyId) {
      const row = await currentUnit().db.employee.findFirst({
        where: { partyId, deletedAt: null },
        select,
      });
      return row === null ? null : toCandidate(row);
    },

    async importedWithoutJoiningDate(partyIds) {
      if (partyIds.length === 0) return new Set<string>();
      const { db } = currentUnit();
      const employees = await db.employee.findMany({
        where: { partyId: { in: [...partyIds] }, joiningDate: null, deletedAt: null },
        select: { id: true, partyId: true },
      });
      if (employees.length === 0) return new Set<string>();
      // The import records every employee it created (integration.import_result).
      const imported = await db.importResult.findMany({
        where: { createdEntityId: { in: employees.map((e) => e.id) } },
        select: { createdEntityId: true },
      });
      const ids = new Set(imported.map((r) => r.createdEntityId));
      return new Set(employees.filter((e) => ids.has(e.id)).map((e) => e.partyId));
    },

    async get(employeeId) {
      const row = await currentUnit().db.employee.findFirst({
        where: { id: employeeId, deletedAt: null },
        select,
      });
      return row === null ? null : toCandidate(row);
    },

    async create(input) {
      const { db } = currentUnit();
      let orgUnitId: string | null = null;
      if (input.zoneName !== null) {
        const zone = await db.orgUnit.findFirst({
          where: {
            companyId: input.companyId,
            kind: 'zone',
            name: { equals: input.zoneName, mode: 'insensitive' },
            deletedAt: null,
          },
          select: { id: true },
        });
        orgUnitId = zone?.id ?? null;
      }
      const body: EmployeeCreateInput = {
        companyId: input.companyId,
        person: {
          displayName: input.displayName,
          ...(input.phone === null ? {} : { phones: [input.phone] }),
        },
        joiningDate: input.joiningDate,
        placement: {
          profession: input.profession,
          validFrom: input.joiningDate,
          clientPlatformId: input.clientPlatformId,
          ...(orgUnitId === null ? {} : { orgUnitId }),
        },
        ...(input.acknowledgeDuplicates ? { acknowledgeDuplicates: true } : {}),
      };
      const row = await repository.create(body);
      return {
        employeeId: row.id,
        partyId: row.partyId,
        employeeCode: row.employeeCode,
        zoneMatched: input.zoneName === null ? null : orgUnitId !== null,
      };
    },
  };
}
