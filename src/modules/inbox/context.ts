import type { Types } from 'mongoose';

import type { StorageProvider } from '../../core/storage';
import type { MessagePricing, MessageStatus } from '../../db/models/message.model';
import type { WhatsAppChannelDoc } from '../../db/models/whatsapp-channel.model';
import type { TemplateJobs } from '../templates/jobs';
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

/**
 * Phase 12 (injected — the inbox never imports the calling module): call permission
 * replies and the contact panel's permission state.
 */
export interface InboxCallingHook {
  onPermissionReply(input: {
    channel: WhatsAppChannelDoc;
    contactId: Types.ObjectId;
    reply: {
      response: 'accept' | 'reject';
      isPermanent: boolean;
      expiresAt: Date | null;
      source: string | null;
    };
    contextId: string | null;
    at: Date;
  }): Promise<unknown>;
  permissionPanel(input: {
    accountId: Types.ObjectId;
    channelId: Types.ObjectId;
    contactId: Types.ObjectId;
  }): Promise<unknown>;
}

export interface InboxContext {
  wa: WhatsAppContext;
  calling?: InboxCallingHook;
  storage: StorageProvider;
  jobs: InboxJobs;
  billing?: InboxBillingHook;
  /** Phase 11: a template sync after Meta said the template is gone (132001). */
  templateJobs?: Pick<TemplateJobs, 'enqueueSync'>;
}

export const inboxNow = (ix: Pick<InboxContext, 'wa'>): Date => ix.wa.now?.() ?? new Date();
