/**
 * Template rendering: Handlebars text + merge data -> text or an HTML document.
 *
 * Purpose: the one place where an administrator-written template is turned into output
 * (preview now; PDF, e-mail and messages in later rows). Pure functions, no database.
 *
 * Safety (CLAUDE.md: no eval, no code from users): Handlebars compiles a template into
 * JavaScript, so the environment is locked down:
 *   - an isolated environment (`Handlebars.create()`) with no custom helpers and no partials,
 *     so a template can only walk the data it is given (the built-in if/each/with/lookup);
 *   - prototype access is off (`{{constructor.constructor}}` renders nothing);
 *   - a missing field renders as empty text instead of failing the whole document;
 *   - HTML kinds (pdf, e-mail) escape every merge value, so a name such as `<script>` cannot
 *     inject markup; plain-text kinds (sms, push, whatsapp) do not escape;
 *   - `css` is inserted into a <style> element; `</style` is refused so it cannot end it.
 * Templates are checked when a version is saved (`templateProblem`).
 *
 * Depends on: handlebars. Used by: ./template-router.ts, ./template-service.ts (and the PDF
 * worker in row 2.7b).
 */
import { createHash } from 'node:crypto';
import Handlebars from 'handlebars';

const env = Handlebars.create();

/** Kinds whose output is HTML and so needs escaped merge values. */
export const HTML_KINDS: readonly string[] = ['pdf', 'email'];

const PAPER_SIZES: Record<string, string> = { A4: 'A4', A5: 'A5', Letter: 'Letter' };

/** Returns the first syntax problem of a template text, or undefined when it compiles. */
export function templateProblem(text: string): string | undefined {
  try {
    env.precompile(text);
    return undefined;
  } catch (err) {
    return err instanceof Error
      ? (err.message.split('\n')[0] ?? 'Invalid template')
      : 'Invalid template';
  }
}

/** Returns a problem with the CSS text, or undefined when it is acceptable. */
export function cssProblem(css: string): string | undefined {
  return /<\/style/i.test(css) ? 'CSS may not contain "</style".' : undefined;
}

/** Renders one text. Throws an Error with a one-line message when the template cannot run. */
export function renderText(text: string, data: Record<string, unknown>, escape: boolean): string {
  try {
    return env.compile(text, { noEscape: !escape })(data, {
      allowProtoMethodsByDefault: false,
      allowProtoPropertiesByDefault: false,
    });
  } catch (err) {
    throw new Error(
      err instanceof Error ? (err.message.split('\n')[0] ?? 'Render failed') : 'Render failed',
      { cause: err },
    );
  }
}

export interface RenderInput {
  kind: string;
  subject: string | null;
  body: string;
  css: string;
  paper: string;
}

export interface Rendered {
  subject: string | null;
  /** The body alone (what a message or e-mail carries). */
  body: string;
  /** A complete HTML document with the CSS and paper size, for PDF and preview. */
  html: string;
}

/** Renders a version's subject and body and wraps the body in a printable HTML document. */
export function renderVersion(input: RenderInput, data: Record<string, unknown>): Rendered {
  const escape = HTML_KINDS.includes(input.kind);
  const body = renderText(input.body, data, escape);
  const subject = input.subject === null ? null : renderText(input.subject, data, false);
  const paper = PAPER_SIZES[input.paper] ?? 'A4';
  const html =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<style>@page { size: ${paper}; margin: 15mm; } body { font-family: Arial, sans-serif; font-size: 11pt; }` +
    `${input.css}</style></head><body>${body}</body></html>`;
  return { subject, body, html };
}

/**
 * Hash of the merge data: keys sorted at every level, so the same data always gives the
 * same hash whatever the order it was built in. Stored in `generated_document.data_hash`.
 */
export function hashMergeData(data: Record<string, unknown>): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, canonical(v)]),
      );
    }
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(data)))
    .digest('hex');
}
