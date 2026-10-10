import { FLOW_LIMITS } from '../../config/limits';
import type { NodeType } from '../../db/models/flow.model';
import { urlBlockReason, type GuardPolicy } from '../ai/ip-guard';
import { templateTokens } from '../templating';

import { graphSizeBytes } from './canonical';
import { NODE_CATALOG } from './catalog';
import { exitsOf, isEnding, isWaiting } from './exits';
import { OBJECT_ID, VARIABLE_NAME, parseNodeConfig, type FlowGraph, type FlowNode } from './schema';
import {
  SERVER_ONLY_TOKENS,
  SYSTEM_VARIABLE_NAMES,
  buildVariableCatalog,
  type ContactVariableInfo,
  type VariableEntry,
} from './variables';

export const ISSUE_CODES = [
  'start_missing',
  'start_multiple',
  'start_has_input',
  'node_unreachable',
  'exit_required',
  'no_ending',
  'node_unconfigured',
  'edge_invalid',
  'variable_unknown',
  'variable_name_taken',
  'contact_token_not_allowed',
  'agent_missing',
  'agent_inactive',
  'audio_missing',
  'dtmf_duplicate_key',
  'dtmf_repeat_conflict',
  'silent_loop',
  'url_blocked',
  'transfer_phone_invalid',
  'error_exit_unconnected',
  'sms_long',
  'speak_long',
  'limits_exceeded',
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];

export interface Issue {
  severity: 'error' | 'warning';
  code: IssueCode;
  message: string;
  nodeId?: string;
  edgeId?: string;
  field?: string;
}

export interface ValidateContext {
  /** Contact variables of the account (`name`, `phone_last4`, custom field keys). */
  contactVars: readonly ContactVariableInfo[];
  /** Agents of the account referenced by the graph (missing / deleted = absent). */
  agents: ReadonlyMap<string, { active: boolean }>;
  /** Ready, non-deleted audio ids of the account. */
  audios: ReadonlySet<string>;
  /** Address rules for API nodes (`outgoingPolicy(env)`). */
  urlPolicy: GuardPolicy;
}

export const hasErrors = (issues: readonly Issue[]): boolean =>
  issues.some((i) => i.severity === 'error');

const TYPE_LABEL = new Map<NodeType, string>(NODE_CATALOG.map((n) => [n.type, n.label]));
const nameOf = (node: Pick<FlowNode, 'type' | 'label'>) =>
  `"${node.label?.trim() || TYPE_LABEL.get(node.type) || node.type}"`;

const IN_PHONE = /^\+91[6-9]\d{9}$/;
const SINGLE_TOKEN = /^\{\{\s*([^}]*?)\s*\}\}$/;

// ── Text fields that hold templates ─────────────────────────────────────────

interface TemplateField {
  field: string;
  text: string;
  /** `{{contact.phone}}` / `{{contact.external_id}}` allowed (API node only). */
  serverOnly: boolean;
}

const rec = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(rec) : [];
const strings = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const templateFields = (node: FlowNode): TemplateField[] => {
  const c = rec(node.config);
  const out: TemplateField[] = [];
  const add = (field: string, value: unknown, serverOnly = false) => {
    if (typeof value === 'string' && value)
      out.push({ field: `config.${field}`, text: value, serverOnly });
  };
  const prompt = rec(c.prompt);
  switch (node.type) {
    case 'speak':
    case 'send_sms':
    case 'hangup':
      add('text', c.text);
      break;
    case 'play_audio':
      add('fallbackText', c.fallbackText);
      break;
    case 'gather_dtmf':
    case 'gather_speech':
      add('prompt.text', prompt.text);
      add('prompt.fallbackText', prompt.fallbackText);
      add('invalidText', c.invalidText);
      add('noInputText', c.noInputText);
      break;
    case 'ai_agent':
      add('goal', c.goal);
      break;
    case 'api_request':
      add('url', c.url, true);
      add('bodyTemplate', c.bodyTemplate, true);
      list(c.headers).forEach((h, i) => {
        if (h.secret !== true) add(`headers.${String(i)}.value`, h.value, true);
      });
      break;
    case 'condition_router':
      list(c.rules).forEach((r, i) =>
        list(r.conditions).forEach((cond, j) =>
          add(`rules.${String(i)}.conditions.${String(j)}.value`, cond.value),
        ),
      );
      break;
    case 'set_variable':
      list(c.assignments).forEach((a, i) => add(`assignments.${String(i)}.value`, a.value));
      break;
    case 'set_disposition':
      add('note', c.note);
      break;
    case 'transfer_to_agent':
      add('phone', c.phone);
      add('announcement', c.announcement);
      break;
    case 'send_whatsapp':
      strings(c.params).forEach((p, i) => add(`params.${String(i)}`, p));
      break;
    default:
      break;
  }
  return out;
};

/** Variable names a node reads (`read`) or writes (`write`) outside templates. */
const variableRefs = (
  node: FlowNode,
): { field: string; name: string; write: boolean; flowOnly: boolean }[] => {
  const c = rec(node.config);
  const refs: { field: string; name: string; write: boolean; flowOnly: boolean }[] = [];
  const add = (field: string, name: unknown, write: boolean, flowOnly = write) => {
    if (typeof name === 'string' && name)
      refs.push({ field: `config.${field}`, name, write, flowOnly });
  };
  if (node.type === 'gather_dtmf' || node.type === 'gather_speech') add('saveAs', c.saveAs, true);
  if (node.type === 'condition_router') {
    list(c.rules).forEach((r, i) =>
      list(r.conditions).forEach((cond, j) =>
        add(`rules.${String(i)}.conditions.${String(j)}.variable`, cond.variable, false),
      ),
    );
  }
  if (node.type === 'set_variable') {
    list(c.assignments).forEach((a, i) =>
      add(`assignments.${String(i)}.variable`, a.variable, true),
    );
  }
  if (node.type === 'api_request') {
    list(c.saveResponse).forEach((s, i) =>
      add(`saveResponse.${String(i)}.variable`, s.variable, true),
    );
  }
  if (node.type === 'ai_agent') {
    strings(c.passVariables).forEach((v, i) => add(`passVariables.${String(i)}`, v, false, true));
  }
  return refs;
};

// ── Graph helpers ───────────────────────────────────────────────────────────

/** Tarjan's strongly connected components. */
const stronglyConnected = (ids: readonly string[], next: (id: string) => string[]): string[][] => {
  let index = 0;
  const indexOf = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];
  const visit = (v: string) => {
    indexOf.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of next(v)) {
      if (!indexOf.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) ?? 0, indexOf.get(w) ?? 0));
      }
    }
    if (low.get(v) === indexOf.get(v)) {
      const component: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop();
        if (w === undefined) break;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      out.push(component);
    }
  };
  for (const id of ids) if (!indexOf.has(id)) visit(id);
  return out;
};

const reachable = (from: string, next: (id: string) => string[]): Set<string> => {
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length) {
    const id = queue.shift() as string;
    for (const n of next(id)) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return seen;
};

// ── Validator ───────────────────────────────────────────────────────────────

/**
 * All issues of a graph (PHASE_6_PLAN §1e). Pure; deterministic order:
 * graph-level issues first, then by node order, then by code.
 */
export const validateFlow = (graph: FlowGraph, ctx: ValidateContext): Issue[] => {
  const issues: Issue[] = [];
  const push = (issue: Issue) => issues.push(issue);
  const nodes = graph.nodes;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  if (graphSizeBytes(graph) > FLOW_LIMITS.graphMaxBytes) {
    push({ severity: 'error', code: 'limits_exceeded', message: 'The flow is too large.' });
  }

  // Start node
  const starts = nodes.filter((n) => n.type === 'start');
  if (starts.length === 0) {
    push({ severity: 'error', code: 'start_missing', message: 'Add a Start node.' });
  }
  starts.slice(1).forEach((n) =>
    push({
      severity: 'error',
      code: 'start_multiple',
      nodeId: n.id,
      message: 'Only one Start node is allowed.',
    }),
  );

  // Edges
  const validEdges: FlowGraph['edges'] = [];
  const usedHandles = new Set<string>();
  for (const edge of graph.edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    const edgeIssue = (message: string) =>
      push({
        severity: 'error',
        code: 'edge_invalid',
        edgeId: edge.id,
        nodeId: source?.id,
        message,
      });
    if (!source || !target) {
      edgeIssue('This connection points to a node that does not exist.');
      continue;
    }
    if (target.type === 'start') {
      push({
        severity: 'error',
        code: 'start_has_input',
        edgeId: edge.id,
        nodeId: target.id,
        message: 'Nothing can connect into the Start node.',
      });
      continue;
    }
    if (!exitsOf(source).some((e) => e.handle === edge.sourceHandle)) {
      edgeIssue(`${nameOf(source)} has no exit "${edge.sourceHandle}".`);
      continue;
    }
    const key = `${edge.source}\u0000${edge.sourceHandle}`;
    if (usedHandles.has(key)) {
      edgeIssue(`${nameOf(source)}: an exit can connect to one next step only.`);
      continue;
    }
    usedHandles.add(key);
    validEdges.push(edge);
  }
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const e of validEdges) {
    outgoing.set(e.source, [...(outgoing.get(e.source) ?? []), e.target]);
    incoming.set(e.target, [...(incoming.get(e.target) ?? []), e.source]);
  }
  const next = (id: string) => outgoing.get(id) ?? [];

  // Variables
  const flowVarNames = new Set(graph.variables.map((v) => v.name));
  const contactNames = new Set(ctx.contactVars.map((v) => v.name));
  graph.variables.forEach((v, i) => {
    if (contactNames.has(v.name) || SYSTEM_VARIABLE_NAMES.has(v.name)) {
      push({
        severity: 'error',
        code: 'variable_name_taken',
        field: `variables.${String(i)}.name`,
        message: `"${v.name}" is already a contact or system variable — pick another name.`,
      });
    }
  });
  const catalog = new Map<string, VariableEntry>(
    buildVariableCatalog({ contactVars: ctx.contactVars, flowVars: graph.variables }).map((v) => [
      v.name,
      v,
    ]),
  );
  const knownName = (name: string) => VARIABLE_NAME.test(name) && catalog.has(name);

  // Flow settings
  if (
    graph.settings.onError === 'transfer' &&
    !IN_PHONE.test(graph.settings.errorTransferPhone ?? '')
  ) {
    push({
      severity: 'error',
      code: 'transfer_phone_invalid',
      field: 'settings.errorTransferPhone',
      message: 'Flow settings: enter the phone (+91…) to transfer to on errors.',
    });
  }
  for (const token of templateTokens(graph.settings.errorMessage)) {
    if (!knownName(token)) {
      push({
        severity: 'error',
        code: 'variable_unknown',
        field: 'settings.errorMessage',
        message: `Flow settings: {{${token}}} is not a known variable.`,
      });
    }
  }

  // Per node
  for (const node of nodes) {
    const name = nameOf(node);
    const nodeIssue = (issue: Omit<Issue, 'nodeId'>) => push({ ...issue, nodeId: node.id });
    const parsed = parseNodeConfig(node.type, node.config);
    if (!parsed.ok) {
      for (const err of parsed.errors) {
        nodeIssue({
          severity: 'error',
          code: 'node_unconfigured',
          field: err.path,
          message: `${name}: ${err.path.replace(/^config\.?/, '') || 'settings'} — ${err.message}`,
        });
      }
    }
    const c = rec(node.config);

    // exits
    const connected = new Set(
      validEdges.filter((e) => e.source === node.id).map((e) => e.sourceHandle),
    );
    for (const exit of exitsOf(node)) {
      if (connected.has(exit.handle)) continue;
      if (exit.required) {
        nodeIssue({
          severity: 'error',
          code: 'exit_required',
          field: `exits.${exit.handle}`,
          message: `${name}: "${exit.label}" is not connected to a next step.`,
        });
      } else if (exit.kind === 'error') {
        nodeIssue({
          severity: 'warning',
          code: 'error_exit_unconnected',
          field: 'exits.error',
          message: `${name}: errors go to the flow error message.`,
        });
      }
    }

    // unique dynamic ids, DTMF keys
    for (const key of ['keys', 'intents', 'rules'] as const) {
      const ids = list(c[key]).map((i) => i.id);
      if (new Set(ids).size !== ids.length) {
        nodeIssue({
          severity: 'error',
          code: 'node_unconfigured',
          field: `config.${key}`,
          message: `${name}: each ${key.slice(0, -1)} needs its own id.`,
        });
      }
    }
    if (node.type === 'gather_dtmf' && c.mode !== 'digits') {
      const seen = new Set<unknown>();
      list(c.keys).forEach((k, i) => {
        if (seen.has(k.key)) {
          nodeIssue({
            severity: 'error',
            code: 'dtmf_duplicate_key',
            field: `config.keys.${String(i)}.key`,
            message: `${name}: key ${String(k.key)} is used twice.`,
          });
        }
        seen.add(k.key);
      });
      if (typeof c.repeatKey === 'string' && seen.has(c.repeatKey)) {
        nodeIssue({
          severity: 'error',
          code: 'dtmf_repeat_conflict',
          field: 'config.repeatKey',
          message: `${name}: the repeat key ${c.repeatKey} is also a menu key.`,
        });
      }
    }

    // template tokens
    for (const f of templateFields(node)) {
      for (const token of templateTokens(f.text)) {
        if ((SERVER_ONLY_TOKENS as readonly string[]).includes(token)) {
          if (!f.serverOnly) {
            nodeIssue({
              severity: 'error',
              code: 'contact_token_not_allowed',
              field: f.field,
              message: `${name}: {{${token}}} can only be used in API requests.`,
            });
          }
        } else if (!knownName(token)) {
          nodeIssue({
            severity: 'error',
            code: 'variable_unknown',
            field: f.field,
            message: `${name}: {{${token}}} is not a known variable.`,
          });
        }
      }
    }

    // variable references
    for (const ref of variableRefs(node)) {
      if (!knownName(ref.name)) {
        nodeIssue({
          severity: 'error',
          code: 'variable_unknown',
          field: ref.field,
          message: `${name}: "${ref.name}" is not a known variable.`,
        });
      } else if (ref.flowOnly && !flowVarNames.has(ref.name)) {
        nodeIssue({
          severity: 'error',
          code: 'variable_unknown',
          field: ref.field,
          message: ref.write
            ? `${name}: "${ref.name}" is read-only — use a flow variable.`
            : `${name}: only flow variables can be passed to the AI ("${ref.name}").`,
        });
      }
    }

    // references to agents / audio
    if (node.type === 'ai_agent' && typeof c.agentId === 'string' && OBJECT_ID.test(c.agentId)) {
      const agent = ctx.agents.get(c.agentId);
      if (!agent) {
        nodeIssue({
          severity: 'error',
          code: 'agent_missing',
          field: 'config.agentId',
          message: `${name}: the AI agent no longer exists — pick another.`,
        });
      } else if (!agent.active) {
        nodeIssue({
          severity: 'warning',
          code: 'agent_inactive',
          field: 'config.agentId',
          message: `${name}: the AI agent is turned off — calls will take the error exit.`,
        });
      }
    }
    const audioRefs: { field: string; id: unknown }[] = [];
    if (node.type === 'play_audio') audioRefs.push({ field: 'config.audioId', id: c.audioId });
    const prompt = rec(c.prompt);
    if (prompt.kind === 'audio')
      audioRefs.push({ field: 'config.prompt.audioId', id: prompt.audioId });
    for (const ref of audioRefs) {
      if (typeof ref.id === 'string' && OBJECT_ID.test(ref.id) && !ctx.audios.has(ref.id)) {
        nodeIssue({
          severity: 'error',
          code: 'audio_missing',
          field: ref.field,
          message: `${name}: the audio file no longer exists — pick another.`,
        });
      }
    }

    // API URL
    if (node.type === 'api_request' && typeof c.url === 'string' && c.url.trim()) {
      const url = c.url.trim();
      const host = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url)?.[1] ?? '';
      if (host.includes('{{')) {
        nodeIssue({
          severity: 'error',
          code: 'node_unconfigured',
          field: 'config.url',
          message: `${name}: the address host can't use {{variables}}.`,
        });
      } else {
        let parsedUrl: URL | null = null;
        try {
          parsedUrl = new URL(url.replace(/\{\{[^}]*\}\}/g, 'x'));
        } catch {
          parsedUrl = null;
        }
        if (!parsedUrl || urlBlockReason(parsedUrl, ctx.urlPolicy)) {
          nodeIssue({
            severity: 'error',
            code: 'url_blocked',
            field: 'config.url',
            message: `${name}: This address is not allowed.`,
          });
        }
      }
    }

    // transfer phone
    if (node.type === 'transfer_to_agent' && typeof c.phone === 'string' && c.phone.trim()) {
      const phone = c.phone.trim();
      const token = SINGLE_TOKEN.exec(phone)?.[1];
      const valid = IN_PHONE.test(phone) || (token !== undefined && knownName(token));
      if (!valid) {
        nodeIssue({
          severity: 'error',
          code: 'transfer_phone_invalid',
          field: 'config.phone',
          message: `${name}: enter an Indian mobile number (+91…) or one {{variable}}.`,
        });
      }
    }

    // length warnings
    if (
      node.type === 'send_sms' &&
      typeof c.text === 'string' &&
      c.text.length > FLOW_LIMITS.smsSinglePartChars
    ) {
      nodeIssue({
        severity: 'warning',
        code: 'sms_long',
        field: 'config.text',
        message: `${name}: longer than ${String(FLOW_LIMITS.smsSinglePartChars)} characters — sent as more than one SMS.`,
      });
    }
    if (
      node.type === 'speak' &&
      typeof c.text === 'string' &&
      c.text.length > FLOW_LIMITS.speakLongWarnChars
    ) {
      nodeIssue({
        severity: 'warning',
        code: 'speak_long',
        field: 'config.text',
        message: `${name}: long text for a phone call — consider splitting it.`,
      });
    }
  }

  // Reachability, ending, silent loops
  const start = starts[0];
  if (start) {
    const seen = reachable(start.id, next);
    for (const node of nodes) {
      if (!seen.has(node.id)) {
        push({
          severity: 'error',
          code: 'node_unreachable',
          nodeId: node.id,
          message: `${nameOf(node)} can't be reached from Start.`,
        });
      }
    }
    if (![...seen].some((id) => isEnding(nodeById.get(id)?.type ?? 'start'))) {
      push({
        severity: 'error',
        code: 'no_ending',
        message: 'No path from Start reaches a Hang up or Transfer node.',
      });
    }
  }
  const silentIds = nodes.filter((n) => !isWaiting(n.type)).map((n) => n.id);
  const silent = new Set(silentIds);
  const silentNext = (id: string) => next(id).filter((t) => silent.has(t));
  for (const component of stronglyConnected(silentIds, silentNext)) {
    const only = component[0];
    const loops = component.length > 1 || (only !== undefined && silentNext(only).includes(only));
    if (!loops) continue;
    for (const id of component) {
      const node = nodeById.get(id);
      if (!node) continue;
      push({
        severity: 'error',
        code: 'silent_loop',
        nodeId: id,
        message: `${nameOf(node)} is in a loop that never waits for the customer.`,
      });
    }
  }

  const order = new Map(nodes.map((n, i) => [n.id, i]));
  const rank = (i: Issue) => (i.nodeId === undefined ? -1 : (order.get(i.nodeId) ?? nodes.length));
  return issues
    .map((issue, i) => ({ issue, i }))
    .sort(
      (a, b) =>
        rank(a.issue) - rank(b.issue) || a.issue.code.localeCompare(b.issue.code) || a.i - b.i,
    )
    .map((x) => x.issue);
};
