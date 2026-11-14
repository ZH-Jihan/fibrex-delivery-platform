/**
 * Notification text templates.
 *
 * Purpose: a rule's title and body are short Handlebars texts with merge fields, for
 * example `Loan {{loanNo}} approved for {{borrower}}`. Rendering happens here only.
 *
 * Safety (CLAUDE.md: no eval, sandboxed formulas): Handlebars compiles templates into
 * JavaScript, so an administrator-written template must not reach beyond its data.
 *   - `strict` is off, so a missing field renders as empty text instead of failing the
 *     whole notification;
 *   - prototype access is disabled (the Handlebars default since 4.6) so `{{constructor}}`
 *     and `__proto__` give nothing;
 *   - helpers are limited to none: partials, `lookup` and custom helpers are not
 *     registered on this isolated environment, and block helpers such as each/if (built
 *     in) only walk the supplied data;
 *   - output is plain text (HTML escaping off) because titles go to a text email and to a
 *     web client that escapes on display.
 * Templates are validated when a rule is saved (`validateTemplate`).
 *
 * Depends on: handlebars. Used by: ./notify-service.ts, ./router.ts.
 */
import Handlebars from 'handlebars';

const env = Handlebars.create();

export function validateTemplate(text: string): string | undefined {
  try {
    env.precompile(text);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message.split('\n')[0] : 'Invalid template';
  }
}

export function renderTemplate(text: string, data: Record<string, unknown>): string {
  return env.compile(text, { noEscape: true })(data, {
    allowProtoMethodsByDefault: false,
    allowProtoPropertiesByDefault: false,
  });
}
