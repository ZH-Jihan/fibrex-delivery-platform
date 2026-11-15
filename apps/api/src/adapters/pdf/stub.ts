/**
 * STUB PDF adapter (listed in docs/PROGRESS.md): returns a tiny valid one-page PDF whose
 * text is the HTML with tags removed. For tests and machines without Chromium; the layout is
 * not the real one.
 *
 * Depends on: ./interface.ts. Used by: integration tests.
 */
import type { PdfRenderer } from './interface.js';

export class StubPdfRenderer implements PdfRenderer {
  render(html: string, paper: string): Promise<Buffer> {
    const text = html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[^\x20-\x7e]/g, '?')
      .replace(/[()\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    const size = paper === 'Letter' ? '612 792' : paper === 'A5' ? '420 595' : '595 842';
    const stream = `BT /F1 10 Tf 20 800 Td (${text}) Tj ET`;
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
      `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let out = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(out.length);
      out += `${String(i + 1)} 0 obj\n${body}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
    for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
    return Promise.resolve(Buffer.from(out, 'latin1'));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
