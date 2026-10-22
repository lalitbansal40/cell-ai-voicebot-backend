import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

import { SKIP_REASONS, type SkipReason } from './campaign.model';

/** Why a contact waits: the calling window, the per-contact caps, the minimum gap. */
export const WAIT_REASONS = ['window', 'daily_cap', 'weekly_cap', 'min_gap'] as const;
export type WaitReason = (typeof WAIT_REASONS)[number];

export const CAMPAIGN_CONTACT_STATUSES = [
  'pending',
  'queued',
  'calling',
  'retry_wait',
  'callback_wait',
  'completed',
  'failed',
  'skipped',
  'canceled',
] as const;
export type CampaignContactStatus = (typeof CAMPAIGN_CONTACT_STATUSES)[number];

/** Contacts the dispatcher may claim (when `nextAttemptAt` is due). */
export const CLAIMABLE_STATUSES: readonly CampaignContactStatus[] = [
  'pending',
  'retry_wait',
  'callback_wait',
];
/** Contacts with nothing left to do. */
export const FINAL_CONTACT_STATUSES: readonly CampaignContactStatus[] = [
  'completed',
  'failed',
  'skipped',
  'canceled',
];

export const CALL_RESULTS = ['answered', 'no_answer', 'busy', 'failed', 'invalid_number'] as const;
export type CallResult = (typeof CALL_RESULTS)[number];

/** Claim order: due callbacks first, then retries, then fresh contacts. */
export const DUE_RANK = { callback: 0, retry: 1, fresh: 2 } as const;
export type DueRank = (typeof DUE_RANK)[keyof typeof DUE_RANK];

export interface CampaignContactDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  campaignId: Types.ObjectId;
  contactId: Types.ObjectId;
  /** Snapshot order (lists first, then filter / segment, then picked ids). */
  seq: number;
  /** Snapshot (PII) — later contact edits don't change the call. */
  phoneE164: string;
  name: string | null;
  /** Display values of the fields the flow version uses. */
  variables: Record<string, string>;
  status: CampaignContactStatus;
  dueRank: DueRank;
  /** Counted attempts (retry limit); a not-counted end (shutdown, wallet) gives one back. */
  attempts: number;
  /** Every dial so far — the next call's `attempt` number (unique per contact). */
  dials: number;
  nextAttemptAt: Date | null;
  lastCallId: Types.ObjectId | null;
  lastResult: CallResult | null;
  lastAttemptAt: Date | null;
  disposition: string | null;
  promiseToPay: { date: string; amountMicros: number | null } | null;
  callback: { date: string; time: string | null } | null;
  skipReason: SkipReason | null;
  /** Why a pending / retrying contact waits for `nextAttemptAt` (dispatcher's dial guard). */
  waitReason: WaitReason | null;
  claimToken: string | null;
  claimedAt: Date | null;
  /** Sum of this contact's call costs (real, or virtual for dry runs). */
  costMicros: number;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<CampaignContactDoc>(
  {
    campaignId: { type: Schema.Types.ObjectId, required: true },
    contactId: { type: Schema.Types.ObjectId, required: true },
    seq: { type: Number, required: true, min: 0 },
    phoneE164: { type: String, required: true, maxlength: 20 },
    name: { type: String, default: null, maxlength: 120 },
    variables: { type: Schema.Types.Mixed, default: () => ({}) },
    status: { type: String, enum: CAMPAIGN_CONTACT_STATUSES, default: 'pending' },
    dueRank: { type: Number, enum: Object.values(DUE_RANK), default: DUE_RANK.fresh },
    attempts: { type: Number, default: 0, min: 0 },
    dials: { type: Number, default: 0, min: 0 },
    nextAttemptAt: { type: Date, default: null },
    lastCallId: { type: Schema.Types.ObjectId, default: null },
    lastResult: { type: String, enum: [...CALL_RESULTS, null], default: null },
    lastAttemptAt: { type: Date, default: null },
    disposition: { type: String, default: null },
    promiseToPay: { type: Schema.Types.Mixed, default: null },
    callback: { type: Schema.Types.Mixed, default: null },
    skipReason: { type: String, enum: [...SKIP_REASONS, null], default: null },
    waitReason: { type: String, enum: [...WAIT_REASONS, null], default: null },
    claimToken: { type: String, default: null },
    claimedAt: { type: Date, default: null },
    costMicros: { type: Number, default: 0, min: 0 },
  },
  { minimize: false },
);
schema.plugin(basePlugin, { hide: ['claimToken'] });
schema.plugin(tenantPlugin);
schema.index({ campaignId: 1, contactId: 1 }, { unique: true });
schema.index({ campaignId: 1, status: 1, dueRank: 1, nextAttemptAt: 1, seq: 1 });
schema.index({ campaignId: 1, seq: 1 });
schema.index({ campaignId: 1, phoneE164: 1 });
schema.index({ accountId: 1, contactId: 1, status: 1 });
schema.index({ status: 1, claimedAt: 1 });

/** One contact of a campaign (data-model.md §2.5 — Phase 8). Purged with its campaign. */
export const CampaignContactModel: Model<CampaignContactDoc> =
  (mongoose.models.CampaignContact as Model<CampaignContactDoc> | undefined) ??
  mongoose.model<CampaignContactDoc>('CampaignContact', schema, 'campaignContacts');
