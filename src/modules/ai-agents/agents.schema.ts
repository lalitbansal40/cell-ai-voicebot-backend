import { AI_LIMITS } from '../../config/limits';
import {
  AGENT_LANGUAGES,
  AGENT_VOICES,
  BUILT_IN_TOOLS,
  COMPLIANCE_MODES,
  DISPOSITIONS,
  FUNCTION_METHODS,
  LANGUAGE_MODES,
  ON_CAP,
  PARAM_TYPES,
  TONE_TRIGGERS,
} from '../../db/models/ai-agent.model';
import { OffsetPageMetaSchema } from '../../shared/openapi/common.schemas';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, noContentResponse, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema, PaginationQuerySchema } from '../../shared/validation/schemas';

const text = (max: number) => z.string().trim().max(max);
const micros = z.number().int().min(0).max(AI_LIMITS.spendCapMaxMicros);
const E164 = /^\+[1-9]\d{6,14}$/;

export const AgentParams = z.strictObject({ id: ObjectIdSchema });

export const ListAgentsQuery = z.strictObject({
  ...PaginationQuerySchema.shape,
  q: z.string().trim().min(1).max(80).optional(),
  activeOnly: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export const CreateAgentBody = z.strictObject({
  name: text(AI_LIMITS.nameMaxChars).min(1),
  description: text(AI_LIMITS.descriptionMaxChars).nullable().optional(),
  templateKey: z.string().max(40).optional(),
});

export const ToneRuleBody = z
  .strictObject({
    when: z.enum(TONE_TRIGGERS),
    customWhen: text(100).nullable().optional(),
    respond: text(AI_LIMITS.toneRespondMaxChars).min(1),
  })
  .refine((r) => r.when !== 'custom' || Boolean(r.customWhen), {
    message: 'Describe when this rule applies',
    path: ['customWhen'],
  });

export const BuiltInToolsBody = z.strictObject({
  endCall: z.strictObject({ enabled: z.boolean() }).optional(),
  transferToHuman: z
    .strictObject({
      enabled: z.boolean(),
      phone: z
        .string()
        .regex(E164, 'Use an international number like +919876543210')
        .nullable()
        .optional(),
      message: text(AI_LIMITS.lineMaxChars).nullable().optional(),
    })
    .optional(),
  setDisposition: z
    .strictObject({
      enabled: z.boolean(),
      allowed: z.array(z.enum(DISPOSITIONS)).max(DISPOSITIONS.length),
    })
    .optional(),
  scheduleCallback: z
    .strictObject({ enabled: z.boolean(), maxDaysAhead: z.number().int().min(1).max(30) })
    .optional(),
  savePromiseToPay: z
    .strictObject({ enabled: z.boolean(), maxDaysAhead: z.number().int().min(1).max(60) })
    .optional(),
  sendSmsAfterCall: z
    .strictObject({
      enabled: z.boolean(),
      templates: z
        .array(
          z.strictObject({
            key: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'Use lower-case letters, digits and _'),
            text: text(500).min(1),
          }),
        )
        .max(10)
        .refine(
          (list) => new Set(list.map((t) => t.key)).size === list.length,
          'Template keys must be unique',
        ),
    })
    .optional(),
});

export const UpdateAgentBody = z
  .strictObject({
    name: text(AI_LIMITS.nameMaxChars).min(1),
    description: text(AI_LIMITS.descriptionMaxChars).nullable(),
    persona: text(AI_LIMITS.personaMaxChars),
    openingLine: text(AI_LIMITS.lineMaxChars),
    closingLine: text(AI_LIMITS.lineMaxChars),
    allowedVariables: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/)).max(30),
    voice: z.enum(AGENT_VOICES),
    languageMode: z.enum(LANGUAGE_MODES),
    language: z.enum(AGENT_LANGUAGES),
    toneRules: z.array(ToneRuleBody).max(AI_LIMITS.toneRulesMax),
    callBehaviour: z.strictObject({
      maxCallDurationSec: z.number().int().min(60).max(1800).optional(),
      silenceTimeoutSec: z.number().int().min(3).max(30).optional(),
      bargeIn: z.boolean().optional(),
      endCallAfterSilenceRetries: z.number().int().min(1).max(3).optional(),
    }),
    model: z.strictObject({
      textModel: z.string().max(64).optional(),
      temperatureTenths: z.number().int().min(0).max(AI_LIMITS.temperatureTenthsMax).optional(),
      maxOutputTokens: z
        .number()
        .int()
        .min(AI_LIMITS.maxOutputTokensMin)
        .max(AI_LIMITS.maxOutputTokensMax)
        .optional(),
    }),
    limits: z.strictObject({
      dailySpendCapMicros: micros.optional(),
      monthlySpendCapMicros: micros.optional(),
      onCap: z.enum(ON_CAP).optional(),
    }),
    guardrails: z.strictObject({
      neverSay: z
        .array(text(AI_LIMITS.neverSayMaxChars).min(1))
        .max(AI_LIMITS.neverSayMax)
        .optional(),
      disclosureLine: text(AI_LIMITS.lineMaxChars).optional(),
      complianceMode: z.enum(COMPLIANCE_MODES).optional(),
    }),
    fallback: z.strictObject({
      aiFailed: text(AI_LIMITS.fallbackMaxChars).min(1).optional(),
      walletEmpty: text(AI_LIMITS.fallbackMaxChars).min(1).optional(),
      agentOff: text(AI_LIMITS.fallbackMaxChars).min(1).optional(),
      capReached: text(AI_LIMITS.fallbackMaxChars).min(1).optional(),
    }),
    knowledge: z.strictObject({
      knowledgeBaseIds: z.array(ObjectIdSchema).max(AI_LIMITS.kbPerAgent).optional(),
      topK: z.number().int().min(1).max(8).optional(),
      minScoreHundredths: z.number().int().min(0).max(100).optional(),
    }),
    builtInTools: BuiltInToolsBody,
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

export const CompilePreviewBody = z.strictObject({
  contactId: ObjectIdSchema.optional(),
  variables: z.record(z.string(), z.string().max(200)).optional(),
  channel: z.enum(['text', 'voice']).default('text'),
});

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

export const FunctionParamBody = z
  .strictObject({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Use a-z, 0-9 and _ (start with a letter)'),
    type: z.enum(PARAM_TYPES),
    description: text(300).default(''),
    required: z.boolean().default(false),
    enumValues: z.array(z.string().trim().min(1).max(60)).min(1).max(20).optional(),
  })
  .refine((p) => p.type !== 'enum' || (p.enumValues?.length ?? 0) > 0, {
    path: ['enumValues'],
    message: 'Add at least one value',
  });

export const FunctionHeaderBody = z.strictObject({
  name: z.string().regex(HEADER_NAME, 'Letters, digits and - only'),
  secret: z.boolean().default(false),
  value: z
    .string()
    .max(2000)
    .nullable()
    .openapi({ description: 'Secret headers: send `null` to keep the stored value' }),
});

const functionFields = {
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_]{2,39}$/, '3–40 characters: a-z, 0-9 and _ (start with a letter)'),
  description: text(500).min(10),
  parameters: z.array(FunctionParamBody).max(AI_LIMITS.paramsPerFunction),
  method: z.enum(FUNCTION_METHODS),
  url: z.string().trim().min(1).max(2000),
  headers: z.array(FunctionHeaderBody).max(10),
  bodyTemplate: z.string().max(10_000).nullable(),
  resultPath: z
    .string()
    .regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){0,4}$/, 'Dot path, at most 5 parts')
    .nullable(),
  responseHint: text(300).nullable(),
  timeoutMs: z
    .number()
    .int()
    .min(AI_LIMITS.functionTimeoutMsMin)
    .max(AI_LIMITS.functionTimeoutMsMax),
};

export const CreateFunctionBody = z.strictObject({
  ...functionFields,
  parameters: functionFields.parameters.default([]),
  headers: functionFields.headers.default([]),
  bodyTemplate: functionFields.bodyTemplate.optional(),
  resultPath: functionFields.resultPath.optional(),
  responseHint: functionFields.responseHint.optional(),
  timeoutMs: functionFields.timeoutMs.default(AI_LIMITS.functionTimeoutMsDefault),
});

export const UpdateFunctionBody = z
  .strictObject(functionFields)
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

export const FunctionParams = z.strictObject({ id: ObjectIdSchema, fnId: ObjectIdSchema });

export const TestFunctionBody = z.strictObject({
  args: z.record(z.string(), z.unknown()).default({}),
  contactId: ObjectIdSchema.optional(),
  testPhone: z.string().regex(E164, 'Use the +91… format').optional(),
});

// ── Responses ─────────────────────────────────────────────────────────────

export const FunctionParamSchema = z.object({
  name: z.string(),
  type: z.enum(PARAM_TYPES),
  description: z.string(),
  required: z.boolean(),
  enumValues: z.array(z.string()).optional(),
});

export const FunctionHeaderSchema = z.object({
  name: z.string(),
  secret: z.boolean(),
  value: z
    .string()
    .nullable()
    .openapi({ description: 'Plain headers only; secret ones are never returned' }),
  valueHint: z.string().nullable().openapi({ description: '`••••1234` for secret headers' }),
});

export const AgentFunctionSchema = registry.register(
  'AgentFunction',
  z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    parameters: z.array(FunctionParamSchema),
    method: z.enum(FUNCTION_METHODS),
    url: z.string(),
    headers: z.array(FunctionHeaderSchema),
    bodyTemplate: z.string().nullable(),
    resultPath: z.string().nullable(),
    responseHint: z.string().nullable(),
    timeoutMs: z.number(),
  }),
);

export const FunctionTestResultSchema = registry.register(
  'AgentFunctionTestResult',
  z.object({
    ok: z.boolean(),
    httpStatus: z.number().nullable(),
    durationMs: z.number(),
    result: z.string().openapi({ description: 'What the AI would see (≤ 2,000 chars)' }),
    warnings: z.array(z.string()),
    error: z.string().nullable().openapi({
      description:
        'blocked · timeout · too_large · invalid_json · network · too_many_redirects · invalid_request · secret_unavailable · invalid_arguments · http_<status>',
    }),
    details: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional()
      .openapi({ description: 'Why the arguments were refused (`invalid_arguments`)' }),
  }),
);

export const AgentSchema = registry.register(
  'Agent',
  z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    persona: z.string(),
    openingLine: z.string(),
    closingLine: z.string(),
    isActive: z.boolean(),
    templateKey: z.string().nullable(),
    allowedVariables: z.array(z.string()),
    voice: z.enum(AGENT_VOICES),
    languageMode: z.enum(LANGUAGE_MODES),
    language: z.enum(AGENT_LANGUAGES),
    toneRules: z.array(
      z.object({
        when: z.enum(TONE_TRIGGERS),
        customWhen: z.string().nullable(),
        respond: z.string(),
      }),
    ),
    callBehaviour: z.object({
      maxCallDurationSec: z.number(),
      silenceTimeoutSec: z.number(),
      bargeIn: z.boolean(),
      endCallAfterSilenceRetries: z.number(),
    }),
    model: z.object({
      textModel: z.string(),
      temperatureTenths: z.number(),
      maxOutputTokens: z.number(),
    }),
    limits: z.object({
      dailySpendCapMicros: z.number(),
      monthlySpendCapMicros: z.number(),
      onCap: z.enum(ON_CAP),
    }),
    guardrails: z.object({
      neverSay: z.array(z.string()),
      disclosureLine: z.string(),
      complianceMode: z.enum(COMPLIANCE_MODES),
    }),
    fallback: z.object({
      aiFailed: z.string(),
      walletEmpty: z.string(),
      agentOff: z.string(),
      capReached: z.string(),
    }),
    knowledge: z.object({
      knowledgeBaseIds: z.array(z.string()),
      topK: z.number(),
      minScoreHundredths: z.number(),
    }),
    functions: z.array(AgentFunctionSchema),
    builtInTools: z.object({
      endCall: z.object({ enabled: z.boolean() }),
      transferToHuman: z.object({
        enabled: z.boolean(),
        phone: z.string().nullable(),
        message: z.string().nullable(),
      }),
      setDisposition: z.object({ enabled: z.boolean(), allowed: z.array(z.enum(DISPOSITIONS)) }),
      scheduleCallback: z.object({ enabled: z.boolean(), maxDaysAhead: z.number() }),
      savePromiseToPay: z.object({ enabled: z.boolean(), maxDaysAhead: z.number() }),
      sendSmsAfterCall: z.object({
        enabled: z.boolean(),
        templates: z.array(z.object({ key: z.string(), text: z.string() })),
      }),
    }),
    createdBy: z.string().nullable(),
    updatedBy: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

export const AgentRowSchema = registry.register(
  'AgentRow',
  z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    isActive: z.boolean(),
    voice: z.enum(AGENT_VOICES),
    languageMode: z.enum(LANGUAGE_MODES),
    language: z.enum(AGENT_LANGUAGES),
    knowledgeBases: z.number(),
    functions: z.number(),
    monthSpendMicros: z.number(),
    updatedAt: z.string(),
  }),
);

export const AgentTemplateSchema = registry.register(
  'AgentTemplate',
  z.object({ key: z.string(), title: z.string(), summary: z.string(), language: z.string() }),
);

export const AgentCatalogSchema = registry.register(
  'AgentCatalog',
  z.object({
    provider: z.enum(['openai', 'fake']),
    voices: z.array(z.enum(AGENT_VOICES)),
    languages: z.array(z.enum(AGENT_LANGUAGES)),
    toneTriggers: z.array(z.enum(TONE_TRIGGERS)),
    dispositions: z.array(z.enum(DISPOSITIONS)),
    builtInTools: z.array(z.enum(BUILT_IN_TOOLS)),
    textModels: z.array(z.string()),
    defaultTextModel: z.string(),
    variables: z.array(
      z.object({
        name: z.string(),
        label: z.string(),
        type: z.enum(['text', 'number', 'currency', 'date', 'phone', 'built_in']),
      }),
    ),
    limits: z.object({
      functionsPerAgent: z.number(),
      kbPerAgent: z.number(),
      personaMaxChars: z.number(),
      messageMaxChars: z.number(),
    }),
  }),
);

export const CompilePreviewSchema = registry.register(
  'AgentCompilePreview',
  z.object({
    instructions: z.string(),
    tools: z.array(z.object({ name: z.string(), description: z.string() })),
    openingLine: z.string(),
    closingLine: z.string(),
    variables: z.record(z.string(), z.string()),
    warnings: z.array(z.string()),
  }),
);

export const AgentUsageSchema = registry.register(
  'AgentUsage',
  z.object({
    today: z.object({ day: z.string(), spentMicros: z.number(), turns: z.number() }),
    month: z.object({
      month: z.string(),
      spentMicros: z.number(),
      turns: z.number(),
      inputTokens: z.number(),
      outputTokens: z.number(),
    }),
  }),
);

// ── OpenAPI paths ─────────────────────────────────────────────────────────

const tags = ['AI agents'];
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});
const read = { 401: errors[401], 403: errors[403] };
const write = { ...read, 404: errors[404], 409: errors[409], 422: errors[422] };
const byId = { params: AgentParams };

registry.registerPath({
  method: 'get',
  path: '/api/v1/agents',
  tags,
  summary: 'AI agents of the account (agents.read)',
  security: bearer,
  request: { query: ListAgentsQuery },
  responses: {
    200: {
      description: 'Agents',
      content: {
        'application/json': {
          schema: z.object({
            success: z.literal(true),
            data: z.array(AgentRowSchema),
            meta: OffsetPageMetaSchema,
          }),
        },
      },
    },
    ...read,
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/agents',
  tags,
  summary: 'Create an agent, blank or from a template (agents.write; not while impersonating)',
  security: bearer,
  request: json(CreateAgentBody),
  responses: { 201: ok(AgentSchema, 'Created'), ...write },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/agents/templates',
  tags,
  summary: 'Ready-made agent templates',
  security: bearer,
  responses: { 200: ok(z.array(AgentTemplateSchema)), ...read },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/agents/catalog',
  tags,
  summary:
    'Voices, languages, tone triggers, dispositions, models, variables and the AI provider in use',
  security: bearer,
  responses: { 200: ok(AgentCatalogSchema), ...read },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/agents/{id}',
  tags,
  summary: 'One agent (secret header values are never returned)',
  security: bearer,
  request: byId,
  responses: { 200: ok(AgentSchema), ...read, 404: errors[404] },
});
registry.registerPath({
  method: 'patch',
  path: '/api/v1/agents/{id}',
  tags,
  summary: 'Change an agent (only the fields sent; arrays are replaced)',
  security: bearer,
  request: { ...byId, ...json(UpdateAgentBody) },
  responses: { 200: ok(AgentSchema), ...write },
});
registry.registerPath({
  method: 'delete',
  path: '/api/v1/agents/{id}',
  tags,
  summary: 'Delete an agent (kept 30 days, then purged)',
  security: bearer,
  request: byId,
  responses: { 204: noContentResponse, ...read, 404: errors[404] },
});
for (const [action, summary] of [
  ['duplicate', 'Copy an agent ("… (copy)")'],
  ['activate', 'Turn an agent on'],
  ['deactivate', 'Turn an agent off'],
] as const) {
  registry.registerPath({
    method: 'post',
    path: `/api/v1/agents/{id}/${action}`,
    tags,
    summary,
    security: bearer,
    request: byId,
    responses: { [action === 'duplicate' ? 201 : 200]: ok(AgentSchema), ...write },
  });
}
registry.registerPath({
  method: 'post',
  path: '/api/v1/agents/{id}/compile-preview',
  tags,
  summary: 'What the AI will be told — compiled instructions, tools and warnings (no cost)',
  security: bearer,
  request: { ...byId, ...json(CompilePreviewBody) },
  responses: { 200: ok(CompilePreviewSchema), ...read, 404: errors[404], 422: errors[422] },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/agents/{id}/usage',
  tags,
  summary: "Today's and this month's spend of the agent (account timezone)",
  security: bearer,
  request: byId,
  responses: { 200: ok(AgentUsageSchema), ...read, 404: errors[404] },
});

const fnById = { params: FunctionParams };
registry.registerPath({
  method: 'post',
  path: '/api/v1/agents/{id}/functions',
  tags,
  summary: 'Add a custom API function (secret header values are sealed and write-only)',
  security: bearer,
  request: { ...byId, ...json(CreateFunctionBody) },
  responses: { 201: ok(AgentSchema, 'Created'), ...write },
});
registry.registerPath({
  method: 'patch',
  path: '/api/v1/agents/{id}/functions/{fnId}',
  tags,
  summary: 'Change a custom function (secret header `value: null` keeps the stored secret)',
  security: bearer,
  request: { ...fnById, ...json(UpdateFunctionBody) },
  responses: { 200: ok(AgentSchema), ...write },
});
registry.registerPath({
  method: 'delete',
  path: '/api/v1/agents/{id}/functions/{fnId}',
  tags,
  summary: 'Remove a custom function',
  security: bearer,
  request: fnById,
  responses: { 200: ok(AgentSchema), ...write },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/agents/{id}/functions/{fnId}/test',
  tags,
  summary:
    'Call the function once through the safe executor (20 / min / user). Request problems come back as `ok: false`',
  security: bearer,
  request: { ...fnById, ...json(TestFunctionBody) },
  responses: { 200: ok(FunctionTestResultSchema), ...write, 429: errors[429] },
});
