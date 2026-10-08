import type { JobsOptions, Queue } from 'bullmq';
import { z } from 'zod';

import { ValidationError } from '../../shared/errors/app-error';
import type { Logger } from '../../shared/logger';
import { maskEmail } from '../../shared/utils/mask';

import type { EmailMessage, EmailProvider, EmailSendResult } from './email.types';
import { renderTemplate, type EmailTemplateKey, type EmailTemplateVars } from './templates';

/** What goes into Redis: template key + vars + recipient — never rendered HTML. */
export interface EmailJobData<K extends EmailTemplateKey = EmailTemplateKey> {
  template: K;
  to: string;
  vars: EmailTemplateVars[K];
}

/**
 * Email jobs: 5 attempts (5 s → 10 s → 20 s → 40 s), removed on success,
 * failed ones kept 24 h only (they contain the recipient — data.md §9).
 */
export const EMAIL_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: { age: 86_400 },
};

/** A `dedupeKey` blocks repeats of the same email for 24 h (BullMQ deduplication). */
export const EMAIL_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

const EmailAddressSchema = z.email();

const assertRecipient = (to: string): void => {
  if (!EmailAddressSchema.safeParse(to).success) {
    throw new ValidationError([{ path: 'to', message: 'Must be a valid email address.' }]);
  }
};

export interface EmailService {
  readonly driver: EmailProvider['driver'];
  /** Sends a rendered message now (waits for the provider). */
  send(message: EmailMessage): Promise<EmailSendResult>;
  /** Renders a template and sends it now. */
  sendTemplate<K extends EmailTemplateKey>(
    key: K,
    to: string,
    vars: EmailTemplateVars[K],
  ): Promise<EmailSendResult>;
  /**
   * Queues a template email (preferred from request handlers). The same
   * `dedupeKey` (e.g. `verify:<userId>`) is only queued once per 24 h — later
   * calls return the original job id.
   */
  enqueue<K extends EmailTemplateKey>(
    key: K,
    to: string,
    vars: EmailTemplateVars[K],
    options?: { dedupeKey?: string },
  ): Promise<{ jobId: string | undefined }>;
}

export const createEmailService = ({
  provider,
  queue,
  logger,
}: {
  provider: EmailProvider;
  queue?: Queue<EmailJobData>;
  logger: Logger;
}): EmailService => {
  const send = async (message: EmailMessage): Promise<EmailSendResult> => {
    assertRecipient(message.to);
    if (/[\r\n]/.test(message.subject)) {
      throw new ValidationError([{ path: 'subject', message: 'Must be a single line.' }]);
    }
    return provider.send(message);
  };

  return {
    driver: provider.driver,
    send,
    sendTemplate: (key, to, vars) => send({ to, ...renderTemplate(key, vars) }),
    enqueue: async (key, to, vars, options = {}) => {
      assertRecipient(to);
      if (!queue) throw new Error('Email queue is not configured');
      const job = await queue.add(
        key,
        { template: key, to, vars },
        {
          ...EMAIL_JOB_OPTIONS,
          ...(options.dedupeKey && {
            deduplication: { id: options.dedupeKey, ttl: EMAIL_DEDUPE_TTL_MS },
          }),
        },
      );
      logger.debug({ to: maskEmail(to), template: key, jobId: job.id }, 'email: queued');
      return { jobId: job.id };
    },
  };
};
