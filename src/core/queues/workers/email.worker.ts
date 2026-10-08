import { UnrecoverableError, type Job, type Processor, type Worker } from 'bullmq';

import type { EmailJobData } from '../../email/email.service';
import {
  EmailPermanentError,
  type EmailProvider,
  type EmailSendResult,
} from '../../email/email.types';
import { isEmailTemplateKey, renderTemplate } from '../../email/templates';
import { QUEUES } from '../names';
import { createWorker, type QueueFactoryDeps } from '../queue-factory';

/** Renders the template and sends it. Permanent SMTP rejections stop the retries. */
export const processEmailJob =
  (provider: EmailProvider): Processor<EmailJobData, EmailSendResult> =>
  async (job: Job<EmailJobData>) => {
    const { template, to, vars } = job.data;
    if (!isEmailTemplateKey(template)) {
      throw new UnrecoverableError(`Unknown email template "${String(template)}"`);
    }
    try {
      return await provider.send({ to, ...renderTemplate(template, vars) });
    } catch (err) {
      if (err instanceof EmailPermanentError) throw new UnrecoverableError(err.message);
      throw err;
    }
  };

/** Starts the `email` worker (concurrency 2 — SMTP servers throttle bursts). */
export const startEmailWorker = (
  deps: QueueFactoryDeps & { provider: EmailProvider },
): Worker<EmailJobData, EmailSendResult> =>
  createWorker<EmailJobData, EmailSendResult>(QUEUES.email, processEmailJob(deps.provider), {
    ...deps,
    concurrency: 2,
  });
