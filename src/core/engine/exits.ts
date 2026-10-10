import type { NodeType } from '../../db/models/flow.model';

import type { FlowNode } from './schema';

export interface ExitInfo {
  handle: string;
  label: string;
  /** Required exits must be connected before publishing. */
  required: boolean;
  /** `error` exits are drawn red; unconnected ones go to the flow error handler. */
  kind: 'normal' | 'error';
}

const exit = (handle: string, label: string, required = false): ExitInfo => ({
  handle,
  label,
  required,
  kind: handle === 'error' ? 'error' : 'normal',
});

const ERROR = exit('error', 'Error');

/** AI agent outcomes, in the order they are checked (PHASE_6_PLAN §1g). */
export const AI_EXITS: readonly ExitInfo[] = [
  exit('transfer', 'Transfer requested'),
  exit('paid', 'Paid'),
  exit('promise_to_pay', 'Promise to pay'),
  exit('callback', 'Callback'),
  exit('wrong_number', 'Wrong number'),
  exit('resolved', 'Resolved', true),
  exit('no_response', 'No response'),
  ERROR,
];

/** Exits that never depend on the config. */
export const STATIC_EXITS: Record<NodeType, readonly ExitInfo[]> = {
  start: [exit('next', 'Next', true)],
  speak: [exit('next', 'Next', true), ERROR],
  play_audio: [exit('next', 'Next', true), ERROR],
  gather_dtmf: [exit('no_input', 'No input'), exit('invalid', 'Invalid'), ERROR],
  gather_speech: [exit('no_input', 'No input'), ERROR],
  ai_agent: AI_EXITS,
  api_request: [exit('success', 'Success', true), exit('failure', 'Failure'), ERROR],
  condition_router: [exit('else', 'Else', true)],
  set_variable: [exit('next', 'Next', true), ERROR],
  set_disposition: [exit('next', 'Next', true)],
  // `connected` ends the run (reason transferred) — no handle
  transfer_to_agent: [exit('failed', 'Failed'), exit('no_answer', 'No answer'), ERROR],
  send_sms: [exit('next', 'Next', true)],
  send_whatsapp: [exit('next', 'Next', true)],
  wait: [exit('next', 'Next', true)],
  hangup: [],
};

/** Which config list produces extra handles (builder + catalog). */
export const DYNAMIC_EXITS: Partial<Record<NodeType, 'keys' | 'intents' | 'rules'>> = {
  gather_dtmf: 'keys',
  gather_speech: 'intents',
  condition_router: 'rules',
};

const items = (config: unknown, key: string): Record<string, unknown>[] => {
  const list = (config as Record<string, unknown> | null | undefined)?.[key];
  return Array.isArray(list)
    ? list.filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
    : [];
};
const str = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback;

/**
 * Every exit of a node, dynamic ones first (`key_<id>`, `intent_<id>`, `rule_<id>`).
 * Reads the config defensively — an incomplete draft still gets its handles.
 */
export const exitsOf = (node: Pick<FlowNode, 'type' | 'config'>): ExitInfo[] => {
  const { type, config } = node;
  if (type === 'gather_dtmf') {
    const digits = (config as { mode?: unknown }).mode === 'digits';
    const head = digits
      ? [exit('next', 'Next', true)]
      : items(config, 'keys').map((k) =>
          exit(
            `key_${String(k.id)}`,
            `Press ${str(k.key, '?')}${str(k.label, '') ? ` · ${str(k.label, '')}` : ''}`,
            true,
          ),
        );
    return [...head, ...STATIC_EXITS.gather_dtmf];
  }
  if (type === 'gather_speech') {
    const intents = items(config, 'intents');
    const head = intents.length
      ? [
          ...intents.map((i) => exit(`intent_${String(i.id)}`, str(i.label, String(i.id)), true)),
          exit('no_match', 'No match'),
        ]
      : [exit('next', 'Next', true)];
    return [...head, ...STATIC_EXITS.gather_speech];
  }
  if (type === 'condition_router') {
    const rules = items(config, 'rules').map((r, i) =>
      exit(`rule_${String(r.id)}`, str(r.label, `Rule ${String(i + 1)}`), true),
    );
    return [...rules, ...STATIC_EXITS.condition_router];
  }
  return [...STATIC_EXITS[type]];
};

export const requiredExits = (node: Pick<FlowNode, 'type' | 'config'>): ExitInfo[] =>
  exitsOf(node).filter((e) => e.required);

export const optionalExits = (node: Pick<FlowNode, 'type' | 'config'>): ExitInfo[] =>
  exitsOf(node).filter((e) => !e.required);

/** Nodes that stop and wait for the customer / a timer / a transfer result. */
const WAITING: ReadonlySet<NodeType> = new Set([
  'gather_dtmf',
  'gather_speech',
  'ai_agent',
  'transfer_to_agent',
  'wait',
]);
export const isWaiting = (type: NodeType): boolean => WAITING.has(type);

/** Ends a call: `hangup`, and `transfer_to_agent` (the call leaves the bot). */
export const isEnding = (type: NodeType): boolean =>
  type === 'hangup' || type === 'transfer_to_agent';
