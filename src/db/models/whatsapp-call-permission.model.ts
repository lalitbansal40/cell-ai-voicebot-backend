import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

/**
 * Our view of a customer's call permission. Meta's `GET call_permissions` is the
 * source of truth before every call / request (Meta: `no_permission` /
 * `temporary` / `permanent`); this row is the UI state and the history.
 */
export const CALL_PERMISSION_STATUSES = [
  'none',
  'requested',
  'temporary',
  'permanent',
  'declined',
  'expired',
  'revoked',
] as const;
export type CallPermissionStatus = (typeof CALL_PERMISSION_STATUSES)[number];
/** Statuses that allow a business-initiated call. */
export const CALLABLE_PERMISSION_STATUSES: readonly CallPermissionStatus[] = [
  'temporary',
  'permanent',
];

export const CALL_PERMISSION_SOURCES = ['request_reply', 'callback', 'profile', 'unknown'] as const;
export type CallPermissionSource = (typeof CALL_PERMISSION_SOURCES)[number];

export const PERMISSION_REQUEST_KINDS = ['interactive', 'template'] as const;
export type PermissionRequestKind = (typeof PERMISSION_REQUEST_KINDS)[number];

export const PERMISSION_HISTORY_MAX = 30;

export interface CallPermissionRequest {
  messageId: Types.ObjectId;
  kind: PermissionRequestKind;
  at: Date;
  by: Types.ObjectId | null;
}

export interface MetaPermissionAction {
  action: string;
  canPerform: boolean;
  limits: {
    timePeriod: string;
    maxAllowed: number;
    currentUsage: number;
    limitExpiresAt: Date | null;
  }[];
}

export interface CallPermissionHistoryEntry {
  status: CallPermissionStatus;
  at: Date;
  source: CallPermissionSource | 'business' | 'sweep' | 'meta';
}

export interface WhatsAppCallPermissionDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  channelId: Types.ObjectId;
  contactId: Types.ObjectId;
  status: CallPermissionStatus;
  /** Temporary permission: approval + 7 days (Meta's timestamp wins). */
  expiresAt: Date | null;
  source: CallPermissionSource | null;
  lastRequest: CallPermissionRequest | null;
  /** Our request counters (Meta's API is authoritative). */
  requests: { day: Date[]; week: Date[] };
  /** Business-initiated calls not picked up in a row (Meta: 2 → nudge, 4 → revoked). */
  unansweredStreak: number;
  connectedCallsLast24h: number;
  metaCheckedAt: Date | null;
  metaActions: MetaPermissionAction[];
  history: CallPermissionHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}

const historySources = [...CALL_PERMISSION_SOURCES, 'business', 'sweep', 'meta'];

const schema = new Schema<WhatsAppCallPermissionDoc>({
  channelId: { type: Schema.Types.ObjectId, required: true },
  contactId: { type: Schema.Types.ObjectId, required: true },
  status: { type: String, enum: CALL_PERMISSION_STATUSES, default: 'none' },
  expiresAt: { type: Date, default: null },
  source: { type: String, enum: [...CALL_PERMISSION_SOURCES, null], default: null },
  lastRequest: {
    type: new Schema<CallPermissionRequest>(
      {
        messageId: { type: Schema.Types.ObjectId, required: true },
        kind: { type: String, enum: PERMISSION_REQUEST_KINDS, required: true },
        at: { type: Date, required: true },
        by: { type: Schema.Types.ObjectId, default: null },
      },
      { _id: false },
    ),
    default: null,
  },
  requests: {
    day: { type: [Date], default: [] },
    week: { type: [Date], default: [] },
  },
  unansweredStreak: { type: Number, default: 0, min: 0 },
  connectedCallsLast24h: { type: Number, default: 0, min: 0 },
  metaCheckedAt: { type: Date, default: null },
  metaActions: {
    type: [
      new Schema<MetaPermissionAction>(
        {
          action: { type: String, required: true, maxlength: 60 },
          canPerform: { type: Boolean, required: true },
          limits: {
            type: [
              new Schema(
                {
                  timePeriod: { type: String, required: true, maxlength: 40 },
                  maxAllowed: { type: Number, required: true, min: 0 },
                  currentUsage: { type: Number, required: true, min: 0 },
                  limitExpiresAt: { type: Date, default: null },
                },
                { _id: false },
              ),
            ],
            default: [],
          },
        },
        { _id: false },
      ),
    ],
    default: [],
  },
  history: {
    type: [
      new Schema<CallPermissionHistoryEntry>(
        {
          status: { type: String, enum: CALL_PERMISSION_STATUSES, required: true },
          at: { type: Date, required: true },
          source: { type: String, enum: historySources, required: true },
        },
        { _id: false },
      ),
    ],
    default: [],
    validate: {
      validator: (v: unknown[]) => v.length <= PERMISSION_HISTORY_MAX,
      message: `At most ${String(PERMISSION_HISTORY_MAX)} history entries`,
    },
  },
});
schema.plugin(tenantPlugin);
schema.plugin(basePlugin);
schema.index({ accountId: 1, channelId: 1, contactId: 1 }, { unique: true });
// expiry sweep of temporary permissions
schema.index(
  { accountId: 1, expiresAt: 1 },
  { partialFilterExpression: { expiresAt: { $type: 'date' } } },
);
// sweep across accounts (hourly job)
schema.index(
  { status: 1, expiresAt: 1 },
  { partialFilterExpression: { status: 'temporary' }, name: 'temporary_expiry' },
);

/** Call permission per account × number × contact (PHASE_12_PLAN §1c, data-model.md §2.10). */
export const WhatsAppCallPermissionModel: Model<WhatsAppCallPermissionDoc> =
  (mongoose.models.WhatsAppCallPermission as Model<WhatsAppCallPermissionDoc> | undefined) ??
  mongoose.model<WhatsAppCallPermissionDoc>(
    'WhatsAppCallPermission',
    schema,
    'whatsappCallPermissions',
  );
