import { z } from 'zod';

import {
  DISPOSITIONS,
  type AgentFunction,
  type AiAgentDoc,
  type BuiltInTool,
  type FunctionParam,
} from '../../db/models/ai-agent.model';

import type { ToolDefinition, ToolParametersSchema } from './types';

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Our parameter list → the JSON Schema the model sees. */
export const parametersSchema = (params: FunctionParam[]): ToolParametersSchema => ({
  type: 'object',
  properties: Object.fromEntries(
    params.map((p) => [
      p.name,
      p.type === 'enum'
        ? { type: 'string', description: p.description, enum: p.enumValues ?? [] }
        : { type: p.type, description: p.description },
    ]),
  ),
  required: params.filter((p) => p.required).map((p) => p.name),
  additionalProperties: false,
});

const paramValidator = (p: FunctionParam): z.ZodType => {
  switch (p.type) {
    case 'number':
      return z.number().finite();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'enum':
      return z.enum((p.enumValues ?? []) as [string, ...string[]]);
    default:
      return z.string().max(2000);
  }
};

/** The same parameter list → a strict zod validator for the model's arguments. */
export const argumentsValidator = (params: FunctionParam[]): z.ZodType<Record<string, unknown>> =>
  z.strictObject(
    Object.fromEntries(
      params.map((p) => [p.name, p.required ? paramValidator(p) : paramValidator(p).optional()]),
    ),
  );

export const functionToolDefinition = (
  fn: Pick<AgentFunction, 'name' | 'description' | 'parameters' | 'responseHint'>,
): ToolDefinition => ({
  name: fn.name,
  description: fn.responseHint ? `${fn.description}\n${fn.responseHint}` : fn.description,
  parameters: parametersSchema(fn.parameters),
});

const object = (
  properties: ToolParametersSchema['properties'],
  required: string[] = [],
): ToolParametersSchema => ({ type: 'object', properties, required, additionalProperties: false });

/** Built-in tools as the model sees them (only enabled ones are offered). */
export const builtInToolDefinition = (
  name: BuiltInTool,
  agent: Pick<AiAgentDoc, 'builtInTools'>,
): ToolDefinition => {
  const b = agent.builtInTools;
  switch (name) {
    case 'end_call':
      return {
        name,
        description:
          'End the conversation politely when the customer wants to stop or the matter is settled.',
        parameters: object({ reason: { type: 'string', description: 'Short reason' } }),
      };
    case 'transfer_to_human':
      return {
        name,
        description:
          'Hand the customer over to a human agent when they ask for a person or you cannot help.',
        parameters: object({ reason: { type: 'string', description: 'Why a person is needed' } }, [
          'reason',
        ]),
      };
    case 'set_disposition':
      return {
        name,
        description: 'Record the outcome of this conversation.',
        parameters: object(
          {
            disposition: { type: 'string', enum: b.setDisposition.allowed, description: 'Outcome' },
            note: { type: 'string', description: 'Optional short note' },
          },
          ['disposition'],
        ),
      };
    case 'schedule_callback':
      return {
        name,
        description: `Schedule a call back when the customer asks to be called later (within ${b.scheduleCallback.maxDaysAhead} days).`,
        parameters: object(
          {
            date: { type: 'string', description: 'YYYY-MM-DD' },
            time: { type: 'string', description: 'HH:mm, 24-hour, optional' },
            note: { type: 'string', description: 'Optional short note' },
          },
          ['date'],
        ),
      };
    case 'save_promise_to_pay':
      return {
        name,
        description: `Save the customer's promise to pay (date within ${b.savePromiseToPay.maxDaysAhead} days).`,
        parameters: object(
          {
            date: { type: 'string', description: 'YYYY-MM-DD the customer will pay by' },
            amountRupees: {
              type: 'string',
              description: 'Amount in rupees if the customer said one',
            },
          },
          ['date'],
        ),
      };
    case 'send_sms_after_call':
      return {
        name,
        description: 'Send one of the approved SMS messages after the conversation.',
        parameters: object(
          {
            templateKey: {
              type: 'string',
              enum: b.sendSmsAfterCall.templates.map((t) => t.key),
              description: 'Which message',
            },
          },
          ['templateKey'],
        ),
      };
  }
};

/** Which built-ins the agent has switched on. */
export const enabledBuiltIns = (agent: Pick<AiAgentDoc, 'builtInTools'>): BuiltInTool[] => {
  const b = agent.builtInTools;
  const on: [BuiltInTool, boolean][] = [
    ['end_call', b.endCall.enabled],
    ['transfer_to_human', b.transferToHuman.enabled],
    ['set_disposition', b.setDisposition.enabled && b.setDisposition.allowed.length > 0],
    ['schedule_callback', b.scheduleCallback.enabled],
    ['save_promise_to_pay', b.savePromiseToPay.enabled],
    ['send_sms_after_call', b.sendSmsAfterCall.enabled && b.sendSmsAfterCall.templates.length > 0],
  ];
  return on.filter(([, enabled]) => enabled).map(([name]) => name);
};

/** Every tool the model is offered: custom functions + enabled built-ins. */
export const agentToolDefinitions = (
  agent: Pick<AiAgentDoc, 'functions' | 'builtInTools'>,
): ToolDefinition[] => [
  ...agent.functions.map(functionToolDefinition),
  ...enabledBuiltIns(agent).map((name) => builtInToolDefinition(name, agent)),
];

/** Validators for built-in arguments (dates checked against the account day by the executor). */
export const BUILT_IN_ARGS = {
  end_call: z.strictObject({ reason: z.string().max(200).optional() }),
  transfer_to_human: z.strictObject({ reason: z.string().min(1).max(200) }),
  set_disposition: z.strictObject({
    disposition: z.enum(DISPOSITIONS),
    note: z.string().max(300).optional(),
  }),
  schedule_callback: z.strictObject({
    date: z.string().regex(YMD),
    time: z.string().regex(HM).optional(),
    note: z.string().max(300).optional(),
  }),
  save_promise_to_pay: z.strictObject({
    date: z.string().regex(YMD),
    amountRupees: z.string().max(20).optional(),
  }),
  send_sms_after_call: z.strictObject({ templateKey: z.string().min(1).max(40) }),
} as const satisfies Record<BuiltInTool, z.ZodType>;
