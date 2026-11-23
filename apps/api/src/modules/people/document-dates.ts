/**
 * Document dates from outside (phase 4 row 4.9b): the people module's service interface for
 * the performance module's FDB check (SPEC 2.13: no imports of another module's internals).
 *
 * Purpose: give a person a document of a type with an expiry date that another system knows
 * and we do not. The row is made through the same document repository the API uses, so the
 * status rule, the one-current-document rule, the audit trail and row-level security are the
 * same as for a document typed in by staff. Rules, and why:
 *   - A date we already hold is never overwritten: "has_date" is returned and nothing changes.
 *   - A current document of the type without a date gets the date (an update); with no current
 *     document one is created. It has no file: the missing-documents report still asks for
 *     the scan, because a row with this source and no attachment does not count as held.
 *   - `source` records where the date came from, so staff can tell it from a scanned document.
 *
 * Depends on: ./document-router.ts (repository), kernel/db. Used by: ./index.ts (exported),
 * src/main.ts (passed to the performance module's FDB apply service).
 * Runs inside the caller's unit of work (it uses `currentUnit()`).
 */
import { currentUnit } from '../../kernel/db/unit-of-work.js';
import type { DocumentRepository } from './document-router.js';

export const DOCUMENT_SOURCES = ['snoonu_fdb'] as const;
export type DocumentSource = (typeof DOCUMENT_SOURCES)[number];

export interface ExternalDocumentDate {
  partyId: string;
  /** The document type code (qid, passport ...). */
  typeCode: string;
  /** yyyy-mm-dd. */
  expiryDate: string;
  source: DocumentSource;
}

export type ExternalDocumentDateOutcome =
  | { outcome: 'created' | 'updated'; documentId: string }
  | { outcome: 'has_date'; documentId: string }
  | { outcome: 'no_person' | 'no_type'; documentId: null };

export interface DocumentDateWriter {
  applyDate(input: ExternalDocumentDate): Promise<ExternalDocumentDateOutcome>;
}

export function createDocumentDateWriter(documents: DocumentRepository): DocumentDateWriter {
  return {
    async applyDate(input) {
      const { db } = currentUnit();
      const party = await db.party.findFirst({
        where: { id: input.partyId, deletedAt: null },
        select: { id: true, companyId: true },
      });
      if (party === null) return { outcome: 'no_person', documentId: null };
      const type = await db.documentType.findFirst({
        where: {
          companyId: party.companyId,
          code: input.typeCode,
          deletedAt: null,
          appliesTo: 'party',
        },
        select: { id: true },
      });
      if (type === null) return { outcome: 'no_type', documentId: null };

      // The one current document of this type, if any (the database allows only one).
      const current = await db.document.findFirst({
        where: {
          companyId: party.companyId,
          ownerType: 'party',
          ownerId: party.id,
          documentTypeId: type.id,
          status: { not: 'replaced' },
          deletedAt: null,
        },
        select: { id: true, version: true, expiryDate: true },
      });
      if (current !== null) {
        // Never overwrite a date we hold, whoever entered it.
        if (current.expiryDate !== null) return { outcome: 'has_date', documentId: current.id };
        const updated = await documents.update(current.id, current.version, {
          expiryDate: input.expiryDate,
          source: input.source,
        });
        return { outcome: 'updated', documentId: updated.id };
      }
      const created = await documents.create({
        ownerType: 'party',
        ownerId: party.id,
        documentTypeId: type.id,
        expiryDate: input.expiryDate,
        source: input.source,
      });
      return { outcome: 'created', documentId: created.id };
    },
  };
}
