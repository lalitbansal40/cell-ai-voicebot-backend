import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

import {
  STATS_CHANNELS,
  STATS_KINDS,
  type StatsChannel,
  type StatsKind,
} from './stats-daily.model';

export const ANALYTICS_ENTITIES = ['call', 'message', 'ledger'] as const;
export type AnalyticsEntity = (typeof ANALYTICS_ENTITIES)[number];

export interface AnalyticsRow {
  day: string;
  channel: StatsChannel;
  test: boolean;
  kind: StatsKind;
  refId: Types.ObjectId | null;
  counters: Record<string, number>;
}

export interface AnalyticsMarkDoc {
  /** `<entity>-<id>` */
  _id: string;
  accountId: Types.ObjectId;
  entity: AnalyticsEntity;
  /** What this entity has added to `statsDaily` so far (the next change applies the difference). */
  rows: AnalyticsRow[];
  createdAt: Date;
  updatedAt: Date;
}

const rowSchema = new Schema<AnalyticsRow>(
  {
    day: { type: String, required: true },
    channel: { type: String, enum: STATS_CHANNELS, required: true },
    test: { type: Boolean, default: false },
    kind: { type: String, enum: STATS_KINDS, required: true },
    refId: { type: Schema.Types.ObjectId, default: null },
    counters: { type: Schema.Types.Mixed, default: () => ({}) },
  },
  { _id: false, minimize: false },
);

const schema = new Schema<AnalyticsMarkDoc>(
  {
    _id: { type: String, required: true },
    entity: { type: String, enum: ANALYTICS_ENTITIES, required: true },
    rows: { type: [rowSchema], default: [] },
  },
  { minimize: false },
);
schema.plugin(basePlugin);
schema.plugin(tenantPlugin);

export const analyticsMarkId = (entity: AnalyticsEntity, id: Types.ObjectId | string): string =>
  `${entity}-${id.toString()}`;

/** Per-entity record of counted contributions (Phase 14 sweep idempotency). */
export const AnalyticsMarkModel: Model<AnalyticsMarkDoc> =
  (mongoose.models.AnalyticsMark as Model<AnalyticsMarkDoc> | undefined) ??
  mongoose.model<AnalyticsMarkDoc>('AnalyticsMark', schema, 'analyticsMarks');
