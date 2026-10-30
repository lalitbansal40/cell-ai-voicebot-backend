import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

import { SENTIMENTS, type Sentiment } from './call.model';

export const RULE_PARAM_SOURCES = ['contact', 'call', 'insights', 'text'] as const;
export type RuleParamSource = (typeof RULE_PARAM_SOURCES)[number];
export const RULE_TIMING_MODES = ['now', 'after', 'next_window_hour'] as const;
export type RuleTimingMode = (typeof RULE_TIMING_MODES)[number];
export const RULE_CALL_KINDS = ['phone', 'whatsapp'] as const;
export type RuleCallKind = (typeof RULE_CALL_KINDS)[number];

export interface OutcomeRuleWhen {
  /** Any of these outcome keys (empty = any outcome). */
  dispositions: string[];
  sentiment: Sentiment[];
  /** `true` = a promise to pay was found; `false` = none; null = either. */
  hasPromise: boolean | null;
  /** The contact wasn't answered on its last N calls (this one included); null = off. */
  notAnsweredInARow: number | null;
  callKinds: RuleCallKind[];
  flowIds: Types.ObjectId[];
  campaignIds: Types.ObjectId[];
}

export interface RuleParam {
  from: RuleParamSource;
  /** Field of the source (`name`, `due_date`, `promise_date` …); `text` uses `value`. */
  key: string | null;
  value: string | null;
}

export interface OutcomeRuleDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  name: string;
  active: boolean;
  /** Lower first. */
  order: number;
  when: OutcomeRuleWhen;
  send: { channelId: Types.ObjectId | null; templateId: Types.ObjectId; params: RuleParam[] };
  timing: { mode: RuleTimingMode; delayMinutes: number | null };
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<OutcomeRuleDoc>({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  active: { type: Boolean, default: true },
  order: { type: Number, default: 0 },
  when: {
    type: new Schema<OutcomeRuleWhen>(
      {
        dispositions: { type: [String], default: [] },
        sentiment: { type: [String], enum: SENTIMENTS, default: [] },
        hasPromise: { type: Boolean, default: null },
        notAnsweredInARow: { type: Number, default: null },
        callKinds: { type: [String], enum: RULE_CALL_KINDS, default: [] },
        flowIds: { type: [Schema.Types.ObjectId], default: [] },
        campaignIds: { type: [Schema.Types.ObjectId], default: [] },
      },
      { _id: false },
    ),
    required: true,
  },
  send: {
    type: new Schema(
      {
        channelId: { type: Schema.Types.ObjectId, default: null },
        templateId: { type: Schema.Types.ObjectId, required: true },
        params: {
          type: [
            new Schema<RuleParam>(
              {
                from: { type: String, enum: RULE_PARAM_SOURCES, required: true },
                key: { type: String, default: null, maxlength: 60 },
                value: { type: String, default: null, maxlength: 200 },
              },
              { _id: false },
            ),
          ],
          default: [],
        },
      },
      { _id: false },
    ),
    required: true,
  },
  timing: {
    type: new Schema(
      {
        mode: { type: String, enum: RULE_TIMING_MODES, default: 'now' },
        delayMinutes: { type: Number, default: null },
      },
      { _id: false },
    ),
    required: true,
  },
  createdBy: { type: Schema.Types.ObjectId, default: null },
});
schema.plugin(basePlugin);
schema.plugin(tenantPlugin);
schema.index({ accountId: 1, order: 1, createdAt: 1 });

/** "After the call" rules (Phase 15, PHASE_15_PLAN §1d; ≤ 20 per account). */
export const OutcomeRuleModel: Model<OutcomeRuleDoc> =
  (mongoose.models.OutcomeRule as Model<OutcomeRuleDoc> | undefined) ??
  mongoose.model<OutcomeRuleDoc>('OutcomeRule', schema, 'outcomeRules');
