import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

/** `voice` = phone / web / dry-run calls, `whatsapp` = WhatsApp calls + messages, `money` = ledger. */
export const STATS_CHANNELS = ['voice', 'whatsapp', 'money'] as const;
export type StatsChannel = (typeof STATS_CHANNELS)[number];

/** Which slice a row counts: the whole account or one campaign / flow / agent / … */
export const STATS_KINDS = [
  'all',
  'campaign',
  'flow',
  'agent',
  'user',
  'template',
  'number',
] as const;
export type StatsKind = (typeof STATS_KINDS)[number];

export interface StatsDailyDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  /** `YYYY-MM-DD` in the account timezone. */
  day: string;
  channel: StatsChannel;
  /** Test calls (call tester, playground) count apart so reports can leave them out. */
  test: boolean;
  kind: StatsKind;
  /** Campaign / flow / AI agent / user / template / WhatsApp number id; `null` for `all`. */
  refId: Types.ObjectId | null;
  /** Integer counters (metric key → value; money in micros, time in seconds). */
  counters: Map<string, number>;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<StatsDailyDoc>({
  day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  channel: { type: String, enum: STATS_CHANNELS, required: true },
  test: { type: Boolean, default: false },
  kind: { type: String, enum: STATS_KINDS, required: true },
  refId: { type: Schema.Types.ObjectId, default: null },
  counters: { type: Map, of: Number, default: () => new Map() },
});
schema.plugin(basePlugin);
schema.plugin(tenantPlugin);
schema.index(
  { accountId: 1, day: 1, channel: 1, test: 1, kind: 1, refId: 1 },
  { unique: true, name: 'stats_row' },
);
schema.index({ accountId: 1, kind: 1, refId: 1, day: 1 });
// rollup retention (REPORT_LIMITS.rollupRetentionMonths)
schema.index({ day: 1 });

/**
 * Daily rollups for reports (Phase 14, ADR 0043). No personal data: counters only.
 * Written by the analytics sweep from per-entity contributions; rebuilt from raw rows.
 */
export const StatsDailyModel: Model<StatsDailyDoc> =
  (mongoose.models.StatsDaily as Model<StatsDailyDoc> | undefined) ??
  mongoose.model<StatsDailyDoc>('StatsDaily', schema, 'statsDaily');
