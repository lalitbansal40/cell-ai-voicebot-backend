import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

import { BILLING_PROFILE_SCHEMA, type BillingProfile } from './account.model';
import type { TopupAmounts } from './topup-order.model';

export const INVOICE_STATUSES = ['rendering', 'ready', 'failed'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export interface InvoiceSeller {
  name: string;
  address: string;
  gstin: string | null;
  stateCode: string;
}

export interface InvoiceDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  /** `CAV/26-27/000001` — one series per financial year (GST). */
  number: string;
  /** `26-27`. */
  fy: string;
  topupOrderId: Types.ObjectId;
  ledgerEntryId: Types.ObjectId;
  seller: InvoiceSeller;
  buyer: BillingProfile;
  placeOfSupply: { stateCode: string; stateName: string };
  sacCode: string;
  amounts: TopupAmounts;
  paymentId: string;
  issuedAt: Date;
  status: InvoiceStatus;
  pdfFileKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const money = { type: Number, required: true };

const schema = new Schema<InvoiceDoc>({
  number: { type: String, required: true, maxlength: 16 },
  fy: { type: String, required: true },
  topupOrderId: { type: Schema.Types.ObjectId, required: true },
  ledgerEntryId: { type: Schema.Types.ObjectId, required: true },
  seller: {
    name: { type: String, required: true },
    address: { type: String, required: true },
    gstin: { type: String, default: null },
    stateCode: { type: String, required: true },
  },
  buyer: { type: BILLING_PROFILE_SCHEMA, required: true },
  placeOfSupply: {
    stateCode: { type: String, required: true },
    stateName: { type: String, required: true },
  },
  sacCode: { type: String, required: true },
  amounts: {
    baseMicros: money,
    cgstMicros: money,
    sgstMicros: money,
    igstMicros: money,
    taxMicros: money,
    totalMicros: money,
  },
  paymentId: { type: String, required: true },
  issuedAt: { type: Date, required: true },
  status: { type: String, enum: INVOICE_STATUSES, default: 'rendering', required: true },
  pdfFileKey: { type: String, default: null },
});
schema.plugin(basePlugin, { hide: ['pdfFileKey'] });
schema.plugin(tenantPlugin);
schema.index({ number: 1 }, { unique: true });
schema.index({ topupOrderId: 1 }, { unique: true });
schema.index({ accountId: 1, createdAt: -1 });

/** GST tax invoices for paid top-ups (data-model.md §2.3). Kept 8 years. */
export const InvoiceModel: Model<InvoiceDoc> =
  (mongoose.models.Invoice as Model<InvoiceDoc> | undefined) ??
  mongoose.model<InvoiceDoc>('Invoice', schema, 'invoices');
