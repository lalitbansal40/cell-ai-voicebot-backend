import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { TEMPLATE_LIMITS } from '../../config/limits';
import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export const TEMPLATE_CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

/** `DRAFT` is ours only; the others are Meta's. */
export const TEMPLATE_STATUSES = [
  'DRAFT',
  'PENDING',
  'APPROVED',
  'REJECTED',
  'PAUSED',
  'DISABLED',
  'IN_APPEAL',
  'FLAGGED',
  'PENDING_DELETION',
  'DELETED',
  'ARCHIVED',
  'LIMIT_EXCEEDED',
] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

/** Every status except `DELETED` (partial indexes can't use `$ne`). */
export const LIVE_TEMPLATE_STATUSES: TemplateStatus[] = TEMPLATE_STATUSES.filter(
  (s) => s !== 'DELETED',
);

/** Statuses a template can be sent in (Meta still delivers `FLAGGED` ones). */
export const SENDABLE_TEMPLATE_STATUSES: readonly TemplateStatus[] = ['APPROVED', 'FLAGGED'];

/** Meta allows edits only in these statuses. */
export const EDITABLE_TEMPLATE_STATUSES: readonly TemplateStatus[] = [
  'DRAFT',
  'APPROVED',
  'REJECTED',
  'PAUSED',
];

export const TEMPLATE_QUALITY = ['GREEN', 'YELLOW', 'RED', 'UNKNOWN'] as const;
export type TemplateQuality = (typeof TEMPLATE_QUALITY)[number];

export const PARAMETER_FORMATS = ['positional', 'named'] as const;
export type ParameterFormat = (typeof PARAMETER_FORMATS)[number];

/** `call_permission` = the ready-made template that asks to call the customer (Phase 12). */
export const TEMPLATE_PURPOSES = ['general', 'call_permission'] as const;
export type TemplatePurpose = (typeof TEMPLATE_PURPOSES)[number];

export const TEMPLATE_HISTORY_SOURCES = ['user', 'webhook', 'sync'] as const;
export type TemplateHistorySource = (typeof TEMPLATE_HISTORY_SOURCES)[number];

/** Where a variable's value comes from at send time (PHASE_11_PLAN §1e). */
export const VARIABLE_SOURCES = [
  'contact.name',
  'contact.phone',
  'contact.email',
  'field',
  'static',
  'ask',
] as const;
export type VariableSourceKind = (typeof VARIABLE_SOURCES)[number];

export const VARIABLE_COMPONENTS = ['header', 'body', 'button'] as const;
export type VariableComponent = (typeof VARIABLE_COMPONENTS)[number];

/** `value` = the custom field key (`field`) or the text (`static`); null otherwise. */
export interface VariableSource {
  kind: VariableSourceKind;
  value: string | null;
}

export interface TemplateVariable {
  /** `1`, `2`… (positional) or the name (named). */
  key: string;
  component: VariableComponent;
  /** Button index for `button` variables; 0 otherwise. */
  index: number;
  /** Meta's sample value (not customer data, but never logged). */
  example: string;
  defaultSource: VariableSource;
}

export interface TemplateStatusReason {
  reason: string;
  title: string | null;
  description: string | null;
}

export interface TemplateHistoryEntry {
  status: TemplateStatus;
  reason: string | null;
  at: Date;
  source: TemplateHistorySource;
}

export interface TemplateHeaderMedia {
  storageKey: string;
  mimeType: string;
  size: number;
  fileName: string | null;
  /** Meta upload handle of the example (resumable upload). */
  handle: string | null;
  handleAt: Date | null;
}

export interface TemplateUsage {
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  lastSentAt: Date | null;
}

export const EMPTY_TEMPLATE_USAGE: TemplateUsage = {
  sent: 0,
  delivered: 0,
  read: 0,
  failed: 0,
  lastSentAt: null,
};

export interface WhatsAppTemplateDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  wabaId: string;
  /** Our numbers on this WABA. */
  channelIds: Types.ObjectId[];
  /** Null while a local draft. */
  metaTemplateId: string | null;
  name: string;
  language: string;
  category: TemplateCategory;
  subCategory: string | null;
  parameterFormat: ParameterFormat;
  /** Meta JSON as sent / synced — validated by zod before every write. */
  components: Record<string, unknown>[];
  variables: TemplateVariable[];
  status: TemplateStatus;
  statusReason: TemplateStatusReason | null;
  statusHistory: TemplateHistoryEntry[];
  quality: { score: TemplateQuality; at: Date } | null;
  pausedUntil: Date | null;
  previousCategory: TemplateCategory | null;
  ttlSeconds: number | null;
  /** Edits of an approved template (Meta: 1 / 24 h, 10 / 30 days). */
  editsLog: { at: Date }[];
  headerMedia: TemplateHeaderMedia | null;
  purpose: TemplatePurpose;
  /** False for components we can't edit (authentication, carousel, unknown kinds). */
  editable: boolean;
  usage: TemplateUsage;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  syncedAt: Date | null;
  /** Our marker when Meta deleted it (rows are never hard-deleted). */
  deletedAt: Date | null;
  /** Event time of the newest applied webhook / sync (older events are ignored). */
  lastEventAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const nullableString = (max: number) => ({ type: String, default: null, maxlength: max });
const sub = <T>(def: Record<string, unknown>) => new Schema<T>(def, { _id: false });

const schema = new Schema<WhatsAppTemplateDoc>({
  wabaId: { type: String, required: true, maxlength: 64 },
  channelIds: { type: [Schema.Types.ObjectId], default: [] },
  metaTemplateId: nullableString(64),
  name: {
    type: String,
    required: true,
    maxlength: TEMPLATE_LIMITS.nameMax,
    match: TEMPLATE_LIMITS.namePattern,
  },
  language: { type: String, required: true, maxlength: 20, match: /^[a-z]{2,3}(_[A-Za-z]{2,4})?$/ },
  category: { type: String, enum: TEMPLATE_CATEGORIES, required: true },
  subCategory: nullableString(60),
  parameterFormat: { type: String, enum: PARAMETER_FORMATS, default: 'positional' },
  components: { type: Schema.Types.Mixed, default: () => [] },
  variables: {
    type: [
      sub<TemplateVariable>({
        key: { type: String, required: true, maxlength: 60 },
        component: { type: String, enum: VARIABLE_COMPONENTS, required: true },
        index: { type: Number, default: 0, min: 0 },
        example: { type: String, default: '', maxlength: TEMPLATE_LIMITS.variableValueMax },
        defaultSource: {
          type: sub<VariableSource>({
            kind: { type: String, enum: VARIABLE_SOURCES, required: true },
            value: nullableString(TEMPLATE_LIMITS.variableValueMax),
          }),
          default: () => ({ kind: 'ask', value: null }),
        },
      }),
    ],
    default: [],
    validate: {
      validator: (v: unknown[]) => v.length <= TEMPLATE_LIMITS.variablesMax,
      message: `At most ${String(TEMPLATE_LIMITS.variablesMax)} variables`,
    },
  },
  status: { type: String, enum: TEMPLATE_STATUSES, required: true },
  statusReason: {
    type: sub<TemplateStatusReason>({
      reason: { type: String, required: true, maxlength: 120 },
      title: nullableString(300),
      description: nullableString(1000),
    }),
    default: null,
  },
  statusHistory: {
    type: [
      sub<TemplateHistoryEntry>({
        status: { type: String, enum: TEMPLATE_STATUSES, required: true },
        reason: nullableString(120),
        at: { type: Date, required: true },
        source: { type: String, enum: TEMPLATE_HISTORY_SOURCES, required: true },
      }),
    ],
    default: [],
  },
  quality: {
    type: sub({
      score: { type: String, enum: TEMPLATE_QUALITY, required: true },
      at: { type: Date, required: true },
    }),
    default: null,
  },
  pausedUntil: { type: Date, default: null },
  previousCategory: { type: String, enum: [...TEMPLATE_CATEGORIES, null], default: null },
  ttlSeconds: { type: Number, default: null, min: 0 },
  editsLog: { type: [sub({ at: { type: Date, required: true } })], default: [] },
  headerMedia: {
    type: sub<TemplateHeaderMedia>({
      storageKey: { type: String, required: true },
      mimeType: { type: String, required: true, maxlength: 120 },
      size: { type: Number, required: true, min: 0 },
      fileName: nullableString(200),
      handle: nullableString(4000),
      handleAt: { type: Date, default: null },
    }),
    default: null,
  },
  purpose: { type: String, enum: TEMPLATE_PURPOSES, default: 'general' },
  editable: { type: Boolean, default: true },
  usage: {
    sent: { type: Number, default: 0, min: 0 },
    delivered: { type: Number, default: 0, min: 0 },
    read: { type: Number, default: 0, min: 0 },
    failed: { type: Number, default: 0, min: 0 },
    lastSentAt: { type: Date, default: null },
  },
  createdBy: { type: Schema.Types.ObjectId, default: null },
  updatedBy: { type: Schema.Types.ObjectId, default: null },
  syncedAt: { type: Date, default: null },
  deletedAt: { type: Date, default: null },
  lastEventAt: { type: Date, default: null },
});
schema.plugin(tenantPlugin);
schema.plugin(basePlugin);
// one live template per name + language on a WABA (Meta's rule; deleted rows keep history)
schema.index(
  { accountId: 1, wabaId: 1, name: 1, language: 1 },
  { unique: true, partialFilterExpression: { status: { $in: LIVE_TEMPLATE_STATUSES } } },
);
schema.index(
  { wabaId: 1, metaTemplateId: 1 },
  { unique: true, partialFilterExpression: { metaTemplateId: { $type: 'string' } } },
);
schema.index({ accountId: 1, status: 1, updatedAt: -1 });
schema.index({ accountId: 1, purpose: 1 });

/** WhatsApp message templates per WABA (data-model.md §2.9). Bodies / samples are never logged. */
export const WhatsAppTemplateModel: Model<WhatsAppTemplateDoc> =
  (mongoose.models.WhatsAppTemplate as Model<WhatsAppTemplateDoc> | undefined) ??
  mongoose.model<WhatsAppTemplateDoc>('WhatsAppTemplate', schema, 'whatsappTemplates');
