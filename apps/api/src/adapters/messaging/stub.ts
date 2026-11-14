/**
 * STUB messaging adapter for development (listed in docs/PROGRESS.md until replaced).
 *
 * Purpose: nothing is really sent. The message is written to the server log, so a
 * developer can read the sign-in code or reset link there.
 *
 * Safety: outside development and test the text is NOT logged, because it contains
 * sign-in codes and reset links, which must never sit in production logs. The stub then
 * only warns that the message was not delivered.
 *
 * Depends on: ./interface.ts, kernel/observability/logger.ts. Used by: src/main.ts.
 */
import type { Logger } from '../../kernel/observability/logger.js';
import type { MessagingAdapter, OutboundMessage } from './interface.js';

export class StubMessagingAdapter implements MessagingAdapter {
  private readonly logger: Logger;
  private readonly revealText: boolean;

  constructor(options: { logger: Logger; revealText: boolean }) {
    this.logger = options.logger;
    this.revealText = options.revealText;
  }

  send(message: OutboundMessage): Promise<void> {
    const { channel, purpose, to, text } = message;
    if (this.revealText) {
      this.logger.info(
        { channel, purpose, to, text },
        'STUB messaging: message not sent, shown here',
      );
    } else {
      this.logger.warn(
        { channel, purpose },
        'STUB messaging: no provider is configured, the message was NOT delivered',
      );
    }
    return Promise.resolve();
  }
}
