/**
 * OCR adapter: the one doorway to "scan in, document fields out" (SPEC 2.11, 5.12).
 *
 * Purpose: the people module hands over the bytes of an uploaded scan and gets back the
 * fields it could read (document type, number, holder name, issue and expiry dates), each
 * with a confidence between 0 and 1, plus quality warnings. It never knows which provider
 * did the reading. A provider must read Arabic as well as Latin text (SPEC 5.12).
 *
 * The adapter only reads. It saves nothing: the people module stores the reading in
 * `people.ocr_job`, and a document is created only when a person confirms.
 *
 * Depends on: nothing. Used by: modules/people/ocr-router.ts, src/main.ts.
 */

export interface OcrReadInput {
  bytes: Buffer;
  mimeType: string;
  /** The uploaded file's original name. */
  fileName: string;
  /** The type the person expects (a document_type code), when they chose one. */
  documentTypeHint: string | null;
  /** The name of the person the scan is for, when known. Real providers ignore it. */
  holderNameHint: string | null;
  /** "YYYY-MM-DD", the company's today. */
  today: string;
}

export interface OcrReadField {
  value: string | null;
  /** 0 to 1. */
  confidence: number;
}

export interface OcrReading {
  /** A document_type code (qid, passport ...), or null when not recognised. */
  documentType: OcrReadField;
  number: OcrReadField;
  holderName: OcrReadField;
  /** "YYYY-MM-DD". */
  issueDate: OcrReadField;
  /** "YYYY-MM-DD". */
  expiryDate: OcrReadField;
  /** The provider's own quality check of the image. */
  quality: ('unreadable' | 'cropped')[];
}

export interface OcrAdapter {
  /** Stored on every job and in integration.adapter_config (lower case, a-z0-9_). */
  readonly provider: string;
  read(input: OcrReadInput): Promise<OcrReading>;
}
