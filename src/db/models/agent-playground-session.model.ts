import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

import { DISPOSITIONS, type Disposition } from './ai-agent.model';

export const PLAYGROUND_STATUSES = ['active', 'ended'] as const;
export type PlaygroundStatus = (typeof PLAYGROUND_STATUSES)[number];

export const TURN_ROLES = ['assistant', 'user'] as const;

/** Kept 30 days (data.md retention). */
export const PLAYGROUND_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface PlaygroundToolCall {
  name: string;
  kind: 'custom' | 'built_in';
  args: Record<string, unknown>;
  ok: boolean;
  simulated: boolean;
  durationMs: number;
  resultPreview: string | null;
  error: string | null;
}

export interface PlaygroundTurn {
  _id: Types.ObjectId;
  /** `clientTurnId` of the user turn this reply answers (idempotency). */
  clientTurnId: string | null;
  role: 'assistant' | 'user';
  text: string;
  toolCalls: PlaygroundToolCall[];
  knowledge: { title: string; snippet: string; score: number }[];
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  billing: 'none' | 'charged' | 'failed';
  guardrail: string | null;
  fallback: string | null;
  at: Date;
}

export interface PlaygroundOutcome {
  disposition: Disposition | null;
  promiseToPay: { date: string; amountMicros: number | null } | null;
  callback: { date: string; time: string | null } | null;
  transferRequested: boolean;
  endRequested: boolean;
  smsTemplate: string | null;
}

export interface AgentPlaygroundSessionDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  agentId: Types.ObjectId;
  userId: Types.ObjectId;
  contactId: Types.ObjectId | null;
  /** Allowed variable values shown to the model. */
  variables: Record<string, string>;
  /** Phone for function calls only — never sent to the model, never returned. */
  testPhone: string | null;
  turns: PlaygroundTurn[];
  outcome: PlaygroundOutcome;
  status: PlaygroundStatus;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const toolCallSchema = new Schema<PlaygroundToolCall>(
  {
    name: { type: String, required: true },
    kind: { type: String, enum: ['custom', 'built_in'], required: true },
    args: { type: Schema.Types.Mixed, default: {} },
    ok: { type: Boolean, required: true },
    simulated: { type: Boolean, default: false },
    durationMs: { type: Number, default: 0 },
    resultPreview: { type: String, default: null },
    error: { type: String, default: null },
  },
  { _id: false },
);

const turnSchema = new Schema<PlaygroundTurn>({
  clientTurnId: { type: String, default: null },
  role: { type: String, enum: TURN_ROLES, required: true },
  text: { type: String, default: '', maxlength: 8000 },
  toolCalls: { type: [toolCallSchema], default: [] },
  knowledge: {
    type: [new Schema({ title: String, snippet: String, score: Number }, { _id: false })],
    default: [],
  },
  inputTokens: { type: Number, default: 0 },
  outputTokens: { type: Number, default: 0 },
  costMicros: { type: Number, default: 0 },
  billing: { type: String, enum: ['none', 'charged', 'failed'], default: 'none' },
  guardrail: { type: String, default: null },
  fallback: { type: String, default: null },
  at: { type: Date, required: true },
});

const schema = new Schema<AgentPlaygroundSessionDoc>({
  agentId: { type: Schema.Types.ObjectId, required: true },
  userId: { type: Schema.Types.ObjectId, required: true },
  contactId: { type: Schema.Types.ObjectId, default: null },
  variables: { type: Schema.Types.Mixed, default: {} },
  testPhone: { type: String, default: null, select: false },
  turns: { type: [turnSchema], default: [] },
  outcome: {
    type: new Schema(
      {
        disposition: { type: String, enum: [...DISPOSITIONS, null], default: null },
        promiseToPay: { type: Schema.Types.Mixed, default: null },
        callback: { type: Schema.Types.Mixed, default: null },
        transferRequested: { type: Boolean, default: false },
        endRequested: { type: Boolean, default: false },
        smsTemplate: { type: String, default: null },
      },
      { _id: false },
    ),
    default: () => ({}),
  },
  status: { type: String, enum: PLAYGROUND_STATUSES, default: 'active' },
  expiresAt: { type: Date, required: true },
});
schema.plugin(basePlugin, { hide: ['testPhone'] });
schema.plugin(tenantPlugin);
schema.index({ accountId: 1, agentId: 1, createdAt: -1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** Text conversations with an agent (playground) — 30 days. */
export const AgentPlaygroundSessionModel: Model<AgentPlaygroundSessionDoc> =
  (mongoose.models.AgentPlaygroundSession as Model<AgentPlaygroundSessionDoc> | undefined) ??
  mongoose.model<AgentPlaygroundSessionDoc>(
    'AgentPlaygroundSession',
    schema,
    'agentPlaygroundSessions',
  );
