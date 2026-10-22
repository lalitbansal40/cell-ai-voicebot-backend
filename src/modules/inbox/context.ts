import type { StorageProvider } from '../../core/storage';
import type { WhatsAppContext } from '../whatsapp/context';

import type { InboxJobs } from './jobs';

/** What the inbox pipelines need: the WhatsApp context (Meta client, Redis, key), storage, jobs. */
export interface InboxContext {
  wa: WhatsAppContext;
  storage: StorageProvider;
  jobs: InboxJobs;
}

export const inboxNow = (ix: Pick<InboxContext, 'wa'>): Date => ix.wa.now?.() ?? new Date();
