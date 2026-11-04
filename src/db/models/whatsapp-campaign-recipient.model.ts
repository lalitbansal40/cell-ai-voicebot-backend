import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { WA_CAMPAIGN_SKIP_REASONS, type WaCampaignSkipReason } from './whatsapp-campaign.model';

export const WA_RECIPIENT_STATUSES = [
  'pending',
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
  'skipped',
] as const;
export type WaRecipientStatus = (typeof WA_RECIPIENT_STATUSES)[number];

export interface WhatsAppCampaignRecipientDoc {
  _id: Types.ObjectId;
  campaignId: Types.ObjectId;
  accountId: Types.ObjectId;
  contactId: Types.ObjectId;
  variant: 'A' | 'B' | 'C';
  status: WaRecipientStatus;
  skipReason: WaCampaignSkipReason | null;
  messageId: Types.ObjectId | null;
  errorCode: number | null;
  claimedAt: Date | null;
  sentAt: Date | null;
  repliedAt: Date | null;
  attempts: number;
  sentCounted?: boolean;
  /** Charged for this message (micros), filled as the charge lands. */
  costMicros: number;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<WhatsAppCampaignRecipientDoc>(
  {
    campaignId: { type: Schema.Types.ObjectId, required: true },
    accountId: { type: Schema.Types.ObjectId, required: true },
    contactId: { type: Schema.Types.ObjectId, required: true },
    variant: { type: String, enum: ['A', 'B', 'C'], default: 'A' },
    status: { type: String, enum: WA_RECIPIENT_STATUSES, default: 'pending' },
    skipReason: { type: String, enum: [...WA_CAMPAIGN_SKIP_REASONS, null], default: null },
    messageId: { type: Schema.Types.ObjectId, default: null },
    errorCode: { type: Number, default: null },
    claimedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    repliedAt: { type: Date, default: null },
    sentCounted: { type: Boolean, default: false },
    attempts: { type: Number, default: 0 },
    costMicros: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false },
);
schema.index({ campaignId: 1, contactId: 1 }, { unique: true });
schema.index({ campaignId: 1, status: 1 });
schema.index(
  { messageId: 1 },
  { partialFilterExpression: { messageId: { $type: 'objectId' } }, name: 'wac_message' },
);
schema.index({ accountId: 1, contactId: 1, sentAt: -1 });

/** One contact of a WhatsApp campaign (`whatsappCampaignRecipients`); deleted with the contact. */
export const WhatsAppCampaignRecipientModel: Model<WhatsAppCampaignRecipientDoc> =
  (mongoose.models.WhatsAppCampaignRecipient as Model<WhatsAppCampaignRecipientDoc> | undefined) ??
  mongoose.model<WhatsAppCampaignRecipientDoc>(
    'WhatsAppCampaignRecipient',
    schema,
    'whatsappCampaignRecipients',
  );
