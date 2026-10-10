import { FLOW_LIMITS } from '../../config/limits';
import { AGENT_VOICES, DISPOSITIONS } from '../../db/models/ai-agent.model';
import {
  FLOW_TRIGGERS,
  FLOW_VAR_TYPES,
  NODE_TYPES,
  type NodeType,
} from '../../db/models/flow.model';

import { DYNAMIC_EXITS, STATIC_EXITS, isWaiting, type ExitInfo } from './exits';
import {
  FLOW_LANGUAGES,
  HTTP_METHODS,
  OPERATORS,
  SPEECH_LANGUAGES,
  VALUELESS_OPERATORS,
  parseNodeConfig,
} from './schema';
import { SYSTEM_VARIABLES } from './variables';

export const NODE_GROUPS = ['start', 'say_listen', 'ai', 'logic', 'actions', 'end'] as const;
export type NodeGroup = (typeof NODE_GROUPS)[number];

export interface NodeCatalogEntry {
  type: NodeType;
  label: string;
  group: NodeGroup;
  description: string;
  waits: boolean;
  staticExits: readonly ExitInfo[];
  dynamicExits: 'keys' | 'intents' | 'rules' | null;
  /** Config a new palette node starts with (may still need fields — e.g. the agent). */
  defaults: Record<string, unknown>;
}

const META: Record<
  NodeType,
  { label: string; group: NodeGroup; description: string; seed: Record<string, unknown> }
> = {
  start: {
    label: 'Start',
    group: 'start',
    description: 'Where every call begins (campaign, inbound, API or test).',
    seed: {},
  },
  speak: {
    label: 'Speak',
    group: 'say_listen',
    description: 'Say a text (with {{variables}}) to the customer.',
    seed: { text: 'Namaste {{name}}!' },
  },
  play_audio: {
    label: 'Play audio',
    group: 'say_listen',
    description: 'Play an uploaded MP3 / WAV file.',
    seed: { audioId: '' },
  },
  gather_dtmf: {
    label: 'Keypad menu',
    group: 'say_listen',
    description: 'Ask a question and branch on the key pressed (or collect digits).',
    seed: {
      prompt: { kind: 'speak', text: 'Haan ke liye 1 dabaiye, nahi ke liye 2 dabaiye.' },
      keys: [
        { id: 'k1', key: '1', label: 'Haan' },
        { id: 'k2', key: '2', label: 'Nahi' },
      ],
    },
  },
  gather_speech: {
    label: 'Listen',
    group: 'say_listen',
    description: 'Ask a question, save the spoken answer, optionally branch on intents.',
    seed: { prompt: { kind: 'speak', text: 'Aap kya kehna chahenge?' } },
  },
  ai_agent: {
    label: 'AI agent',
    group: 'ai',
    description: 'Let an AI agent talk; its outcome (paid, promise, transfer …) picks the exit.',
    seed: { agentId: '' },
  },
  api_request: {
    label: 'API request',
    group: 'logic',
    description: 'Call your system; save response fields into variables.',
    seed: { url: '' },
  },
  condition_router: {
    label: 'Condition',
    group: 'logic',
    description: 'If / else on variables (first matching rule wins).',
    seed: {
      rules: [
        {
          id: 'r1',
          label: 'Rule 1',
          conditions: [{ variable: '', operator: 'equals', value: '' }],
        },
      ],
    },
  },
  set_variable: {
    label: 'Set variable',
    group: 'logic',
    description: 'Set, increase or clear flow variables.',
    seed: { assignments: [{ variable: '', op: 'set', value: '' }] },
  },
  set_disposition: {
    label: 'Set disposition',
    group: 'actions',
    description: 'Record the call outcome (paid, promise to pay …).',
    seed: { disposition: 'other' },
  },
  transfer_to_agent: {
    label: 'Transfer',
    group: 'actions',
    description: 'Transfer the call to a person.',
    seed: { phone: '' },
  },
  send_sms: {
    label: 'Send SMS',
    group: 'actions',
    description: 'Queue an SMS sent after the call.',
    seed: { text: '' },
  },
  send_whatsapp: {
    label: 'Send WhatsApp',
    group: 'actions',
    description: 'Queue a WhatsApp template sent after the call.',
    seed: { templateName: '' },
  },
  wait: {
    label: 'Wait',
    group: 'actions',
    description: 'Pause in silence for a few seconds.',
    seed: {},
  },
  hangup: {
    label: 'Hang up',
    group: 'end',
    description: 'Say goodbye and end the call.',
    seed: { text: 'Dhanyavaad, namaste.' },
  },
};

const defaultsOf = (type: NodeType, seed: Record<string, unknown>): Record<string, unknown> => {
  const parsed = parseNodeConfig(type, seed);
  return parsed.ok ? parsed.config : seed;
};

/** Node catalogue — the single source for the builder palette, inspector and validator. */
export const NODE_CATALOG: readonly NodeCatalogEntry[] = NODE_TYPES.map((type) => ({
  type,
  label: META[type].label,
  group: META[type].group,
  description: META[type].description,
  waits: isWaiting(type),
  staticExits: STATIC_EXITS[type],
  dynamicExits: DYNAMIC_EXITS[type] ?? null,
  defaults: defaultsOf(type, META[type].seed),
}));

/** `GET /flows/catalog` payload. */
export const flowCatalog = () => ({
  nodes: NODE_CATALOG,
  groups: NODE_GROUPS,
  operators: OPERATORS.map((op) => ({
    operator: op,
    needsValue: !VALUELESS_OPERATORS.includes(op),
  })),
  dispositions: DISPOSITIONS,
  languages: FLOW_LANGUAGES,
  speechLanguages: SPEECH_LANGUAGES,
  voices: AGENT_VOICES,
  triggers: FLOW_TRIGGERS,
  variableTypes: FLOW_VAR_TYPES,
  httpMethods: HTTP_METHODS,
  systemVariables: SYSTEM_VARIABLES,
  limits: FLOW_LIMITS,
});
