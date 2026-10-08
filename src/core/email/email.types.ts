import { ProviderError } from '../../shared/errors/app-error';

/** A fully rendered email (templates produce subject + html + text). */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export interface EmailSendResult {
  messageId: string;
}

export type EmailDriver = 'smtp' | 'log' | 'memory';

/** Delivery backend. `smtp` in production, `log` in dev without SMTP, `memory` in tests. */
export interface EmailProvider {
  readonly driver: EmailDriver;
  send(message: EmailMessage): Promise<EmailSendResult>;
  /** Checks the connection/credentials. Never throws. */
  verify(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * The server rejected the message for good (SMTP 5xx, e.g. unknown recipient).
 * Retrying cannot help — the email worker stops immediately.
 */
export class EmailPermanentError extends ProviderError {
  readonly permanent = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super('PROVIDER_ERROR', message, options);
  }
}
