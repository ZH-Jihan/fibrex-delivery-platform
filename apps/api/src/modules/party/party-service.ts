/**
 * Party service: what other modules may do with parties (SPEC 2.13: they reach the party
 * module through this interface, exported from ./index.ts, never through its tables).
 *
 * Purpose: a module that keeps people (employees first, Phase 3) creates or links a party,
 * gives it a role, contacts and identifiers, and asks "does this person already exist?".
 * Every write goes through the same repositories as the party API, so the same rules hold:
 * contacts are normalised, QID and passport numbers are sealed, hashed and masked (never
 * stored in plain text), one identifier cannot belong to two parties on the same day (409),
 * and duplicates are scored after a person is created.
 *
 * All methods run inside the caller's unit of work (row-level security applies), so a
 * module can create the party and its own record in one transaction.
 *
 * Depends on: kernel/db, kernel/http/errors, ./party-router.ts, ./identifier-router.ts,
 * ./duplicates.ts, ./vault.ts. Used by: ./index.ts, modules/people.
 */
import { currentUnit } from '../../kernel/db/unit-of-work.js';
import { NotFoundError } from '../../kernel/http/errors.js';
import { detectDuplicates } from './duplicates.js';
import { createIdentifierRepository } from './identifier-router.js';
import { createPartyRepositories } from './party-router.js';
import { normaliseIdentifierValue, type PartyVault } from './vault.js';

export interface PartySummary {
  id: string;
  companyId: string;
  kind: string;
  displayName: string;
  /** Set when the party was merged into another one (it is then deleted). */
  mergedIntoId: string | null;
}

export interface NewPerson {
  companyId: string;
  displayName: string;
  names?: Record<string, string> | undefined;
  dateOfBirth?: string | null | undefined;
  gender?: string | null | undefined;
  nationalityCode?: string | null | undefined;
}

/** Why a party matched: same QID, same passport or same phone / WhatsApp number. */
export type IdentityMatchReason = 'qid' | 'passport' | 'phone';

export interface IdentityMatch {
  partyId: string;
  displayName: string;
  reasons: IdentityMatchReason[];
}

/** One holding period of an identifier value (`PartyService.identifierHolders`). */
export interface IdentifierHolder {
  identifierId: string;
  version: number;
  /** The day the identifier row was written (UTC), "YYYY-MM-DD". */
  createdOn: string;
  /** The value as normalised (upper case, no spaces or dashes). */
  value: string;
  partyId: string;
  validFrom: string;
  validTo: string | null;
}

export interface IdentityQuery {
  companyId: string;
  qid?: string | undefined;
  passport?: string | undefined;
  /** In international form (already normalised by the caller's schema). */
  phones?: readonly string[] | undefined;
}

const toDay = (text: string) => new Date(`${text}T00:00:00.000Z`);
const today = () => toDay(new Date().toISOString().slice(0, 10));

/**
 * Who held `value` on `date` ("YYYY-MM-DD"), from the periods `identifierHolders` returned;
 * null when nobody did. The value is normalised the same way as at storage, so a caller may
 * pass the raw sheet or form text. Used by the sync engine, the unmatched queue and its repair.
 */
export function holderOn(
  holders: readonly IdentifierHolder[],
  value: string,
  date: string,
): string | null {
  const normalised = normaliseIdentifierValue(value);
  const found = holders.find(
    (h) =>
      h.value === normalised && h.validFrom <= date && (h.validTo === null || h.validTo >= date),
  );
  return found?.partyId ?? null;
}

export class PartyService {
  readonly #vault: PartyVault;
  readonly #repositories = createPartyRepositories();
  readonly #identifiers;

  constructor(vault: PartyVault) {
    this.#vault = vault;
    this.#identifiers = createIdentifierRepository(vault);
  }

  /** The live party, or null when it is missing, deleted or not visible to the caller. */
  async get(partyId: string): Promise<PartySummary | null> {
    const row = await currentUnit().db.party.findFirst({ where: { id: partyId, deletedAt: null } });
    return row === null
      ? null
      : {
          id: row.id,
          companyId: row.companyId,
          kind: row.kind,
          displayName: row.displayName,
          mergedIntoId: row.mergedIntoId,
        };
  }

  /** Display names by party id (deleted parties included: history must still read well). */
  async names(partyIds: readonly string[]): Promise<Map<string, string>> {
    if (partyIds.length === 0) return new Map();
    const rows = await currentUnit().db.party.findMany({
      where: { id: { in: [...new Set(partyIds)] } },
      select: { id: true, displayName: true },
    });
    return new Map(rows.map((r) => [r.id, r.displayName]));
  }

  /** A new person; duplicates are scored once contacts are added (`scanDuplicates`). */
  async createPerson(input: NewPerson): Promise<PartySummary> {
    const row = await this.#repositories.party.create({
      kind: 'person',
      companyId: input.companyId,
      displayName: input.displayName,
      names: input.names ?? { en: input.displayName },
      dateOfBirth: input.dateOfBirth ?? null,
      gender: input.gender ?? null,
      nationalityCode: input.nationalityCode ?? null,
    });
    return {
      id: row.id,
      companyId: row.companyId,
      kind: row.kind,
      displayName: row.displayName,
      mergedIntoId: null,
    };
  }

  /** Adds a phone, WhatsApp number or e-mail; a new primary replaces the old primary. */
  async addContact(
    partyId: string,
    companyId: string,
    kind: 'phone' | 'whatsapp' | 'email',
    value: string,
    isPrimary: boolean,
  ): Promise<void> {
    await this.#repositories.contact.create({ partyId, companyId, kind, value, isPrimary });
  }

  /**
   * Adds an identifier (QID, passport ...). Sensitive types are sealed, hashed and masked;
   * another party holding the same value on the same days is refused with 409.
   */
  async addIdentifier(
    partyId: string,
    companyId: string,
    type: string,
    value: string,
    validFrom?: string,
    clientPlatformId?: string,
  ): Promise<void> {
    await this.#identifiers.create({
      partyId,
      companyId,
      type,
      value,
      ...(validFrom === undefined ? {} : { validFrom }),
      ...(clientPlatformId === undefined ? {} : { clientPlatformId }),
    });
  }

  /**
   * Gives the party a role from `validFrom` unless it already holds that role, open, on that
   * day (a rehired employee keeps the role it never lost).
   */
  async ensureRole(
    partyId: string,
    companyId: string,
    roleType: string,
    validFrom: string,
  ): Promise<void> {
    const from = toDay(validFrom);
    const open = await currentUnit().db.partyRole.findFirst({
      where: {
        partyId,
        roleType,
        status: 'active',
        deletedAt: null,
        validFrom: { lte: from },
        OR: [{ validTo: null }, { validTo: { gte: from } }],
      },
      select: { id: true },
    });
    if (open !== null) return;
    await this.#repositories.role.create({ partyId, companyId, roleType, validFrom });
  }

  /**
   * Who held each of these identifier values (type `type`, e.g. `falcon_id`) at any time
   * between `from` and `to` (inclusive, "YYYY-MM-DD"). Values are matched exactly on the
   * keyed hash after the usual normalising (spaces, dashes, case), so this works for sealed
   * and plain types alike. One identifier has one holder at a time (database rule), so a
   * caller picks the period that covers its date. Live parties only.
   */
  async identifierHolders(
    companyId: string,
    type: string,
    values: readonly string[],
    from: string,
    to: string,
  ): Promise<IdentifierHolder[]> {
    if (values.length === 0) return [];
    const { db, context } = currentUnit();
    const byHash = new Map<string, string>();
    for (const value of values) {
      const normalised = normaliseIdentifierValue(value);
      if (normalised === '') continue;
      byHash.set(this.#vault.hash(context.tenantId, `identifier:${type}`, normalised), normalised);
    }
    const rows = await db.partyIdentifier.findMany({
      where: {
        companyId,
        type,
        valueHash: { in: [...byHash.keys()] },
        deletedAt: null,
        validFrom: { lte: toDay(to) },
        OR: [{ validTo: null }, { validTo: { gte: toDay(from) } }],
        party: { deletedAt: null },
      },
      select: {
        id: true,
        version: true,
        partyId: true,
        valueHash: true,
        validFrom: true,
        validTo: true,
        createdAt: true,
      },
    });
    return rows.map((row) => ({
      identifierId: row.id,
      version: row.version,
      createdOn: row.createdAt.toISOString().slice(0, 10),
      value: byHash.get(row.valueHash) ?? '',
      partyId: row.partyId,
      validFrom: row.validFrom.toISOString().slice(0, 10),
      validTo: row.validTo === null ? null : row.validTo.toISOString().slice(0, 10),
    }));
  }

  /**
   * Moves the start of one identifier period (versioned update through the identifier
   * repository: the change is audited by the table trigger, and a start that would overlap
   * another holder's period is refused with 409 by the one-holder-at-a-time rule).
   */
  async moveIdentifierStart(identifierId: string, version: number, validFrom: string) {
    await this.#identifiers.update(identifierId, version, { validFrom });
  }

  /** Scores the party against the rest of its company (party_duplicate_candidate). */
  async scanDuplicates(partyId: string): Promise<void> {
    const party = await this.get(partyId);
    if (party === null) throw new NotFoundError();
    await detectDuplicates(currentUnit().db, partyId);
  }

  /**
   * The live parties of the company that already hold this QID or passport today (an exact
   * match on the keyed hash; numbers are never searched as text) or one of these phone /
   * WhatsApp numbers. One entry per party, with every reason that matched.
   */
  async findMatches(query: IdentityQuery): Promise<IdentityMatch[]> {
    const { db, context } = currentUnit();
    const found = new Map<string, Set<IdentityMatchReason>>();
    const add = (partyId: string, reason: IdentityMatchReason) => {
      const reasons = found.get(partyId) ?? new Set<IdentityMatchReason>();
      reasons.add(reason);
      found.set(partyId, reasons);
    };
    const day = today();
    for (const [reason, raw] of [
      ['qid', query.qid],
      ['passport', query.passport],
    ] as const) {
      if (raw === undefined) continue;
      const rows = await db.partyIdentifier.findMany({
        where: {
          companyId: query.companyId,
          type: reason,
          valueHash: this.#vault.hash(
            context.tenantId,
            `identifier:${reason}`,
            normaliseIdentifierValue(raw),
          ),
          deletedAt: null,
          validFrom: { lte: day },
          OR: [{ validTo: null }, { validTo: { gte: day } }],
          party: { deletedAt: null },
        },
        select: { partyId: true },
      });
      for (const row of rows) add(row.partyId, reason);
    }
    const phones = [...new Set(query.phones ?? [])];
    if (phones.length > 0) {
      const rows = await db.partyContact.findMany({
        where: {
          companyId: query.companyId,
          kind: { in: ['phone', 'whatsapp'] },
          value: { in: phones },
          deletedAt: null,
          party: { deletedAt: null },
        },
        select: { partyId: true },
      });
      for (const row of rows) add(row.partyId, 'phone');
    }
    const names = await this.names([...found.keys()]);
    return [...found.entries()].map(([partyId, reasons]) => ({
      partyId,
      displayName: names.get(partyId) ?? '',
      reasons: [...reasons],
    }));
  }
}
