import type { Job, Worker } from 'bullmq';

import { runImport } from '../../../modules/contact-imports/run.job';
import { validateImport } from '../../../modules/contact-imports/validate.job';
import { deleteListMembers } from '../../../modules/contact-lists/contact-lists.jobs';
import type { ContactJobData, ContactJobName, ContactJobs } from '../../../modules/contacts/jobs';
import { isContactJobName } from '../../../modules/contacts/jobs';
import { deleteFieldValues } from '../../../modules/custom-fields/custom-fields.jobs';
import type { StorageProvider } from '../../storage';
import { QUEUES } from '../names';
import { createWorker, type QueueFactoryDeps } from '../queue-factory';

export interface ContactJobContext {
  storage: StorageProvider;
  jobs: ContactJobs;
  logger: QueueFactoryDeps['logger'];
}

export type ContactJobHandler<N extends ContactJobName = ContactJobName> = (
  data: ContactJobData[N],
  ctx: ContactJobContext,
  job: Job,
) => Promise<unknown>;

export type ContactJobHandlers = { [N in ContactJobName]?: ContactJobHandler<N> };

/** Processors per job name — each task of Phase 3 registers its own here. */
export const CONTACT_JOB_HANDLERS: ContactJobHandlers = {
  'field.delete_values': (data) => deleteFieldValues(data),
  'list.delete_members': (data) => deleteListMembers(data),
  'import.validate': (data, ctx) => validateImport(data, ctx),
  'import.run': (data, ctx, job) => runImport(data, ctx, job),
};

export const processContactJob =
  (ctx: ContactJobContext, handlers: ContactJobHandlers = CONTACT_JOB_HANDLERS) =>
  async (job: Job): Promise<unknown> => {
    const handler = isContactJobName(job.name) ? handlers[job.name] : undefined;
    if (!handler) throw new Error(`Unknown contacts job "${job.name}"`);
    return (handler as ContactJobHandler)(job.data as never, ctx, job);
  };

export const CONTACTS_WORKER_CONCURRENCY = 2;

/** Starts the `contacts` worker (imports, exports, bulk actions, cleanups). */
export const startContactsWorker = (
  deps: QueueFactoryDeps & { storage: StorageProvider; jobs: ContactJobs },
): Worker => {
  const ctx: ContactJobContext = { storage: deps.storage, jobs: deps.jobs, logger: deps.logger };
  return createWorker(QUEUES.contacts, processContactJob(ctx), {
    ...deps,
    concurrency: CONTACTS_WORKER_CONCURRENCY,
  });
};
