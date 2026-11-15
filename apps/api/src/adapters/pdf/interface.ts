/**
 * PDF adapter: the one doorway to "HTML in, PDF bytes out" (SPEC 2.11).
 *
 * Purpose: the template worker hands over a finished HTML document and a paper size and gets
 * a PDF back. It never knows whether a headless browser or a stub made it.
 *
 * Depends on: nothing. Used by: kernel/templates/pdf-queue.ts, src/main.ts.
 */
export interface PdfRenderer {
  /** Renders a complete HTML document to a PDF on the given paper (A4, A5 or Letter). */
  render(html: string, paper: string): Promise<Buffer>;
  /** Releases anything held open (the browser). Safe to call twice. */
  close(): Promise<void>;
}
