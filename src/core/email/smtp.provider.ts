import { createTransport } from 'nodemailer';

import type { Env } from '../../config/env';
import { ProviderError } from '../../shared/errors/app-error';
import type { Logger } from '../../shared/logger';
import { maskEmail } from '../../shared/utils/mask';

import {
  EmailPermanentError,
  type EmailMessage,
  type EmailProvider,
  type EmailSendResult,
} from './email.types';

type SmtpEnv = Pick<
  Env,
  'NODE_ENV' | 'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_SECURE' | 'SMTP_USER' | 'SMTP_PASS' | 'MAIL_FROM'
>;

/** SMTP response code (nodemailer sets it on server rejections). */
const responseCodeOf = (err: unknown): number | undefined => {
  const code = (err as { responseCode?: unknown }).responseCode;
  return typeof code === 'number' ? code : undefined;
};

/**
 * Maps a nodemailer error to our errors. Only the SMTP code / nodemailer code
 * go into the message — never credentials, never the body.
 */
export const toEmailError = (err: unknown): ProviderError => {
  const responseCode = responseCodeOf(err);
  const code = (err as { code?: unknown }).code;
  if (responseCode !== undefined && responseCode >= 500 && responseCode < 600) {
    return new EmailPermanentError(`SMTP rejected the message (${responseCode})`, { cause: err });
  }
  const reason = responseCode ?? (typeof code === 'string' ? code : 'unknown');
  return new ProviderError('PROVIDER_ERROR', `SMTP delivery failed (${reason})`, { cause: err });
};

const buildTransport = (env: SmtpEnv) =>
  createTransport({
    pool: true as const,
    maxConnections: 3,
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    requireTLS: env.NODE_ENV === 'production' && !env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

/** SMTP delivery via a pooled nodemailer transport (ADR 0030). */
export class SmtpEmailProvider implements EmailProvider {
  readonly driver = 'smtp' as const;
  private readonly transport: ReturnType<typeof buildTransport>;

  constructor(
    private readonly env: SmtpEnv,
    private readonly logger: Logger,
  ) {
    this.transport = buildTransport(env);
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    try {
      const info = await this.transport.sendMail({
        from: this.env.MAIL_FROM,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        replyTo: message.replyTo,
      });
      const messageId = String(info.messageId);
      this.logger.info(
        { to: maskEmail(message.to), subject: message.subject, messageId },
        'email: sent',
      );
      return { messageId };
    } catch (err) {
      const mapped = toEmailError(err);
      this.logger.warn(
        { to: maskEmail(message.to), subject: message.subject, reason: mapped.message },
        'email: send failed',
      );
      throw mapped;
    }
  }

  async verify(): Promise<boolean> {
    try {
      await this.transport.verify();
      return true;
    } catch {
      return false;
    }
  }

  close(): Promise<void> {
    this.transport.close();
    return Promise.resolve();
  }
}
