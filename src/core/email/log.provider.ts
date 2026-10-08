import { randomBytes } from 'node:crypto';

import type { Logger } from '../../shared/logger';
import { maskEmail } from '../../shared/utils/mask';

import type { EmailMessage, EmailProvider, EmailSendResult } from './email.types';

/**
 * Dev driver when SMTP is not configured: logs that an email WOULD be sent.
 * Logs the masked recipient and subject only — never the body (OTPs, links).
 */
export class LogEmailProvider implements EmailProvider {
  readonly driver = 'log' as const;

  constructor(private readonly logger: Logger) {}

  send(message: EmailMessage): Promise<EmailSendResult> {
    const messageId = `log-${randomBytes(6).toString('hex')}`;
    this.logger.info(
      { to: maskEmail(message.to), subject: message.subject, messageId },
      'email: (log driver) not sent',
    );
    return Promise.resolve({ messageId });
  }

  verify(): Promise<boolean> {
    return Promise.resolve(true);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
