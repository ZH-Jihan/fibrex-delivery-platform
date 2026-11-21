/**
 * Employee Excel import (phase 3 row 3.8): the `people.employee` target of the generic import
 * wizard (kernel/imports, row 2.8).
 *
 * Purpose: load the first ~40 employees (and later batches) from an Excel sheet. The wizard
 * already does the upload, mapping, clean-ups, row-by-row preview, background commit and
 * rollback; this file only says which columns exist (SPEC 3.2), how one row is checked, and
 * how one row becomes an employee.
 *
 * How a row becomes an employee, and why it goes through the employee repository:
 *   1. The sheet row is read into the same body `POST /employees` takes (`employeeCreateSchema`),
 *      so an import can never write anything the Employees screen would refuse (SPEC 2.1-2.3).
 *   2. Party matching (SPEC 2.8, a person exists once). Before a new person is made, the
 *      company's parties are searched by QID, passport and phone:
 *        - the same QID or passport matches one person who is not an employee yet: that
 *          existing party is linked (no second person is created);
 *        - the same QID or passport matches an employee, or matches several people: the row is
 *          refused with a clear message (never guessed);
 *        - only a phone matches: the person is linked when the name is the same and they are
 *          not an employee yet; a different name is treated as a shared phone (family) and a
 *          new person is created, which the party duplicate review will list.
 *   3. QID and passport go through `PartyService.addIdentifier` inside the repository (sealed,
 *      hashed, masked); they are never stored or logged in plain text by the import. The
 *      import job stores the sheet text in `raw_input`/`import_row` like any import; keep the
 *      uploaded file out of shared folders.
 *   4. Rollback soft-deletes the employee (audited, recoverable). A person the import created
 *      stays in `party` on purpose: if the same sheet is imported again, matching by QID links
 *      that person instead of making a second one.
 *
 *   5. Row 3.13: two optional columns. "falcon_id" becomes a `falcon_id` party identifier for the
 *      Snoonu platform (read-only check first: an id another person already holds in an
 *      overlapping period is a row error and is never reassigned; the same person already
 *      holding it is fine). It is held from the joining date, or from "start unknown" when the
 *      sheet has none (row 4.5c, see `falconStart`); the check and the sync use the same
 *      `PartyService.identifierHolders` lookup. "status" (active, inactive, blocked, terminated) is applied through
 *      the employee status state machine after the employee exists, with the note "Imported".
 *      Staff without a profession (office staff) get no placement, hence no rider/driver
 *      document requirements (see the requirements seed in document-type-router.ts).
 *
 * Not in the sheet (done on screen after the import): photo, other platform IDs, zone and team,
 * bank or wallet details (a second person approves them), emergency contact, address, sponsor
 * party and recruiting agent (they are parties, not text). Custom fields can be added in a
 * later template change.
 *
 * Depends on: @fibrex/shared (people schemas), kernel/imports (ImportTarget), kernel/db,
 * modules/party (PartyService, PartyVault), kernel/states (StateService.transition),
 * ./employee-router (repository, company rule).
 * Used by: ./index.ts (registers it when src/main.ts passes the import targets).
 */
import {
  employeeCreateSchema,
  phoneInputSchema,
  type EmployeeCreateInput,
  type ImportValue,
  type RowIssue,
} from '@fibrex/shared';
import type { Repository } from '../../kernel/db/repository.js';
import { currentUnit } from '../../kernel/db/unit-of-work.js';
import { ConflictError } from '../../kernel/http/errors.js';
import type { ImportField, ImportTarget } from '../../kernel/imports/import-targets.js';
import type { StateService } from '../../kernel/states/state-service.js';
import {
  IDENTIFIER_START_UNKNOWN,
  normaliseIdentifierValue,
  type PartyService,
} from '../party/index.js';
import { EMPLOYEE_ENTITY, companyFor, type EmployeeView } from './employee-router.js';

export const EMPLOYEE_IMPORT_KEY = 'people.employee';
const END_OF_TIME = '9999-12-31';

/** Columns of the template, in order. `key` is what mappings and saved mappings refer to. */
const FIELDS: ImportField[] = [
  { key: 'display_name', label: 'Full name (English)', required: true },
  { key: 'name_ar', label: 'Name (Arabic)', required: false },
  { key: 'name_bn', label: 'Name (Bangla)', required: false },
  { key: 'nationality', label: 'Nationality (2-letter code)', required: false },
  { key: 'date_of_birth', label: 'Date of birth', required: false },
  { key: 'qid', label: 'QID number', required: false },
  { key: 'passport', label: 'Passport number', required: false },
  { key: 'phones', label: 'Phones', required: false },
  { key: 'whatsapp', label: 'WhatsApp', required: false },
  { key: 'email', label: 'Email', required: false },
  { key: 'joining_date', label: 'Joining date', required: false },
  { key: 'sponsorship', label: 'Sponsorship (company or outside)', required: false },
  { key: 'profession', label: 'Profession (rider or driver)', required: false },
  { key: 'falcon_id', label: 'Falcon ID (Snoonu)', required: false },
  { key: 'status', label: 'Status (active, inactive, blocked, terminated)', required: false },
];

/** The Snoonu platform code (performance.client_platform) a Falcon ID belongs to. */
const SNOONU_PLATFORM_CODE = 'snoonu';
const FALCON_TYPE = 'falcon_id';
const IMPORT_STATUSES = ['active', 'inactive', 'blocked', 'terminated'] as const;
type ImportStatus = (typeof IMPORT_STATUSES)[number];

/** A made-up row for the template (never real data). */
const EXAMPLE: Record<string, string> = {
  display_name: 'Sample Worker',
  nationality: 'BD',
  date_of_birth: '1995-03-14',
  qid: '29000000000',
  phones: '+97455550000',
  joining_date: '2026-01-15',
  sponsorship: 'company',
  profession: 'rider',
  falcon_id: '100200',
  status: 'active',
};

const text = (v: ImportValue | undefined): string | undefined => {
  if (v === undefined) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
};

/** Excel often stores a phone as a number and drops the plus; put it back. */
function toPhone(raw: string): string {
  const compact = raw.replace(/[\s()-]+/g, '');
  return /^[0-9]/.test(compact) ? `+${compact}` : compact;
}

/** Splits phones typed in one cell (commas or semicolons). */
function splitPhones(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map(toPhone);
}

interface ParsedRow {
  body: EmployeeCreateInput;
  displayName: string;
  /** Blank = no Falcon ID (office staff, or not yet issued). */
  falconId?: string;
  /** Blank = leave the employee in the starting state (active). */
  status?: ImportStatus;
}

/** Step 1: the sheet row as an API body, or the problems found. */
export function parseEmployeeRow(
  values: Record<string, ImportValue>,
): { ok: true; row: ParsedRow } | { ok: false; issues: RowIssue[] } {
  const issues: RowIssue[] = [];
  const bad = (path: string, code: string, message: string) => {
    issues.push({ path, code, message });
  };
  const displayName = text(values.display_name);
  if (displayName === undefined) bad('display_name', 'required', 'The full name is required.');

  const phones = splitPhones(text(values.phones));
  for (const phone of phones) {
    if (!phoneInputSchema.safeParse(phone).success) {
      bad('phones', 'invalid_phone', `"${phone}" is not a phone in international form.`);
    }
  }
  const whatsappText = text(values.whatsapp);
  const whatsapp = whatsappText === undefined ? undefined : toPhone(whatsappText);
  if (whatsapp !== undefined && !phoneInputSchema.safeParse(whatsapp).success) {
    bad('whatsapp', 'invalid_phone', `"${whatsapp}" is not a phone in international form.`);
  }
  const nationality = text(values.nationality)?.toUpperCase();
  if (nationality !== undefined && !/^[A-Z]{2}$/.test(nationality)) {
    bad('nationality', 'invalid_country', 'Use a two-letter country code, for example QA.');
  }
  const sponsorshipText = text(values.sponsorship)?.toLowerCase();
  if (
    sponsorshipText !== undefined &&
    sponsorshipText !== 'company' &&
    sponsorshipText !== 'outside'
  ) {
    bad('sponsorship', 'invalid_sponsorship', 'Sponsorship is "company" or "outside".');
  }
  const profession = text(values.profession)?.toLowerCase();
  if (profession !== undefined && !/^[a-z][a-z0-9_]{0,39}$/.test(profession)) {
    bad('profession', 'invalid_profession', 'Use the profession code, for example rider.');
  }
  const falconId = text(values.falcon_id);
  if (falconId !== undefined && !/^[A-Za-z0-9-]{2,40}$/.test(falconId)) {
    bad('falcon_id', 'invalid_falcon_id', 'The Falcon ID is letters, digits and dashes only.');
  }
  const statusText = text(values.status)?.toLowerCase();
  const status = IMPORT_STATUSES.find((s) => s === statusText);
  if (statusText !== undefined && status === undefined) {
    bad('status', 'invalid_status', 'Status is active, inactive, blocked or terminated.');
  }
  if (displayName === undefined || issues.length > 0) return { ok: false, issues };

  const names: Record<string, string> = { en: displayName };
  const nameAr = text(values.name_ar);
  const nameBn = text(values.name_bn);
  if (nameAr !== undefined) names.ar = nameAr;
  if (nameBn !== undefined) names.bn = nameBn;
  const qid = text(values.qid);
  const passport = text(values.passport);
  const dateOfBirth = text(values.date_of_birth);
  const email = text(values.email);
  const joiningDate = text(values.joining_date);

  const parsed = employeeCreateSchema.safeParse({
    person: {
      displayName,
      names,
      ...(nationality === undefined ? {} : { nationalityCode: nationality }),
      ...(dateOfBirth === undefined ? {} : { dateOfBirth }),
      ...(phones.length === 0 ? {} : { phones }),
      ...(whatsapp === undefined ? {} : { whatsapp }),
      ...(email === undefined ? {} : { email }),
      ...(qid === undefined ? {} : { qid }),
      ...(passport === undefined ? {} : { passport }),
    },
    sponsorship: sponsorshipText ?? 'company',
    ...(joiningDate === undefined ? {} : { joiningDate }),
    ...(profession === undefined ? {} : { placement: { profession } }),
  });
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.').replace(/^person\./, ''),
        code: 'invalid',
        message: i.message,
      })),
    };
  }
  return {
    ok: true,
    row: {
      body: parsed.data,
      displayName,
      ...(falconId === undefined ? {} : { falconId }),
      ...(status === undefined ? {} : { status }),
    },
  };
}

/**
 * Business rule (row 4.5c): the date an imported Falcon ID is held from. The joining date when
 * the sheet gives one; otherwise "since a date nobody recorded" (IDENTIFIER_START_UNKNOWN), never
 * the import day. Staff are imported after they started riding, so the platform report already
 * holds their past days; dating the id from the import day left every one of those days without
 * a person (the first real Snoonu sync matched 0 of 42).
 */
function falconStart(row: ParsedRow): string {
  return row.body.joiningDate ?? IDENTIFIER_START_UNKNOWN;
}

export interface EmployeeImportDeps {
  parties: PartyService;
  repository: Repository<EmployeeView>;
  /** Applies the status column; without it a row naming a status other than active fails. */
  states?: Pick<StateService, 'transition'>;
}

/** The result of party matching (step 2). */
type Resolution =
  | { kind: 'link'; partyId: string }
  | { kind: 'new'; acknowledgeDuplicates: boolean }
  | { kind: 'refuse'; issue: RowIssue };

export function createEmployeeImportTarget(deps: EmployeeImportDeps): ImportTarget {
  const { parties, repository, states } = deps;

  /**
   * Step 5, read only: may this row's Falcon ID go to `partyId` (undefined = a person not made
   * yet)? Another person holding the same id in an overlapping period is a row error and the id
   * is never reassigned. The database exclusion constraint is the last line, but it would abort
   * the whole commit, so the row is refused here with a clear message. Returns the Snoonu
   * platform id to store it under, 'held' when this very person already has the id (nothing
   * to add), or the row issue.
   */
  async function checkFalcon(
    companyId: string,
    row: ParsedRow,
    partyId: string | undefined,
  ): Promise<{ platformId: string } | 'held' | { issue: RowIssue }> {
    const { db } = currentUnit();
    const platform = await db.clientPlatform.findFirst({
      where: { companyId, code: SNOONU_PLATFORM_CODE, deletedAt: null },
      select: { id: true },
    });
    if (platform === null) {
      return {
        issue: {
          path: 'falcon_id',
          code: 'no_snoonu_platform',
          message: 'The Snoonu platform is not set up, so a Falcon ID cannot be linked.',
        },
      };
    }
    // The same lookup the sync engine uses (one normaliser, one hash): anyone holding the id
    // in a period that overlaps [start, open end).
    const holders = await parties.identifierHolders(
      companyId,
      FALCON_TYPE,
      [row.falconId ?? ''],
      falconStart(row),
      END_OF_TIME,
    );
    const other = holders.find((h) => h.partyId !== partyId);
    if (other !== undefined) {
      const name = (await parties.names([other.partyId])).get(other.partyId) ?? 'another person';
      return {
        issue: {
          path: 'falcon_id',
          code: 'falcon_id_in_use',
          message: `Falcon ID ${row.falconId ?? ''} is already held by ${name} from ${other.validFrom}${other.validTo === null ? '' : ` to ${other.validTo}`}. Give a joining date after their period if the id was passed on.`,
        },
      };
    }
    return holders.length > 0 ? 'held' : { platformId: platform.id };
  }

  /** Step 2: link, create or refuse. Reads only. */
  async function resolve(companyId: string, row: ParsedRow): Promise<Resolution> {
    const person = row.body.person;
    if (person === undefined) return { kind: 'new', acknowledgeDuplicates: false };
    const matches = await parties.findMatches({
      companyId,
      qid: person.qid,
      passport: person.passport,
      phones: [
        ...(person.phones ?? []),
        ...(person.whatsapp === undefined ? [] : [person.whatsapp]),
      ],
    });
    if (matches.length === 0) return { kind: 'new', acknowledgeDuplicates: false };

    const employees = await currentUnit().db.employee.findMany({
      where: { companyId, partyId: { in: matches.map((m) => m.partyId) }, deletedAt: null },
      select: { partyId: true, employeeCode: true },
    });
    const codeOf = (partyId: string) => employees.find((e) => e.partyId === partyId)?.employeeCode;
    const refuse = (path: string, code: string, message: string): Resolution => ({
      kind: 'refuse',
      issue: { path, code, message },
    });

    const byDocument = matches.filter((m) => m.reasons.some((r) => r !== 'phone'));
    if (byDocument.length > 1) {
      return refuse(
        'qid',
        'ambiguous_match',
        'The QID and passport belong to different people already on file. Check them.',
      );
    }
    const single = byDocument[0];
    if (single !== undefined) {
      const code = codeOf(single.partyId);
      return code === undefined
        ? { kind: 'link', partyId: single.partyId }
        : refuse(
            'qid',
            'already_employee',
            `${single.displayName} is already employee ${code} (same QID or passport).`,
          );
    }
    // Phone only: the same name is the same person; another name is a shared phone.
    const same = matches.find(
      (m) => m.displayName.trim().toLowerCase() === row.displayName.trim().toLowerCase(),
    );
    if (same !== undefined) {
      const code = codeOf(same.partyId);
      return code === undefined
        ? { kind: 'link', partyId: same.partyId }
        : refuse('phones', 'already_employee', `${same.displayName} is already employee ${code}.`);
    }
    return { kind: 'new', acknowledgeDuplicates: true };
  }

  /** The company rows are checked against: the session's only company, when it has just one. */
  const previewCompany = (): string | undefined => {
    const ids = currentUnit().context.companyIds;
    return ids.length === 1 ? ids[0] : undefined;
  };

  const validate = async (values: Record<string, ImportValue>): Promise<RowIssue[]> => {
    const parsed = parseEmployeeRow(values);
    if (!parsed.ok) return parsed.issues;
    const companyId = previewCompany();
    // With several companies the preview cannot pick one; the commit checks again.
    if (companyId === undefined) return [];
    const resolution = await resolve(companyId, parsed.row);
    if (resolution.kind === 'refuse') return [resolution.issue];
    if (parsed.row.falconId !== undefined) {
      const falcon = await checkFalcon(
        companyId,
        parsed.row,
        resolution.kind === 'link' ? resolution.partyId : undefined,
      );
      if (typeof falcon === 'object' && 'issue' in falcon) return [falcon.issue];
    }
    return [];
  };

  return {
    key: EMPLOYEE_IMPORT_KEY,
    label: 'Employees',
    createPermission: 'people.employee.create',
    templateExample: EXAMPLE,
    fields: () => Promise.resolve(FIELDS),
    validate,
    // Two rows of one file naming the same person pass the preview (the first is not in the
    // database yet) and then fail the whole commit on the second. Catch it in the preview.
    newPreviewValidator: () => {
      const seen = new Set<string>();
      return async (values) => {
        const issues = [...(await validate(values))];
        const parsed = parseEmployeeRow(values);
        if (!parsed.ok) return issues;
        const person = parsed.row.body.person;
        const keys: { path: string; key: string; what: string }[] = [];
        if (person?.qid !== undefined) {
          keys.push({ path: 'qid', key: `qid:${person.qid}`, what: 'QID' });
        }
        if (person?.passport !== undefined) {
          keys.push({ path: 'passport', key: `passport:${person.passport}`, what: 'passport' });
        }
        if (parsed.row.falconId !== undefined) {
          keys.push({
            path: 'falcon_id',
            key: `falcon:${normaliseIdentifierValue(parsed.row.falconId)}`,
            what: 'Falcon ID',
          });
        }
        const name = parsed.row.displayName.trim().toLowerCase();
        const phones = [...(person?.phones ?? []), ...(person?.whatsapp ? [person.whatsapp] : [])];
        for (const phone of phones) {
          keys.push({ path: 'phones', key: `phone:${phone}:${name}`, what: 'name and phone' });
        }
        for (const k of keys) {
          if (seen.has(k.key)) {
            issues.push({
              path: k.path,
              code: 'duplicate_in_file',
              message: `The same ${k.what} appears in an earlier row of this file.`,
            });
          }
        }
        // Remember only rows that could be created, so a bad first row does not block a good one.
        if (issues.length === 0) for (const k of keys) seen.add(k.key);
        return issues;
      };
    },
    create: async (values, companyId) => {
      const parsed = parseEmployeeRow(values);
      if (!parsed.ok) {
        throw new ConflictError('invalid_row', parsed.issues.map((i) => i.message).join(' '));
      }
      const resolution = await resolve(companyId, parsed.row);
      if (resolution.kind === 'refuse') {
        throw new ConflictError(resolution.issue.code, resolution.issue.message);
      }
      // Step 5, checked before anything is written, so a refused row leaves nothing behind.
      let falconPlatformId: string | undefined;
      if (parsed.row.falconId !== undefined) {
        const falcon = await checkFalcon(
          companyId,
          parsed.row,
          resolution.kind === 'link' ? resolution.partyId : undefined,
        );
        if (typeof falcon === 'object' && 'issue' in falcon) {
          throw new ConflictError(falcon.issue.code, falcon.issue.message);
        }
        if (typeof falcon === 'object') falconPlatformId = falcon.platformId;
      }
      const wantedStatus = parsed.row.status === 'active' ? undefined : parsed.row.status;
      if (wantedStatus !== undefined && states === undefined) {
        throw new ConflictError('status_unavailable', 'Statuses cannot be set by this import.');
      }
      const { person, ...rest } = parsed.row.body;
      const body: EmployeeCreateInput =
        resolution.kind === 'link'
          ? { ...rest, partyId: resolution.partyId, companyId }
          : {
              ...rest,
              ...(person === undefined ? {} : { person }),
              companyId: companyFor(companyId),
              ...(resolution.acknowledgeDuplicates ? { acknowledgeDuplicates: true } : {}),
            };
      const row = await repository.create(body);
      if (parsed.row.falconId !== undefined && falconPlatformId !== undefined) {
        const partyId = row.partyId;
        await parties.addIdentifier(
          partyId,
          companyId,
          FALCON_TYPE,
          parsed.row.falconId,
          falconStart(parsed.row),
          falconPlatformId,
        );
      }
      // New employees start active; any other status is a normal, audited state move with
      // the note "Imported" (blocked and terminated require a reason, which this is).
      if (wantedStatus !== undefined && states !== undefined) {
        await states.transition(EMPLOYEE_ENTITY, row.id, {
          toCode: wantedStatus,
          note: 'Imported',
        });
      }
      return row.id;
    },
    remove: async (id, reason) => {
      const row = await repository.get(id);
      await repository.softDelete(id, row.version, reason);
    },
  };
}
