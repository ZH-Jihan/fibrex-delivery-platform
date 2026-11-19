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
import { normaliseSecretValue, type PartyVault } from './vault.js';

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

export interface IdentityQuery {
  companyId: string;
  qid?: string | undefined;
  passport?: string | undefined;
  /** In international form (already normalised by the caller's schema). */
  phones?: readonly string[] | undefined;
}

const toDay = (text: string) => new Date(`${text}T00:00:00.000Z`);
const today = () => toDay(new Date().toISOString().slice(0, 10));

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
  ): Promise<void> {
    await this.#identifiers.create({
      partyId,
      companyId,
      type,
      value,
      ...(validFrom === undefined ? {} : { validFrom }),
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
            normaliseSecretValue(raw),
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
