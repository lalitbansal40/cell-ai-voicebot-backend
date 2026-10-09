import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { AI_LIMITS } from '../../config/limits';
import { isMicros } from '../../shared/money';
import { basePlugin } from '../plugins/base';
import { softDeletePlugin } from '../plugins/soft-delete';
import { tenantPlugin } from '../plugins/tenant';

/** OpenAI Realtime voices (Phase 7 speaks with the chosen one). */
export const AGENT_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
] as const;
export type AgentVoice = (typeof AGENT_VOICES)[number];

export const LANGUAGE_MODES = ['auto', 'fixed'] as const;
export type LanguageMode = (typeof LANGUAGE_MODES)[number];

export const AGENT_LANGUAGES = ['hi', 'en', 'hinglish'] as const;
export type AgentLanguage = (typeof AGENT_LANGUAGES)[number];

export const TONE_TRIGGERS = [
  'angry',
  'confused',
  'sad',
  'in_a_hurry',
  'abusive',
  'custom',
] as const;
export type ToneTrigger = (typeof TONE_TRIGGERS)[number];

/** Call outcomes (shared with Phase 9 reports). */
export const DISPOSITIONS = [
  'paid',
  'promise_to_pay',
  'callback_requested',
  'wrong_number',
  'refused_to_pay',
  'dispute',
  'not_interested',
  'language_barrier',
  'other',
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export const COMPLIANCE_MODES = ['recovery', 'general'] as const;
export type ComplianceMode = (typeof COMPLIANCE_MODES)[number];

export const ON_CAP = ['stop', 'fallback'] as const;
export type OnCap = (typeof ON_CAP)[number];

export const FUNCTION_METHODS = ['GET', 'POST', 'PUT', 'PATCH'] as const;
export type FunctionMethod = (typeof FUNCTION_METHODS)[number];

export const PARAM_TYPES = ['string', 'number', 'integer', 'boolean', 'enum'] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

export const BUILT_IN_TOOLS = [
  'end_call',
  'transfer_to_human',
  'set_disposition',
  'schedule_callback',
  'save_promise_to_pay',
  'send_sms_after_call',
] as const;
export type BuiltInTool = (typeof BUILT_IN_TOOLS)[number];

export interface ToneRule {
  when: ToneTrigger;
  customWhen?: string | null;
  respond: string;
}

export interface FunctionParam {
  name: string;
  type: ParamType;
  description: string;
  required: boolean;
  enumValues?: string[];
}

/** A header: plain `value`, or a `sealed` secret (AES-GCM) with a display `valueHint`. */
export interface FunctionHeader {
  name: string;
  secret: boolean;
  value?: string | null;
  sealed?: string | null;
  valueHint?: string | null;
}

export interface AgentFunction {
  _id: Types.ObjectId;
  name: string;
  description: string;
  parameters: FunctionParam[];
  method: FunctionMethod;
  url: string;
  headers: FunctionHeader[];
  bodyTemplate?: string | null;
  resultPath?: string | null;
  responseHint?: string | null;
  timeoutMs: number;
}

export interface BuiltInToolsConfig {
  endCall: { enabled: boolean };
  transferToHuman: { enabled: boolean; phone?: string | null; message?: string | null };
  setDisposition: { enabled: boolean; allowed: Disposition[] };
  scheduleCallback: { enabled: boolean; maxDaysAhead: number };
  savePromiseToPay: { enabled: boolean; maxDaysAhead: number };
  sendSmsAfterCall: { enabled: boolean; templates: { key: string; text: string }[] };
}

export interface AiAgentDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  name: string;
  description: string | null;
  persona: string;
  openingLine: string;
  closingLine: string;
  isActive: boolean;
  templateKey: string | null;
  allowedVariables: string[];
  voice: AgentVoice;
  languageMode: LanguageMode;
  language: AgentLanguage;
  toneRules: ToneRule[];
  callBehaviour: {
    maxCallDurationSec: number;
    silenceTimeoutSec: number;
    bargeIn: boolean;
    endCallAfterSilenceRetries: number;
  };
  model: { textModel: string; temperatureTenths: number; maxOutputTokens: number };
  limits: { dailySpendCapMicros: number; monthlySpendCapMicros: number; onCap: OnCap };
  guardrails: { neverSay: string[]; disclosureLine: string; complianceMode: ComplianceMode };
  fallback: { aiFailed: string; walletEmpty: string; agentOff: string; capReached: string };
  knowledge: { knowledgeBaseIds: Types.ObjectId[]; topK: number; minScoreHundredths: number };
  functions: AgentFunction[];
  builtInTools: BuiltInToolsConfig;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Defaults used by blank agents and templates (Hinglish, polite). */
export const DEFAULT_FALLBACKS = {
  aiFailed:
    'Maaf kijiye, abhi thodi technical dikkat hai. Hum aapko thodi der mein dobara call karenge.',
  walletEmpty: 'Maaf kijiye, yeh service abhi uplabdh nahi hai. Hum aapse jald sampark karenge.',
  agentOff: 'Maaf kijiye, yeh service abhi band hai. Dhanyavaad.',
  capReached: 'Maaf kijiye, aaj ke liye yeh service band hai. Hum aapse kal sampark karenge.',
} as const;

export const DEFAULT_DISCLOSURE = 'Main {{company}} ki taraf se ek AI assistant bol raha hoon.';

export const defaultBuiltInTools = (): BuiltInToolsConfig => ({
  endCall: { enabled: true },
  transferToHuman: { enabled: false, phone: null, message: null },
  setDisposition: { enabled: true, allowed: [...DISPOSITIONS] },
  scheduleCallback: { enabled: false, maxDaysAhead: 7 },
  savePromiseToPay: { enabled: false, maxDaysAhead: 15 },
  sendSmsAfterCall: { enabled: false, templates: [] },
});

const micros = {
  type: Number,
  required: true,
  default: 0,
  validate: {
    validator: (v: unknown) => isMicros(v) && v >= 0 && v <= AI_LIMITS.spendCapMaxMicros,
    message: 'Must be whole micros between 0 and the cap maximum',
  },
};

const sub = <T>(definition: Record<string, unknown>) => new Schema<T>(definition, { _id: false });

const functionSchema = new Schema<AgentFunction>({
  name: { type: String, required: true, match: /^[a-z][a-z0-9_]{2,39}$/ },
  description: { type: String, required: true, maxlength: 500 },
  parameters: {
    type: [
      sub<FunctionParam>({
        name: { type: String, required: true, match: /^[a-z][a-z0-9_]{0,39}$/ },
        type: { type: String, enum: PARAM_TYPES, required: true },
        description: { type: String, default: '', maxlength: 300 },
        required: { type: Boolean, default: false },
        enumValues: { type: [String], default: undefined },
      }),
    ],
    default: [],
  },
  method: { type: String, enum: FUNCTION_METHODS, required: true },
  url: { type: String, required: true, maxlength: 2000 },
  headers: {
    type: [
      sub<FunctionHeader>({
        name: { type: String, required: true, maxlength: 64 },
        secret: { type: Boolean, default: false },
        value: { type: String, default: null, maxlength: 2000 },
        sealed: { type: String, default: null },
        valueHint: { type: String, default: null },
      }),
    ],
    default: [],
  },
  bodyTemplate: { type: String, default: null, maxlength: 10_000 },
  resultPath: { type: String, default: null, maxlength: 200 },
  responseHint: { type: String, default: null, maxlength: 300 },
  timeoutMs: {
    type: Number,
    default: AI_LIMITS.functionTimeoutMsDefault,
    min: AI_LIMITS.functionTimeoutMsMin,
    max: AI_LIMITS.functionTimeoutMsMax,
  },
});

const schema = new Schema<AiAgentDoc>({
  name: { type: String, required: true, trim: true, maxlength: AI_LIMITS.nameMaxChars },
  description: { type: String, default: null, maxlength: AI_LIMITS.descriptionMaxChars },
  persona: { type: String, default: '', maxlength: AI_LIMITS.personaMaxChars },
  openingLine: { type: String, default: '', maxlength: AI_LIMITS.lineMaxChars },
  closingLine: { type: String, default: '', maxlength: AI_LIMITS.lineMaxChars },
  isActive: { type: Boolean, default: true },
  templateKey: { type: String, default: null },
  allowedVariables: { type: [String], default: ['name'] },
  voice: { type: String, enum: AGENT_VOICES, default: 'coral' },
  languageMode: { type: String, enum: LANGUAGE_MODES, default: 'auto' },
  language: { type: String, enum: AGENT_LANGUAGES, default: 'hinglish' },
  toneRules: {
    type: [
      sub<ToneRule>({
        when: { type: String, enum: TONE_TRIGGERS, required: true },
        customWhen: { type: String, default: null, maxlength: 100 },
        respond: { type: String, required: true, maxlength: AI_LIMITS.toneRespondMaxChars },
      }),
    ],
    default: [],
  },
  callBehaviour: {
    type: sub({
      maxCallDurationSec: { type: Number, default: 300, min: 60, max: 1800 },
      silenceTimeoutSec: { type: Number, default: 8, min: 3, max: 30 },
      bargeIn: { type: Boolean, default: true },
      endCallAfterSilenceRetries: { type: Number, default: 2, min: 1, max: 3 },
    }),
    default: () => ({}),
  },
  model: {
    type: sub({
      textModel: { type: String, required: true },
      temperatureTenths: { type: Number, default: 6, min: 0, max: AI_LIMITS.temperatureTenthsMax },
      maxOutputTokens: {
        type: Number,
        default: 300,
        min: AI_LIMITS.maxOutputTokensMin,
        max: AI_LIMITS.maxOutputTokensMax,
      },
    }),
    required: true,
  },
  limits: {
    type: sub({
      dailySpendCapMicros: micros,
      monthlySpendCapMicros: micros,
      onCap: { type: String, enum: ON_CAP, default: 'fallback' },
    }),
    default: () => ({}),
  },
  guardrails: {
    type: sub({
      neverSay: { type: [String], default: [] },
      disclosureLine: {
        type: String,
        default: DEFAULT_DISCLOSURE,
        maxlength: AI_LIMITS.lineMaxChars,
      },
      complianceMode: { type: String, enum: COMPLIANCE_MODES, default: 'general' },
    }),
    default: () => ({}),
  },
  fallback: {
    type: sub({
      aiFailed: {
        type: String,
        default: DEFAULT_FALLBACKS.aiFailed,
        maxlength: AI_LIMITS.fallbackMaxChars,
      },
      walletEmpty: {
        type: String,
        default: DEFAULT_FALLBACKS.walletEmpty,
        maxlength: AI_LIMITS.fallbackMaxChars,
      },
      agentOff: {
        type: String,
        default: DEFAULT_FALLBACKS.agentOff,
        maxlength: AI_LIMITS.fallbackMaxChars,
      },
      capReached: {
        type: String,
        default: DEFAULT_FALLBACKS.capReached,
        maxlength: AI_LIMITS.fallbackMaxChars,
      },
    }),
    default: () => ({}),
  },
  knowledge: {
    type: sub({
      knowledgeBaseIds: { type: [Schema.Types.ObjectId], default: [] },
      topK: { type: Number, default: 4, min: 1, max: 8 },
      minScoreHundredths: { type: Number, default: 35, min: 0, max: 100 },
    }),
    default: () => ({}),
  },
  functions: { type: [functionSchema], default: [] },
  builtInTools: {
    type: sub({
      endCall: { type: sub({ enabled: { type: Boolean, default: true } }), default: () => ({}) },
      transferToHuman: {
        type: sub({
          enabled: { type: Boolean, default: false },
          phone: { type: String, default: null },
          message: { type: String, default: null, maxlength: AI_LIMITS.lineMaxChars },
        }),
        default: () => ({}),
      },
      setDisposition: {
        type: sub({
          enabled: { type: Boolean, default: true },
          allowed: { type: [String], enum: DISPOSITIONS, default: () => [...DISPOSITIONS] },
        }),
        default: () => ({}),
      },
      scheduleCallback: {
        type: sub({
          enabled: { type: Boolean, default: false },
          maxDaysAhead: { type: Number, default: 7, min: 1, max: 30 },
        }),
        default: () => ({}),
      },
      savePromiseToPay: {
        type: sub({
          enabled: { type: Boolean, default: false },
          maxDaysAhead: { type: Number, default: 15, min: 1, max: 60 },
        }),
        default: () => ({}),
      },
      sendSmsAfterCall: {
        type: sub({
          enabled: { type: Boolean, default: false },
          templates: {
            type: [
              sub({
                key: { type: String, required: true, match: /^[a-z][a-z0-9_]{1,39}$/ },
                text: { type: String, required: true, maxlength: 500 },
              }),
            ],
            default: [],
          },
        }),
        default: () => ({}),
      },
    }),
    default: () => defaultBuiltInTools(),
  },
  createdBy: { type: Schema.Types.ObjectId, default: null },
  updatedBy: { type: Schema.Types.ObjectId, default: null },
});
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
schema.index({ accountId: 1, isActive: 1 });
schema.index({ accountId: 1, updatedAt: -1 });

/** AI agents (data-model.md §2.4). Function secret headers are sealed (`sealed` never leaves the API). */
export const AiAgentModel: Model<AiAgentDoc> =
  (mongoose.models.AiAgent as Model<AiAgentDoc> | undefined) ??
  mongoose.model<AiAgentDoc>('AiAgent', schema, 'aiAgents');
