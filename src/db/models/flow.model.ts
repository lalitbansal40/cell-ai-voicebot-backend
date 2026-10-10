import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { FLOW_LIMITS } from '../../config/limits';
import { basePlugin } from '../plugins/base';
import { softDeletePlugin } from '../plugins/soft-delete';
import { tenantPlugin } from '../plugins/tenant';

export const FLOW_STATUSES = ['draft', 'published', 'archived'] as const;
export type FlowStatus = (typeof FLOW_STATUSES)[number];

/** The 15 node types of the flow engine (PHASE_6_PLAN §1d). */
export const NODE_TYPES = [
  'start',
  'speak',
  'play_audio',
  'gather_dtmf',
  'gather_speech',
  'ai_agent',
  'api_request',
  'condition_router',
  'set_variable',
  'set_disposition',
  'transfer_to_agent',
  'send_sms',
  'send_whatsapp',
  'wait',
  'hangup',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const FLOW_TRIGGERS = ['campaign', 'inbound', 'api', 'test'] as const;
export type FlowTrigger = (typeof FLOW_TRIGGERS)[number];

export const FLOW_VAR_TYPES = ['text', 'number', 'boolean', 'date'] as const;
export type FlowVarType = (typeof FLOW_VAR_TYPES)[number];

/**
 * The editable graph (`FlowGraph`, schemaVersion 1) — validated by the
 * zod schema in `src/core/engine/schema.ts`; stored as-is.
 */
export type FlowGraphData = Record<string, unknown>;

export interface FlowStats {
  nodes: number;
  agents: Types.ObjectId[];
  audios: Types.ObjectId[];
  triggers: FlowTrigger[];
}

export interface FlowDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  name: string;
  description: string | null;
  status: FlowStatus;
  /** Embedded draft (deviation from data-model `draftVersionId` — one document, one write). */
  draft: FlowGraphData;
  /** +1 on every draft save / restore; saves must send the current one. */
  revision: number;
  draftChecksum: string | null;
  publishedVersionId: Types.ObjectId | null;
  publishedVersion: number | null;
  hasUnpublishedChanges: boolean;
  templateKey: string | null;
  stats: FlowStats;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<FlowDoc>(
  {
    name: { type: String, required: true, trim: true, maxlength: FLOW_LIMITS.nameMaxChars },
    description: { type: String, default: null, maxlength: FLOW_LIMITS.descriptionMaxChars },
    status: { type: String, enum: FLOW_STATUSES, default: 'draft' },
    draft: { type: Schema.Types.Mixed, required: true },
    revision: { type: Number, default: 1, min: 1 },
    draftChecksum: { type: String, default: null },
    publishedVersionId: { type: Schema.Types.ObjectId, default: null },
    publishedVersion: { type: Number, default: null, min: 1 },
    hasUnpublishedChanges: { type: Boolean, default: true },
    templateKey: { type: String, default: null },
    stats: {
      type: new Schema<FlowStats>(
        {
          nodes: { type: Number, default: 0, min: 0 },
          agents: { type: [Schema.Types.ObjectId], default: [] },
          audios: { type: [Schema.Types.ObjectId], default: [] },
          triggers: { type: [{ type: String, enum: FLOW_TRIGGERS }], default: [] },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
    createdBy: { type: Schema.Types.ObjectId, default: null },
    updatedBy: { type: Schema.Types.ObjectId, default: null },
  },
  // keep empty objects inside the graph (`config: {}`, `variables: {}`)
  { minimize: false },
);
schema.plugin(basePlugin, { hide: ['deletedAt'] });
schema.plugin(tenantPlugin);
schema.plugin(softDeletePlugin);
schema.index(
  { accountId: 1, name: 1 },
  {
    unique: true,
    partialFilterExpression: { deletedAt: null },
    collation: { locale: 'en', strength: 2 },
  },
);
schema.index({ accountId: 1, deletedAt: 1, updatedAt: -1 });
schema.index({ accountId: 1, status: 1 });
schema.index({ accountId: 1, 'stats.agents': 1 });
schema.index({ accountId: 1, 'stats.audios': 1 });

/** Call flows with an embedded draft (data-model.md §2.4). */
export const FlowModel: Model<FlowDoc> =
  (mongoose.models.Flow as Model<FlowDoc> | undefined) ??
  mongoose.model<FlowDoc>('Flow', schema, 'flows');
