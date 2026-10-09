import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';

export const MOCK_PAYMENT_STATUSES = ['paid', 'unpaid', 'partial'] as const;
export type MockPaymentStatus = (typeof MOCK_PAYMENT_STATUSES)[number];

export interface MockPaymentRecordDoc {
  _id: Types.ObjectId;
  phoneE164: string;
  loanId: string | null;
  status: MockPaymentStatus;
  amountMicros: number;
  paidOn: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<MockPaymentRecordDoc>({
  phoneE164: { type: String, required: true, match: /^\+[1-9]\d{6,14}$/ },
  loanId: { type: String, default: null, maxlength: 60 },
  status: { type: String, enum: MOCK_PAYMENT_STATUSES, required: true },
  amountMicros: { type: Number, required: true, min: 0 },
  paidOn: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },
});
schema.plugin(basePlugin);
schema.index({ phoneE164: 1, loanId: 1 });

/**
 * DEV ONLY — answers of the mock "client payment API" (`/api/v1/mock/payment-status`).
 * Not tenant data: the route is never mounted in production.
 */
export const MockPaymentRecordModel: Model<MockPaymentRecordDoc> =
  (mongoose.models.MockPaymentRecord as Model<MockPaymentRecordDoc> | undefined) ??
  mongoose.model<MockPaymentRecordDoc>('MockPaymentRecord', schema, 'mockPaymentRecords');
