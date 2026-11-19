/**
 * STUB OCR adapter (listed in docs/PROGRESS.md): returns DEMO values, it reads nothing.
 *
 * Purpose: the owner has not chosen an OCR provider yet (phase 3 plan, question 6). Until
 * then this stub lets the upload, pre-fill and confirm flow run end to end in development,
 * tests and production. Replacing it is only an adapter swap in src/main.ts.
 *
 * What it returns, and why:
 *   - The number is made from the file's SHA-256, so the same file always "reads" the same
 *     number (the duplicate check can be tried) and different files differ.
 *   - The holder name is the name hint (the person the scan is for), the type is the type
 *     hint or `qid`, the issue date is a year before today and the expiry two years after.
 *   - Words in the file name drive the demo warnings, so each flag can be shown and tested:
 *       "expired"  -> the expiry date is yesterday
 *       "mismatch" -> the holder name is a different person
 *       "blurry"   -> every confidence is low (0.35)
 *       "cropped"  -> the cropped quality warning
 *       "blank"    -> nothing read at all (unreadable)
 *
 * Depends on: node:crypto, ./interface.ts. Used by: src/main.ts, integration tests.
 */
import { createHash } from 'node:crypto';
import type { OcrAdapter, OcrReadInput, OcrReading } from './interface.js';

const addDays = (isoDate: string, days: number): string =>
  new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export class StubOcrAdapter implements OcrAdapter {
  readonly provider = 'stub';

  read(input: OcrReadInput): Promise<OcrReading> {
    const name = input.fileName.toLowerCase();
    const none = { value: null, confidence: 0 };
    if (name.includes('blank')) {
      return Promise.resolve({
        documentType: none,
        number: none,
        holderName: none,
        issueDate: none,
        expiryDate: none,
        quality: ['unreadable'],
      });
    }
    const sure = name.includes('blurry') ? 0.35 : 1;
    const digits = createHash('sha256')
      .update(input.bytes)
      .digest('hex')
      .replace(/[^0-9]/g, '')
      .padEnd(11, '7')
      .slice(0, 11);
    const holder = name.includes('mismatch')
      ? 'Demo Different Person'
      : (input.holderNameHint ?? 'Demo Holder');
    return Promise.resolve({
      documentType: { value: input.documentTypeHint ?? 'qid', confidence: 0.8 * sure },
      number: { value: digits, confidence: 0.93 * sure },
      holderName: { value: holder, confidence: 0.88 * sure },
      issueDate: { value: addDays(input.today, -365), confidence: 0.9 * sure },
      expiryDate: {
        value: name.includes('expired') ? addDays(input.today, -1) : addDays(input.today, 730),
        confidence: 0.95 * sure,
      },
      quality: name.includes('cropped') ? ['cropped'] : [],
    });
  }
}
