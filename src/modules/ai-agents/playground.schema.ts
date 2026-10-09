import { AI_LIMITS } from '../../config/limits';
import { DISPOSITIONS } from '../../db/models/ai-agent.model';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema } from '../../shared/validation/schemas';

export const PlaygroundAgentParams = z.strictObject({ id: ObjectIdSchema });
export const PlaygroundSessionParams = z.strictObject({ id: ObjectIdSchema, sid: ObjectIdSchema });

export const CreateSessionBody = z.strictObject({
  contactId: ObjectIdSchema.optional(),
  variables: z.record(z.string(), z.string().max(200)).optional(),
  testPhone: z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/, 'Use the +91… format')
    .optional()
    .openapi({
      description:
        'Used only by functions (`{{contact.phone}}`) — never sent to the AI, never returned',
    }),
});

export const ListSessionsQuery = z.strictObject({
  mine: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export const SendMessageBody = z.strictObject({
  text: z.string().trim().min(1).max(AI_LIMITS.messageMaxChars),
  clientTurnId: z.uuid().openapi({
    description: 'Sending the same id again returns the stored reply (no second charge)',
  }),
});

// ── Responses ─────────────────────────────────────────────────────────────

export const PlaygroundToolCallSchema = z.object({
  name: z.string(),
  kind: z.enum(['custom', 'built_in']),
  args: z.record(z.string(), z.unknown()).openapi({ description: 'Personal values masked' }),
  ok: z.boolean(),
  simulated: z.boolean(),
  durationMs: z.number(),
  resultPreview: z.string().nullable(),
  error: z.string().nullable(),
});

export const PlaygroundTurnSchema = registry.register(
  'PlaygroundTurn',
  z.object({
    id: z.string(),
    clientTurnId: z.string().nullable(),
    role: z.enum(['assistant', 'user']),
    text: z.string(),
    toolCalls: z.array(PlaygroundToolCallSchema),
    knowledge: z.array(z.object({ title: z.string(), snippet: z.string(), score: z.number() })),
    inputTokens: z.number(),
    outputTokens: z.number(),
    costMicros: z.number(),
    billing: z.enum(['none', 'charged', 'failed']),
    guardrail: z
      .string()
      .nullable()
      .openapi({ description: 'Rule a blocked reply broke (no text kept)' }),
    fallback: z.enum(['aiFailed', 'walletEmpty', 'agentOff', 'capReached']).nullable(),
    at: z.string(),
  }),
);

export const PlaygroundOutcomeSchema = z.object({
  disposition: z.enum(DISPOSITIONS).nullable(),
  promiseToPay: z.object({ date: z.string(), amountMicros: z.number().nullable() }).nullable(),
  callback: z.object({ date: z.string(), time: z.string().nullable() }).nullable(),
  transferRequested: z.boolean(),
  endRequested: z.boolean(),
  smsTemplate: z.string().nullable(),
});

export const PlaygroundSessionSchema = registry.register(
  'PlaygroundSession',
  z.object({
    id: z.string(),
    agentId: z.string(),
    userId: z.string(),
    contactId: z.string().nullable(),
    variables: z
      .record(z.string(), z.string())
      .openapi({ description: 'What the AI sees (allowed variables only)' }),
    hasTestPhone: z.boolean(),
    turns: z.array(PlaygroundTurnSchema),
    outcome: PlaygroundOutcomeSchema,
    status: z.enum(['active', 'ended']),
    costMicros: z.number(),
    expiresAt: z.string(),
    createdAt: z.string(),
  }),
);

export const PlaygroundSessionRowSchema = registry.register(
  'PlaygroundSessionRow',
  z.object({
    id: z.string(),
    userId: z.string(),
    status: z.enum(['active', 'ended']),
    turns: z.number(),
    costMicros: z.number(),
    lastText: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

export const PlaygroundReplySchema = registry.register(
  'PlaygroundReply',
  z.object({
    userTurn: PlaygroundTurnSchema,
    turn: PlaygroundTurnSchema,
    outcome: PlaygroundOutcomeSchema,
    status: z.enum(['active', 'ended']),
    replay: z
      .boolean()
      .openapi({ description: '`true` when the clientTurnId was already answered' }),
  }),
);

// ── OpenAPI paths ─────────────────────────────────────────────────────────

const tags = ['AI agents'];
const base = '/api/v1/agents/{id}/playground/sessions';
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});
const read = { 401: errors[401], 403: errors[403], 404: errors[404] };
const write = { ...read, 409: errors[409], 422: errors[422] };

registry.registerPath({
  method: 'post',
  path: base,
  tags,
  summary:
    'Start a test conversation (agents.write; not while impersonating). The opening line is turn 1 (no cost)',
  security: bearer,
  request: { params: PlaygroundAgentParams, ...json(CreateSessionBody) },
  responses: { 201: ok(PlaygroundSessionSchema, 'Created'), ...write },
});
registry.registerPath({
  method: 'get',
  path: base,
  tags,
  summary: 'Latest 20 test conversations of the agent (`mine=true` for your own)',
  security: bearer,
  request: { params: PlaygroundAgentParams, query: ListSessionsQuery },
  responses: { 200: ok(z.array(PlaygroundSessionRowSchema)), ...read },
});
registry.registerPath({
  method: 'get',
  path: `${base}/{sid}`,
  tags,
  summary: 'One test conversation with its turns (test phone never returned)',
  security: bearer,
  request: { params: PlaygroundSessionParams },
  responses: { 200: ok(PlaygroundSessionSchema), ...read },
});
registry.registerPath({
  method: 'post',
  path: `${base}/{sid}/messages`,
  tags,
  summary: `Send a message and get the agent's reply (${AI_LIMITS.playgroundPerMinute} / min / user; charged per turn; 422 AI_SPEND_CAP_REACHED when the cap is set to stop)`,
  security: bearer,
  request: { params: PlaygroundSessionParams, ...json(SendMessageBody) },
  responses: { 200: ok(PlaygroundReplySchema), ...write, 429: errors[429] },
});
registry.registerPath({
  method: 'post',
  path: `${base}/{sid}/reset`,
  tags,
  summary: 'End this conversation and start a fresh one with the same contact / values',
  security: bearer,
  request: { params: PlaygroundSessionParams },
  responses: { 201: ok(PlaygroundSessionSchema, 'Created'), ...write },
});
