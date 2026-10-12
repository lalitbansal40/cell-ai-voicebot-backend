import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { FLOW_LIMITS } from '../../config/limits';
import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

import type { FlowGraphData } from './flow.model';

export const RUN_MODES = ['simulator', 'call'] as const;
export type RunMode = (typeof RUN_MODES)[number];

export const RUN_STATUSES = ['running', 'waiting', 'ended'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_END_REASONS = [
  'hangup_node',
  'transferred',
  'customer_hangup',
  'max_duration',
  'loop_guard',
  'error_handler',
  'engine_error',
  'inputs_exhausted',
] as const;
export type RunEndReason = (typeof RUN_END_REASONS)[number];

export const WAITING_KINDS = ['dtmf', 'speech', 'ai', 'transfer', 'timer'] as const;
export type WaitingKind = (typeof WAITING_KINDS)[number];

export const SIMULATOR_TTL_MS = FLOW_LIMITS.simulatorTtlDays * 24 * 60 * 60_000;

/** One input the run received (idempotent replay by `inputId`). */
export interface RunInputRecord {
  inputId: string;
  kind: string;
  at: Date;
  /** Transcript rows this input produced (`seqFrom`..`seqTo`, inclusive; `seqTo < seqFrom` = none). */
  seqFrom: number;
  seqTo: number;
}

export interface FlowRunDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  flowId: Types.ObjectId;
  mode: RunMode;
  /** `'draft'` or a published version number. */
  versionRef: 'draft' | number;
  /** Graph snapshot (draft runs — editing the draft never changes a running simulation). */
  graph: FlowGraphData | null;
  graphChecksum: string;
  contactId: Types.ObjectId | null;
  /** The call this run belongs to (`mode: 'call'`, Phase 7). */
  callId: Types.ObjectId | null;
  manualVariables: Record<string, string> | null;
  /** Only `{{contact.phone}}` in API templates sees it — never returned. */
  testPhone: string | null;
  status: RunStatus;
  /** What the run waits for (engine `Waiting`), `null` when running / ended. */
  waiting: Record<string, unknown> | null;
  /** `FlowRunState` (engine JSON). */
  state: Record<string, unknown>;
  transcript: Record<string, unknown>[];
  trace: Record<string, unknown>[];
  inputs: RunInputRecord[];
  costMicros: number;
  endReason: RunEndReason | null;
  createdBy: Types.ObjectId | null;
  endedAt: Date | null;
  /** TTL (simulator runs only). */
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const inputSchema = new Schema<RunInputRecord>(
  {
    inputId: { type: String, required: true },
    kind: { type: String, required: true },
    at: { type: Date, required: true },
    seqFrom: { type: Number, required: true },
    seqTo: { type: Number, required: true },
  },
  { _id: false },
);

const schema = new Schema<FlowRunDoc>(
  {
    flowId: { type: Schema.Types.ObjectId, required: true },
    mode: { type: String, enum: RUN_MODES, required: true },
    versionRef: {
      type: Schema.Types.Mixed,
      required: true,
      validate: {
        validator: (v: unknown) =>
          v === 'draft' || (typeof v === 'number' && Number.isInteger(v) && v >= 1),
        message: 'versionRef must be "draft" or a version number',
      },
    },
    graph: { type: Schema.Types.Mixed, default: null },
    graphChecksum: { type: String, required: true },
    contactId: { type: Schema.Types.ObjectId, default: null },
    callId: { type: Schema.Types.ObjectId, default: null },
    manualVariables: { type: Schema.Types.Mixed, default: null },
    testPhone: { type: String, default: null, select: false },
    status: { type: String, enum: RUN_STATUSES, default: 'running' },
    waiting: { type: Schema.Types.Mixed, default: null },
    state: { type: Schema.Types.Mixed, default: () => ({}) },
    transcript: { type: Schema.Types.Mixed, default: () => [] },
    trace: { type: Schema.Types.Mixed, default: () => [] },
    inputs: { type: [inputSchema], default: [] },
    costMicros: { type: Number, default: 0, min: 0 },
    endReason: { type: String, enum: [...RUN_END_REASONS, null], default: null },
    createdBy: { type: Schema.Types.ObjectId, default: null },
    endedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
  },
  { minimize: false },
);
schema.plugin(basePlugin, { hide: ['testPhone', 'graph'] });
schema.plugin(tenantPlugin);
schema.index({ accountId: 1, flowId: 1, createdAt: -1 });
schema.index({ accountId: 1, createdBy: 1, createdAt: -1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
schema.index({ callId: 1 }, { sparse: true });

/** One run of a flow — simulator now, calls from Phase 7 (data-model.md §2.4). */
export const FlowRunModel: Model<FlowRunDoc> =
  (mongoose.models.FlowRun as Model<FlowRunDoc> | undefined) ??
  mongoose.model<FlowRunDoc>('FlowRun', schema, 'flowRuns');
