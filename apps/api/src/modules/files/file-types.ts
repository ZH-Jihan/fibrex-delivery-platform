/**
 * Which files are accepted, and how a file's real type is checked.
 *
 * Purpose: a file is accepted only when its declared type is on the list AND, for types
 * with a recognisable signature, its first bytes match. A renamed executable declared as
 * a PDF is refused at completion.
 *
 * Phase 1 keeps the list in code; making it a tenant setting needs the settings engine
 * (Phase 2). Depends on: nothing. Used by: ./files-service.ts.
 */
export const ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/csv',
  'text/plain',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const ZIP = [0x50, 0x4b, 0x03, 0x04];

const SIGNATURES: Record<string, { offset: number; bytes: number[] }[]> = {
  'application/pdf': [{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }],
  'image/jpeg': [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  'image/png': [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47] }],
  // RIFF....WEBP
  'image/webp': [
    { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
    { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  ],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [{ offset: 0, bytes: ZIP }],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [
    { offset: 0, bytes: ZIP },
  ],
};

/** True when the first bytes fit the declared type (types without a signature pass). */
export function matchesSignature(mime: string, head: Buffer): boolean {
  const checks = SIGNATURES[mime];
  if (checks === undefined) return true;
  return checks.every(({ offset, bytes }) => bytes.every((b, i) => head[offset + i] === b));
}
