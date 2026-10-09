import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';

import { PAYMENT_PROVIDERS, type PaymentProviderName } from './topup-order.model';

export const PAYMENT_EVENT_OUTCOMES = [
  'received',
  'credited',
  'duplicate_credit',
  'failed',
  'unmatched',
  'mismatch',
  'refund',
  'ignored',
] as const;
export type PaymentEventOutcome = (typeof PAYMENT_EVENT_OUTCOMES)[number];

/** Kept 90 days (data.md retention). */
export const PAYMENT_EVENT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface PaymentEventDoc {
  _id: Types.ObjectId;
  provider: PaymentProviderName;
  eventId: string;
  type: string;
  accountId: Types.ObjectId | null;
  topupOrderId: Types.ObjectId | null;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  outcome: PaymentEventOutcome;
  receivedAt: Date;
  processedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<PaymentEventDoc>({
  provider: { type: String, enum: PAYMENT_PROVIDERS, required: true },
  eventId: { type: String, required: true, maxlength: 100 },
  type: { type: String, required: true, maxlength: 60 },
  accountId: { type: Schema.Types.ObjectId, default: null },
  topupOrderId: { type: Schema.Types.ObjectId, default: null },
  providerOrderId: { type: String, default: null },
  providerPaymentId: { type: String, default: null },
  outcome: { type: String, enum: PAYMENT_EVENT_OUTCOMES, default: 'received', required: true },
  receivedAt: { type: Date, required: true },
  processedAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true },
});
schema.plugin(basePlugin);
schema.index({ provider: 1, eventId: 1 }, { unique: true });
schema.index({ outcome: 1, receivedAt: -1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** Payment-provider webhook deliveries (dedupe + audit trail). System collection. */
export const PaymentEventModel: Model<PaymentEventDoc> =
  (mongoose.models.PaymentEvent as Model<PaymentEventDoc> | undefined) ??
  mongoose.model<PaymentEventDoc>('PaymentEvent', schema, 'paymentEvents');
