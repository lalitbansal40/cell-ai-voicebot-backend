import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export const REPORT_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export type ReportFrequency = (typeof REPORT_FREQUENCIES)[number];

/** Tabs an e-mailed report may hold (KPIs only). */
export const EMAIL_REPORT_TABS = ['overview', 'calls', 'whatsapp', 'campaigns', 'team'] as const;
export type EmailReportTab = (typeof EMAIL_REPORT_TABS)[number];

export interface ReportSubscriptionDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  /** Each person manages their own (PHASE_14_PLAN §7 #7). */
  userId: Types.ObjectId;
  /** Unique bounded slot allocated by the API, including concurrent creates. */
  slot?: number;
  frequency: ReportFrequency;
  tabs: EmailReportTab[];
  /** Account-local hour it is sent (0–23). */
  hour: number;
  active: boolean;
  /** `2026-10-26` (daily), `W-2026-10-19` (weekly, its Monday), `2026-10` (monthly) — sent once per period. */
  lastSentPeriod: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<ReportSubscriptionDoc>({
  userId: { type: Schema.Types.ObjectId, required: true },
  slot: { type: Number, min: 0, max: 4 },
  frequency: { type: String, enum: REPORT_FREQUENCIES, required: true },
  tabs: { type: [{ type: String, enum: EMAIL_REPORT_TABS }], default: ['overview'] },
  hour: { type: Number, min: 0, max: 23, default: 9 },
  active: { type: Boolean, default: true },
  lastSentPeriod: { type: String, default: null },
});
schema.plugin(basePlugin);
schema.plugin(tenantPlugin);
schema.index({ accountId: 1, userId: 1 });
schema.index(
  { accountId: 1, userId: 1, slot: 1 },
  { unique: true, partialFilterExpression: { slot: { $type: 'number' } } },
);
schema.index({ active: 1 });

/** E-mailed reports per person (Phase 14). */
export const ReportSubscriptionModel: Model<ReportSubscriptionDoc> =
  (mongoose.models.ReportSubscription as Model<ReportSubscriptionDoc> | undefined) ??
  mongoose.model<ReportSubscriptionDoc>('ReportSubscription', schema, 'reportSubscriptions');
