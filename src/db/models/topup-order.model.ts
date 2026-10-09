import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { isMicros } from '../../shared/money';
import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

import { BILLING_PROFILE_SCHEMA, type BillingProfile } from './account.model';

export const PAYMENT_PROVIDERS = ['razorpay', 'fake'] as const;
export type PaymentProviderName = (typeof PAYMENT_PROVIDERS)[number];

export const TOPUP_STATUSES = [
  'creating',
  'created',
  'paid',
  'failed',
  'expired',
  'refunded',
] as const;
export type TopupStatus = (typeof TOPUP_STATUSES)[number];

export interface TopupAmounts {
  baseMicros: number;
  cgstMicros: number;
  sgstMicros: number;
  igstMicros: number;
  taxMicros: number;
  totalMicros: number;
}

export interface TopupOrderDoc extends TopupAmounts {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  provider: PaymentProviderName;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  currency: 'INR';
  status: TopupStatus;
  failureReason: string | null;
  /** Billing profile at order time (invoice buyer). */
  buyer: BillingProfile;
  createdBy: Types.ObjectId;
  paidAt: Date | null;
  ledgerEntryId: Types.ObjectId | null;
  invoiceId: Types.ObjectId | null;
  /** Last raw provider payment status (debugging, never sent to clients). */
  rawProviderStatus: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const amount = (positive = false) => ({
  type: Number,
  required: true,
  default: 0,
  validate: {
    validator: (v: unknown) => isMicros(v) && (positive ? v > 0 : v >= 0),
    message: 'Must be a whole number of micros',
  },
});

const schema = new Schema<TopupOrderDoc>({
  provider: { type: String, enum: PAYMENT_PROVIDERS, required: true },
  providerOrderId: { type: String, default: null },
  providerPaymentId: { type: String, default: null },
  currency: { type: String, enum: ['INR'], default: 'INR', required: true },
  baseMicros: amount(true),
  cgstMicros: amount(),
  sgstMicros: amount(),
  igstMicros: amount(),
  taxMicros: amount(),
  totalMicros: amount(true),
  status: { type: String, enum: TOPUP_STATUSES, default: 'creating', required: true },
  failureReason: { type: String, default: null, maxlength: 200 },
  buyer: { type: BILLING_PROFILE_SCHEMA, required: true },
  createdBy: { type: Schema.Types.ObjectId, required: true },
  paidAt: { type: Date, default: null },
  ledgerEntryId: { type: Schema.Types.ObjectId, default: null },
  invoiceId: { type: Schema.Types.ObjectId, default: null },
  rawProviderStatus: { type: String, default: null },
});
schema.plugin(basePlugin, { hide: ['rawProviderStatus'] });
schema.plugin(tenantPlugin);
schema.index(
  { provider: 1, providerOrderId: 1 },
  { unique: true, partialFilterExpression: { providerOrderId: { $type: 'string' } } },
);
schema.index(
  { provider: 1, providerPaymentId: 1 },
  { unique: true, partialFilterExpression: { providerPaymentId: { $type: 'string' } } },
);
schema.index({ accountId: 1, createdAt: -1 });
schema.index({ status: 1, createdAt: 1 });

/** Wallet recharges (data-model.md §2.3). Kept forever (financial record). */
export const TopupOrderModel: Model<TopupOrderDoc> =
  (mongoose.models.TopupOrder as Model<TopupOrderDoc> | undefined) ??
  mongoose.model<TopupOrderDoc>('TopupOrder', schema, 'topupOrders');
