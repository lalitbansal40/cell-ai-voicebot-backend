import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export const POSTCALL_STATUSES = ['scheduled', 'sent', 'skipped', 'failed'] as const;
export type PostCallStatus = (typeof POSTCALL_STATUSES)[number];

/** Why a post-call message wasn't sent (exact, shown on the call page). */
export const POSTCALL_SKIP_REASONS = [
  'opted_out',
  'dnd',
  'no_template',
  'template_not_approved',
  'no_number',
  'no_phone',
  'low_balance',
  'marketing_limit',
  'rule_disabled',
  'call_not_eligible',
] as const;
export type PostCallSkipReason = (typeof POSTCALL_SKIP_REASONS)[number];

export interface PostCallMessageDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  callId: Types.ObjectId;
  contactId: Types.ObjectId | null;
  /** `flow:<nodeId>` or `rule:<ruleId>` — one message per call and source. */
  source: string;
  ruleId: Types.ObjectId | null;
  channelId: Types.ObjectId | null;
  templateId: Types.ObjectId | null;
  templateName: string;
  language: string;
  /** Values by template variable key (customer data — never logged). */
  variables: Record<string, string>;
  scheduledAt: Date;
  status: PostCallStatus;
  reason: string | null;
  messageId: Types.ObjectId | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<PostCallMessageDoc>(
  {
    callId: { type: Schema.Types.ObjectId, required: true },
    contactId: { type: Schema.Types.ObjectId, default: null },
    source: { type: String, required: true, maxlength: 80 },
    ruleId: { type: Schema.Types.ObjectId, default: null },
    channelId: { type: Schema.Types.ObjectId, default: null },
    templateId: { type: Schema.Types.ObjectId, default: null },
    templateName: { type: String, default: '', maxlength: 512 },
    language: { type: String, default: '', maxlength: 20 },
    variables: { type: Schema.Types.Mixed, default: () => ({}) },
    scheduledAt: { type: Date, required: true },
    status: { type: String, enum: POSTCALL_STATUSES, default: 'scheduled' },
    reason: { type: String, default: null, maxlength: 60 },
    messageId: { type: Schema.Types.ObjectId, default: null },
    sentAt: { type: Date, default: null },
  },
  { minimize: false },
);
schema.plugin(basePlugin);
schema.plugin(tenantPlugin);
schema.index({ accountId: 1, callId: 1, source: 1 }, { unique: true });
schema.index({ status: 1, scheduledAt: 1 });

/** WhatsApp templates sent after a call (Phase 15, PHASE_15_PLAN §1d). */
export const PostCallMessageModel: Model<PostCallMessageDoc> =
  (mongoose.models.PostCallMessage as Model<PostCallMessageDoc> | undefined) ??
  mongoose.model<PostCallMessageDoc>('PostCallMessage', schema, 'postCallMessages');
