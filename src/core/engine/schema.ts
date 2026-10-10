import { FLOW_LIMITS as L } from '../../config/limits';
import { AGENT_VOICES, DISPOSITIONS } from '../../db/models/ai-agent.model';
import {
  FLOW_TRIGGERS,
  FLOW_VAR_TYPES,
  NODE_TYPES,
  type NodeType,
} from '../../db/models/flow.model';
import { z } from '../../shared/openapi/zod';
import { RESULT_PATH } from '../ai/http-tool';

// ── Default texts (Hinglish, recovery-safe) ─────────────────────────────────

export const DEFAULT_INVALID_TEXT = 'Maaf kijiye, yeh option sahi nahi hai.';
export const DEFAULT_NO_INPUT_TEXT = 'Maaf kijiye, mujhe aapka jawab nahi mila.';
export const DEFAULT_ERROR_MESSAGE =
  'Maaf kijiye, abhi kuch takneeki samasya hai. Hum aapko baad mein call karenge.';

// ── Building blocks ─────────────────────────────────────────────────────────

export const NODE_ID = /^[A-Za-z0-9_-]{1,40}$/;
/** Ids of DTMF keys, intents and router rules (`key_<id>`, `intent_<id>`, `rule_<id>`). */
export const HANDLE_ID = /^[a-z0-9]{1,12}$/;
export const VARIABLE_NAME = /^[a-z][a-z0-9_]{0,39}$/;
export const DTMF_KEY = /^[0-9*#]$/;
export const OBJECT_ID = /^[a-f0-9]{24}$/i;
export const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
export const WA_TEMPLATE_NAME = /^[a-z0-9_]{1,60}$/;

const text = (max: number) => z.string().trim().max(max);
const required = (max: number) => text(max).min(1, 'Required');
const optionalText = (max: number) => text(max).nullable().default(null);
const int = (min: number, max: number) => z.number().int().min(min).max(max);
const objectId = z.string().regex(OBJECT_ID, 'Pick one');
const variableName = z.string().regex(VARIABLE_NAME, 'Use a-z, 0-9 and _ (start with a letter)');
const handleId = z.string().regex(HANDLE_ID, 'Use a-z and 0-9 (≤ 12)');

export const NODE_LANGUAGES = ['flow', 'hi', 'en', 'hinglish'] as const;
export const SPEECH_LANGUAGES = [...NODE_LANGUAGES, 'auto'] as const;
export const FLOW_LANGUAGES = ['hi', 'en', 'hinglish'] as const;
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH'] as const;
export const OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'gt',
  'gte',
  'lt',
  'lte',
  'is_empty',
  'is_not_empty',
  'in_list',
  'date_before',
  'date_after',
] as const;
export type Operator = (typeof OPERATORS)[number];
/** Operators that take no value. */
export const VALUELESS_OPERATORS: readonly Operator[] = ['is_empty', 'is_not_empty'];

/** Spoken prompt of a gather node: TTS text or an uploaded audio file. */
export const PromptSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('speak'), text: required(L.promptTextMaxChars) }),
  z.strictObject({
    kind: z.literal('audio'),
    audioId: objectId,
    fallbackText: optionalText(L.fallbackTextMaxChars),
  }),
]);

// ── Node configs (strict; used by the validator and the engine) ─────────────

const StartConfig = z.strictObject({
  triggers: z
    .array(z.enum(FLOW_TRIGGERS))
    .min(1, 'Pick at least one trigger')
    .refine((t) => new Set(t).size === t.length, 'Each trigger once')
    .default([...FLOW_TRIGGERS]),
});

const SpeakConfig = z.strictObject({
  text: required(L.speakTextMaxChars),
  language: z.enum(NODE_LANGUAGES).default('flow'),
  interruptible: z.boolean().default(true),
});

const PlayAudioConfig = z.strictObject({
  audioId: objectId,
  fallbackText: optionalText(L.fallbackTextMaxChars),
});

const gatherCommon = {
  prompt: PromptSchema,
  maxRetries: int(0, L.gatherRetriesMax).default(L.gatherRetriesDefault),
  invalidText: required(L.shortTextMaxChars).default(DEFAULT_INVALID_TEXT),
  noInputText: required(L.shortTextMaxChars).default(DEFAULT_NO_INPUT_TEXT),
};

const GatherDtmfConfig = z
  .strictObject({
    ...gatherCommon,
    mode: z.enum(['menu', 'digits']).default('menu'),
    keys: z
      .array(
        z.strictObject({
          id: handleId,
          key: z.string().regex(DTMF_KEY, 'One of 0–9, * or #'),
          label: text(L.labelMaxChars).default(''),
        }),
      )
      .max(L.dtmfKeysMax)
      .default([]),
    repeatKey: z.string().regex(DTMF_KEY).nullable().default(null),
    minDigits: int(1, L.digitsMax).default(1),
    maxDigits: int(1, L.digitsMax).default(4),
    finishKey: z.enum(['#', 'none']).default('#'),
    saveAs: variableName.nullable().default(null),
    timeoutSec: int(L.gatherTimeoutSecMin, L.gatherTimeoutSecMax).default(L.dtmfTimeoutSecDefault),
  })
  .superRefine((c, ctx) => {
    if (c.mode === 'menu' && c.keys.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['keys'], message: 'Add at least one key' });
    }
    if (c.mode === 'digits' && c.minDigits > c.maxDigits) {
      ctx.addIssue({ code: 'custom', path: ['minDigits'], message: 'Must be ≤ max digits' });
    }
  });

const GatherSpeechConfig = z.strictObject({
  ...gatherCommon,
  saveAs: variableName.nullable().default(null),
  language: z.enum(SPEECH_LANGUAGES).default('flow'),
  timeoutSec: int(L.gatherTimeoutSecMin, L.gatherTimeoutSecMax).default(L.speechTimeoutSecDefault),
  intents: z
    .array(
      z.strictObject({
        id: handleId,
        label: required(L.labelMaxChars),
        keywords: z.array(required(L.keywordMaxChars)).min(1).max(L.keywordsPerIntent),
      }),
    )
    .max(L.intentsMax)
    .default([]),
  matchMode: z.enum(['keywords', 'ai']).default('keywords'),
});

const AiAgentConfig = z.strictObject({
  agentId: objectId,
  goal: optionalText(L.aiGoalMaxChars),
  passVariables: z.array(variableName).max(L.aiPassVariablesMax).default([]),
  maxTurns: int(1, L.aiMaxTurnsMax).default(L.aiMaxTurnsDefault),
  speakOpeningLine: z.boolean().default(true),
});

/** Stored header: secret values only as `sealed` + `valueHint` (never plain). */
export const ApiHeaderSchema = z.strictObject({
  name: z.string().regex(HEADER_NAME, 'Letters, digits and - only'),
  secret: z.boolean().default(false),
  value: z.string().max(2000).nullable().default(null),
  sealed: z.string().optional(),
  valueHint: z.string().optional(),
});

const ApiRequestConfig = z
  .strictObject({
    method: z.enum(HTTP_METHODS).default('GET'),
    url: required(2000),
    headers: z.array(ApiHeaderSchema).max(L.apiHeadersMax).default([]),
    bodyTemplate: z.string().max(10_000).nullable().default(null),
    timeoutMs: int(1000, 10_000).default(6000),
    saveResponse: z
      .array(
        z.strictObject({
          path: z.string().regex(RESULT_PATH, 'Like data.status (≤ 5 levels)'),
          variable: variableName,
        }),
      )
      .max(L.apiSaveResponseMax)
      .default([]),
  })
  .superRefine((c, ctx) => {
    if (c.bodyTemplate === null || c.bodyTemplate.trim() === '') return;
    try {
      JSON.parse(c.bodyTemplate);
    } catch {
      ctx.addIssue({ code: 'custom', path: ['bodyTemplate'], message: 'Must be valid JSON' });
    }
  });

const ConditionRouterConfig = z.strictObject({
  rules: z
    .array(
      z.strictObject({
        id: handleId,
        label: text(L.labelMaxChars).default(''),
        match: z.enum(['all', 'any']).default('all'),
        conditions: z
          .array(
            z
              .strictObject({
                variable: variableName,
                operator: z.enum(OPERATORS),
                value: z.string().max(L.shortTextMaxChars).nullable().default(null),
              })
              .superRefine((c, ctx) => {
                if (!VALUELESS_OPERATORS.includes(c.operator) && (c.value ?? '').trim() === '') {
                  ctx.addIssue({ code: 'custom', path: ['value'], message: 'Required' });
                }
              }),
          )
          .min(1)
          .max(L.ruleConditionsMax),
      }),
    )
    .min(1, 'Add at least one rule')
    .max(L.routerRulesMax),
});

const SetVariableConfig = z.strictObject({
  assignments: z
    .array(
      z
        .strictObject({
          variable: variableName,
          op: z.enum(['set', 'increment', 'clear']).default('set'),
          value: z.string().max(L.speakTextMaxChars).nullable().default(null),
        })
        .superRefine((a, ctx) => {
          if (a.op !== 'clear' && (a.value ?? '').trim() === '') {
            ctx.addIssue({ code: 'custom', path: ['value'], message: 'Required' });
          }
        }),
    )
    .min(1, 'Add at least one assignment')
    .max(L.assignmentsMax),
});

const SetDispositionConfig = z.strictObject({
  disposition: z.enum(DISPOSITIONS),
  note: optionalText(200),
});

const TransferConfig = z.strictObject({
  phone: required(60),
  announcement: optionalText(L.shortTextMaxChars),
  timeoutSec: int(L.transferTimeoutSecMin, L.transferTimeoutSecMax).default(
    L.transferTimeoutSecDefault,
  ),
});

const SendSmsConfig = z.strictObject({
  text: required(L.smsMaxChars),
  dltTemplateId: optionalText(30),
});

const SendWhatsappConfig = z.strictObject({
  templateName: z.string().regex(WA_TEMPLATE_NAME, 'Use a-z, 0-9 and _'),
  language: z.enum(['hi', 'en']).default('hi'),
  params: z.array(text(L.shortTextMaxChars)).max(L.waTemplateParamsMax).default([]),
});

const WaitConfig = z.strictObject({ seconds: int(1, L.waitSecMax).default(5) });

const HangupConfig = z.strictObject({
  text: optionalText(L.fallbackTextMaxChars),
  disposition: z.enum(DISPOSITIONS).nullable().default(null),
});

/** Strict config schema per node type (PHASE_6_PLAN §1d). */
export const NODE_CONFIG_SCHEMAS = {
  start: StartConfig,
  speak: SpeakConfig,
  play_audio: PlayAudioConfig,
  gather_dtmf: GatherDtmfConfig,
  gather_speech: GatherSpeechConfig,
  ai_agent: AiAgentConfig,
  api_request: ApiRequestConfig,
  condition_router: ConditionRouterConfig,
  set_variable: SetVariableConfig,
  set_disposition: SetDispositionConfig,
  transfer_to_agent: TransferConfig,
  send_sms: SendSmsConfig,
  send_whatsapp: SendWhatsappConfig,
  wait: WaitConfig,
  hangup: HangupConfig,
} as const satisfies Record<NodeType, z.ZodType>;

export type NodeConfigs = { [T in NodeType]: z.output<(typeof NODE_CONFIG_SCHEMAS)[T]> };
export type NodeConfig<T extends NodeType = NodeType> = NodeConfigs[T];

// ── Graph (structural; configs are checked by the validator) ────────────────

const position = z.number().finite().min(-L.positionAbsMax).max(L.positionAbsMax);

export const FlowVariableSchema = z.strictObject({
  name: variableName,
  type: z.enum(FLOW_VAR_TYPES),
  label: text(L.labelMaxChars).optional(),
  default: z
    .union([z.string().max(L.shortTextMaxChars), z.number().finite(), z.boolean()])
    .nullable()
    .optional(),
});

export const FlowSettingsSchema = z.strictObject({
  language: z.enum(FLOW_LANGUAGES).default('hinglish'),
  voice: z.enum(AGENT_VOICES).default('coral'),
  errorMessage: required(L.shortTextMaxChars).default(DEFAULT_ERROR_MESSAGE),
  onError: z.enum(['hangup', 'transfer']).default('hangup'),
  errorTransferPhone: text(20).nullable().default(null),
  maxDurationSec: int(L.flowMaxDurationSecMin, L.flowMaxDurationSecMax).default(
    L.flowMaxDurationSecDefault,
  ),
});

export const FlowEdgeSchema = z.strictObject({
  id: z.string().regex(NODE_ID),
  source: z.string().regex(NODE_ID),
  sourceHandle: z.string().regex(/^[a-z0-9_]{1,40}$/),
  target: z.string().regex(NODE_ID),
});

/** A node as saved in a draft: any config object (incomplete configs are issues, not errors). */
export const DraftNodeSchema = z.strictObject({
  id: z.string().regex(NODE_ID, 'Letters, digits, _ and - (≤ 40)'),
  type: z.enum(NODE_TYPES),
  label: text(L.labelMaxChars).optional(),
  position: z.strictObject({ x: position, y: position }),
  config: z.record(z.string(), z.unknown()).default({}),
});

const uniqueBy = <T>(items: T[], key: (item: T) => string) =>
  new Set(items.map(key)).size === items.length;

/** Structural graph schema for draft saves, imports and versions. */
export const FlowGraphSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    nodes: z.array(DraftNodeSchema).max(L.nodesMax),
    edges: z.array(FlowEdgeSchema).max(L.edgesMax),
    variables: z.array(FlowVariableSchema).max(L.variablesMax).default([]),
    settings: FlowSettingsSchema.default(FlowSettingsSchema.parse({})),
    viewport: z
      .strictObject({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().positive() })
      .optional(),
  })
  .superRefine((g, ctx) => {
    if (!uniqueBy(g.nodes, (n) => n.id)) {
      ctx.addIssue({ code: 'custom', path: ['nodes'], message: 'Node ids must be unique' });
    }
    if (!uniqueBy(g.edges, (e) => e.id)) {
      ctx.addIssue({ code: 'custom', path: ['edges'], message: 'Edge ids must be unique' });
    }
    if (!uniqueBy(g.variables, (v) => v.name)) {
      ctx.addIssue({
        code: 'custom',
        path: ['variables'],
        message: 'Variable names must be unique',
      });
    }
  });

export type FlowGraph = z.output<typeof FlowGraphSchema>;
export type FlowNode = FlowGraph['nodes'][number];
export type FlowEdge = z.output<typeof FlowEdgeSchema>;
export type FlowVariable = z.output<typeof FlowVariableSchema>;
export type FlowSettings = z.output<typeof FlowSettingsSchema>;

/** Typed node (config parsed) — what the engine works with. */
export type TypedNode<T extends NodeType = NodeType> = Omit<FlowNode, 'type' | 'config'> & {
  type: T;
  config: NodeConfig<T>;
};

export type ConfigParse<T extends NodeType> =
  { ok: true; config: NodeConfig<T> } | { ok: false; errors: { path: string; message: string }[] };

/** Parses a node's config with its strict schema (defaults filled). */
export const parseNodeConfig = <T extends NodeType>(type: T, config: unknown): ConfigParse<T> => {
  const result = NODE_CONFIG_SCHEMAS[type].safeParse(config);
  if (result.success) return { ok: true, config: result.data as NodeConfig<T> };
  return {
    ok: false,
    errors: result.error.issues.map((i) => ({
      path: ['config', ...i.path.map(String)].join('.'),
      message: i.message,
    })),
  };
};

/** An empty, valid graph: start → hangup (new blank flows). */
export const blankGraph = (): FlowGraph =>
  FlowGraphSchema.parse({
    schemaVersion: 1,
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
      {
        id: 'hangup',
        type: 'hangup',
        position: { x: 0, y: 200 },
        config: { text: 'Dhanyavaad, namaste.' },
      },
    ],
    edges: [{ id: 'e_start', source: 'start', sourceHandle: 'next', target: 'hangup' }],
  });
