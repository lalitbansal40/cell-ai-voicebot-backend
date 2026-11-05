import mongoose, { Schema, type Model, type Types } from 'mongoose';

import type { CampaignRecurrence } from './campaign.model';
import type { InboxUploadDoc } from './inbox-upload.model';

export const WA_CAMPAIGN_STATUSES = [
  'draft',
  'scheduled',
  'running',
  'waiting_for_limit',
  'paused',
  'completed',
  'stopped',
  'failed',
] as const;
export type WaCampaignStatus = (typeof WA_CAMPAIGN_STATUSES)[number];

export const WA_CAMPAIGN_PAUSE_REASONS = [
  'user',
  'wallet_empty',
  'template_paused',
  'quality_red',
  'channel_down',
] as const;
export type WaCampaignPauseReason = (typeof WA_CAMPAIGN_PAUSE_REASONS)[number];

/** Why a recipient got nothing (fixed set, PHASE_19_PROMPT §1). */
export const WA_CAMPAIGN_SKIP_REASONS = [
  'dnd',
  'opted_out',
  'suppressed',
  'no_whatsapp',
  'marketing_stopped',
  'sent_recently',
  'missing_variable',
  'invalid_phone',
  'stopped',
  'limit_reached',
  // consent (call permission) variants only
  'already_allowed',
  'declined_recently',
  'meta_limit',
] as const;
export type WaCampaignSkipReason = (typeof WA_CAMPAIGN_SKIP_REASONS)[number];

export const WA_VARIABLE_KINDS = ['field', 'contact.name', 'contact.phone', 'static'] as const;
export type WaVariableKind = (typeof WA_VARIABLE_KINDS)[number];

/** Recipient list filter (the recipient statuses). */
export type WaRecipientFilter =
  'pending' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped';

export interface WaCampaignVariant {
  key: 'A' | 'B' | 'C';
  templateId: Types.ObjectId;
  splitPct: number;
}

export interface WaCampaignCounters {
  total: number;
  queued: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failedTotal: number;
  skippedTotal: number;
  skipped: Partial<Record<WaCampaignSkipReason, number>>;
  /** Meta error code → count. */
  failed: Record<string, number>;
}

export const emptyCounters = (): WaCampaignCounters => ({
  total: 0,
  queued: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  replied: 0,
  failedTotal: 0,
  skippedTotal: 0,
  skipped: {},
  failed: {},
});

export interface WhatsAppCampaignDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  channelId: Types.ObjectId;
  name: string;
  status: WaCampaignStatus;
  pauseReason: WaCampaignPauseReason | null;
  variants: WaCampaignVariant[];
  abWinner: {
    metric: 'read' | 'reply';
    afterHours: number;
    decidedAt: Date | null;
    winner: 'A' | 'B' | 'C' | null;
  } | null;
  /** Template variable key → where its value comes from. */
  variables: Record<string, { kind: WaVariableKind; value: string | null }>;
  audience: {
    listIds: Types.ObjectId[];
    segmentId: Types.ObjectId | null;
    tags: { values: string[]; mode: 'any' | 'all' } | null;
    contactIds: Types.ObjectId[];
    /** An import job (CSV / sheet upload): its contacts join the audience. */
    csvUploadId: Types.ObjectId | null;
  };
  excludeRecentDays: number;
  schedule: {
    kind: 'now' | 'at' | 'recurring';
    at: Date | null;
    timezone?: string;
    recurrence?: CampaignRecurrence | null;
  };
  parentCampaignId?: Types.ObjectId | null;
  recurrenceEnabled?: boolean;
  headerLocation?: { latitude: number; longitude: number; name?: string; address?: string } | null;
  headerMedia?: Pick<
    InboxUploadDoc,
    'kind' | 'storageKey' | 'mimeType' | 'size' | 'sha256' | 'fileName'
  > | null;
  counters: WaCampaignCounters;
  cost: { estimateMicros: number; chargedMicros: number };
  /** Next time the tier allows a batch (`waiting_for_limit`). */
  nextBatchAt: Date | null;
  createdBy: Types.ObjectId;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<WhatsAppCampaignDoc>(
  {
    accountId: { type: Schema.Types.ObjectId, required: true },
    channelId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    status: { type: String, enum: WA_CAMPAIGN_STATUSES, default: 'draft' },
    pauseReason: { type: String, enum: [...WA_CAMPAIGN_PAUSE_REASONS, null], default: null },
    variants: {
      type: [
        new Schema<WaCampaignVariant>(
          {
            key: { type: String, enum: ['A', 'B', 'C'], required: true },
            templateId: { type: Schema.Types.ObjectId, required: true },
            splitPct: { type: Number, min: 1, max: 100, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    abWinner: { type: Schema.Types.Mixed, default: null },
    variables: { type: Schema.Types.Mixed, default: () => ({}) },
    audience: {
      listIds: { type: [Schema.Types.ObjectId], default: [] },
      segmentId: { type: Schema.Types.ObjectId, default: null },
      tags: { type: Schema.Types.Mixed, default: null },
      contactIds: { type: [Schema.Types.ObjectId], default: [] },
      csvUploadId: { type: Schema.Types.ObjectId, default: null },
    },
    excludeRecentDays: { type: Number, min: 0, max: 90, default: 0 },
    schedule: {
      kind: { type: String, enum: ['now', 'at', 'recurring'], default: 'now' },
      at: { type: Date, default: null },
      timezone: { type: String, default: 'Asia/Kolkata' },
      recurrence: { type: Schema.Types.Mixed, default: null },
    },
    parentCampaignId: { type: Schema.Types.ObjectId, default: null },
    recurrenceEnabled: { type: Boolean, default: true },
    headerMedia: { type: Schema.Types.Mixed, default: null },
    headerLocation: { type: Schema.Types.Mixed, default: null },
    counters: { type: Schema.Types.Mixed, default: emptyCounters },
    cost: {
      estimateMicros: { type: Number, default: 0 },
      chargedMicros: { type: Number, default: 0 },
    },
    nextBatchAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, required: true },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, minimize: false },
);
schema.index({ accountId: 1, createdAt: -1 });
schema.index({ status: 1, 'schedule.at': 1 });
schema.index(
  { parentCampaignId: 1, 'schedule.at': 1 },
  {
    unique: true,
    partialFilterExpression: { parentCampaignId: { $type: 'objectId' } },
    name: 'wa_recurring_run',
  },
);

/** Phase 19 bulk WhatsApp template campaigns (`whatsappCampaigns`): ids, settings, counters. */
export const WhatsAppCampaignModel: Model<WhatsAppCampaignDoc> =
  (mongoose.models.WhatsAppCampaign as Model<WhatsAppCampaignDoc> | undefined) ??
  mongoose.model<WhatsAppCampaignDoc>('WhatsAppCampaign', schema, 'whatsappCampaigns');
