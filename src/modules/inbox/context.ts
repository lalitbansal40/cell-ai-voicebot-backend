import type { Types } from 'mongoose';

import type { StorageProvider } from '../../core/storage';
import type { MessagePricing, MessageStatus } from '../../db/models/message.model';
import type { WhatsAppContext } from '../whatsapp/context';

import type { InboxJobs } from './jobs';

/** What the inbox pipelines need: the WhatsApp context (Meta client, Redis, key), storage, jobs. */
/** Phase 11: message charges follow Meta's statuses (injected — the inbox never imports billing). */
export interface InboxBillingHook {
  onStatus(input: {
    accountId: Types.ObjectId;
    messageId: Types.ObjectId;
    status: MessageStatus;
    pricing: MessagePricing | null;
  }): Promise<unknown>;
}

export interface InboxContext {
  wa: WhatsAppContext;
  storage: StorageProvider;
  jobs: InboxJobs;
  billing?: InboxBillingHook;
}

export const inboxNow = (ix: Pick<InboxContext, 'wa'>): Date => ix.wa.now?.() ?? new Date();
