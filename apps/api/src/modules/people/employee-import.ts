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
 * Not in the sheet (done on screen after the import): photo, platform IDs, zone and team,
 * bank or wallet details (a second person approves them), emergency contact, address, sponsor
 * party and recruiting agent (they are parties, not text). Custom fields can be added in a
 * later template change.
 *
 * Depends on: @fibrex/shared (people schemas), kernel/imports (ImportTarget), kernel/db,
 * modules/party (PartyService), ./employee-router (repository, company rule).
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
import type { PartyService } from '../party/index.js';
import { companyFor, type EmployeeView } from './employee-router.js';

export const EMPLOYEE_IMPORT_KEY = 'people.employee';

/** Columns of the template, in order. `key` is what mappings and saved mappings refer to. */
const FIELDS: ImportField[] = [
  { key: 'displayName', label: 'Full name (English)', required: true },
  { key: 'nameAr', label: 'Name (Arabic)', required: false },
  { key: 'nameBn', label: 'Name (Bangla)', required: false },
  { key: 'nationality', label: 'Nationality (2-letter code)', required: false },
  { key: 'dateOfBirth', label: 'Date of birth', required: false },
  { key: 'qid', label: 'QID number', required: false },
  { key: 'passport', label: 'Passport number', required: false },
  { key: 'phones', label: 'Phones', required: false },
  { key: 'whatsapp', label: 'WhatsApp', required: false },
  { key: 'email', label: 'Email', required: false },
  { key: 'joiningDate', label: 'Joining date', required: false },
  { key: 'sponsorship', label: 'Sponsorship (company or outside)', required: false },
  { key: 'profession', label: 'Profession (rider or driver)', required: false },
];

/** A made-up row for the template (never real data). */
const EXAMPLE: Record<string, string> = {
  displayName: 'Sample Worker',
  nationality: 'BD',
  dateOfBirth: '1995-03-14',
  qid: '29000000000',
  phones: '+97455550000',
  joiningDate: '2026-01-15',
  sponsorship: 'company',
  profession: 'rider',
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
}

/** Step 1: the sheet row as an API body, or the problems found. */
export function parseEmployeeRow(
  values: Record<string, ImportValue>,
): { ok: true; row: ParsedRow } | { ok: false; issues: RowIssue[] } {
  const issues: RowIssue[] = [];
  const bad = (path: string, code: string, message: string) => {
    issues.push({ path, code, message });
  };
  const displayName = text(values.displayName);
  if (displayName === undefined) bad('displayName', 'required', 'The full name is required.');

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
  if (displayName === undefined || issues.length > 0) return { ok: false, issues };

  const names: Record<string, string> = { en: displayName };
  const nameAr = text(values.nameAr);
  const nameBn = text(values.nameBn);
  if (nameAr !== undefined) names.ar = nameAr;
  if (nameBn !== undefined) names.bn = nameBn;
  const qid = text(values.qid);
  const passport = text(values.passport);
  const dateOfBirth = text(values.dateOfBirth);
  const email = text(values.email);
  const joiningDate = text(values.joiningDate);

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
  return { ok: true, row: { body: parsed.data, displayName } };
}

export interface EmployeeImportDeps {
  parties: PartyService;
  repository: Repository<EmployeeView>;
}

/** The result of party matching (step 2). */
type Resolution =
  | { kind: 'link'; partyId: string }
  | { kind: 'new'; acknowledgeDuplicates: boolean }
  | { kind: 'refuse'; issue: RowIssue };

export function createEmployeeImportTarget(deps: EmployeeImportDeps): ImportTarget {
  const { parties, repository } = deps;

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

  return {
    key: EMPLOYEE_IMPORT_KEY,
    label: 'Employees',
    createPermission: 'people.employee.create',
    templateExample: EXAMPLE,
    fields: () => Promise.resolve(FIELDS),
    validate: async (values) => {
      const parsed = parseEmployeeRow(values);
      if (!parsed.ok) return parsed.issues;
      const companyId = previewCompany();
      // With several companies the preview cannot pick one; the commit checks again.
      if (companyId === undefined) return [];
      const resolution = await resolve(companyId, parsed.row);
      return resolution.kind === 'refuse' ? [resolution.issue] : [];
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
      return row.id;
    },
    remove: async (id, reason) => {
      const row = await repository.get(id);
      await repository.softDelete(id, row.version, reason);
    },
  };
}
