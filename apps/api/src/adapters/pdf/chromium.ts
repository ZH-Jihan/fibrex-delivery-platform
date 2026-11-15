/**
 * PDF adapter backed by headless Chromium (playwright-core).
 *
 * Purpose: turns a template's HTML into a real PDF. One browser is started on first use and
 * reused; every document gets its own isolated page.
 *
 * Safety: the page has JavaScript turned off and every network request is refused, so a
 * template cannot run code or fetch anything (images must be inline `data:` URLs). Page size
 * comes from the CSS `@page` rule that `renderVersion` writes, so A4/A5/Letter are honoured.
 *
 * Depends on: playwright-core, ./interface.ts (needs a Chromium install: `playwright install
 * chromium`, or PDF_CHROMIUM_PATH). Used by: src/main.ts.
 */
import { chromium, type Browser } from 'playwright-core';
import type { PdfRenderer } from './interface.js';

export class ChromiumPdfRenderer implements PdfRenderer {
  private browser: Promise<Browser> | undefined;
  private readonly executablePath: string | undefined;

  constructor(options: { executablePath?: string | undefined } = {}) {
    this.executablePath = options.executablePath;
  }

  private launch(): Promise<Browser> {
    this.browser ??= chromium.launch({
      headless: true,
      ...(this.executablePath === undefined ? {} : { executablePath: this.executablePath }),
    });
    return this.browser;
  }

  async render(html: string, paper: string): Promise<Buffer> {
    const browser = await this.launch();
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      // No network of any kind: only the HTML we were given is drawn.
      await context.route('**/*', (route) => route.abort());
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      return await page.pdf({ preferCSSPageSize: true, printBackground: true, format: paper });
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    const pending = this.browser;
    this.browser = undefined;
    if (pending !== undefined) await (await pending).close();
  }
}
