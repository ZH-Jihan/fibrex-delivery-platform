/**
 * Messaging adapter: the one doorway for messages that leave the platform (SPEC 2.11).
 *
 * Purpose: callers hand over a finished message and never know which provider delivers
 * it. Development uses the stub (./stub.ts); real SMS and email providers are added as
 * further implementations of this interface without touching any caller.
 *
 * Depends on: nothing. Used by: kernel/auth/auth-service.ts (sign-in codes and password
 * reset links); the notifications module from commit 9.
 */
export interface OutboundMessage {
  channel: 'sms' | 'email';
  /** A phone number in international form (+974...) or an email address. */
  to: string;
  /** What the message is for, so a provider can pick a sender name or template. */
  purpose: 'login_code' | 'password_reset';
  subject?: string;
  text: string;
}

export interface MessagingAdapter {
  /** Rejects when the message could not be handed to the provider. */
  send(message: OutboundMessage): Promise<void>;
}
