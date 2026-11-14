/**
 * SMTP messaging adapter: sends email through any SMTP server (Mailpit in development,
 * a provider's relay in production).
 *
 * Purpose: the real implementation of the email half of the messaging interface (SPEC
 * 2.11). SMS has no provider yet (Phase 9), so SMS messages are handed to the `sms`
 * adapter given at construction (the logging stub), keeping callers unchanged.
 *
 * `send` rejects when the server refuses the message, so a queue can retry it.
 *
 * Depends on: nodemailer, ./interface.ts. Used by: src/main.ts, test/integration/notify.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import type { MessagingAdapter, OutboundMessage } from './interface.js';

export interface SmtpOptions {
  host: string;
  port: number;
  user?: string;
  password?: string;
  /** The From header, for example `Fibrex <no-reply@example.com>`. */
  from: string;
  /** Handles the SMS channel until a real SMS provider exists. */
  sms: MessagingAdapter;
}

export class SmtpMessagingAdapter implements MessagingAdapter {
  private readonly transport: Transporter;
  private readonly from: string;
  private readonly sms: MessagingAdapter;

  constructor(options: SmtpOptions) {
    this.from = options.from;
    this.sms = options.sms;
    this.transport = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      // Port 465 is implicit TLS; other ports upgrade with STARTTLS when the server offers it.
      secure: options.port === 465,
      ...(options.user === undefined || options.password === undefined
        ? {}
        : { auth: { user: options.user, pass: options.password } }),
      connectionTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(message: OutboundMessage): Promise<void> {
    if (message.channel !== 'email') return this.sms.send(message);
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject ?? 'Fibrex notification',
      text: message.text,
    });
  }

  close(): void {
    this.transport.close();
  }
}
