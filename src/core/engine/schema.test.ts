import { describe, expect, it } from 'vitest';

import { FLOW_LIMITS as L } from '../../config/limits';
import { NODE_TYPES, type NodeType } from '../../db/models/flow.model';

import {
  DEFAULT_ERROR_MESSAGE,
  DEFAULT_INVALID_TEXT,
  FlowGraphSchema,
  NODE_CONFIG_SCHEMAS,
  blankGraph,
  parseNodeConfig,
} from './schema';

const OID = '0123456789abcdef01234567';

/** One minimal valid config per node type. */
const VALID: Record<NodeType, Record<string, unknown>> = {
  start: {},
  speak: { text: 'Namaste {{name}}' },
  play_audio: { audioId: OID },
  gather_dtmf: {
    prompt: { kind: 'speak', text: 'Press 1' },
    keys: [{ id: 'k1', key: '1' }],
  },
  gather_speech: { prompt: { kind: 'audio', audioId: OID } },
  ai_agent: { agentId: OID },
  api_request: { url: 'https://api.example.com/x?p={{contact.phone}}' },
  condition_router: {
    rules: [{ id: 'r1', conditions: [{ variable: 'status', operator: 'equals', value: 'paid' }] }],
  },
  set_variable: { assignments: [{ variable: 'tries', op: 'increment', value: '1' }] },
  set_disposition: { disposition: 'paid' },
  transfer_to_agent: { phone: '+919000000001' },
  send_sms: { text: 'Link: https://pay.example.com' },
  send_whatsapp: { templateName: 'payment_link' },
  wait: {},
  hangup: {},
};

const ok = (type: NodeType, config: Record<string, unknown>) => parseNodeConfig(type, config).ok;

describe('node config schemas', () => {
  it('has a schema for every node type and accepts the minimal configs', () => {
    expect(Object.keys(NODE_CONFIG_SCHEMAS).sort()).toEqual([...NODE_TYPES].sort());
    for (const type of NODE_TYPES) expect(ok(type, VALID[type]), type).toBe(true);
  });

  it('fills defaults', () => {
    const dtmf = parseNodeConfig('gather_dtmf', VALID.gather_dtmf);
    expect(dtmf.ok && dtmf.config).toMatchObject({
      mode: 'menu',
      maxRetries: L.gatherRetriesDefault,
      timeoutSec: L.dtmfTimeoutSecDefault,
      invalidText: DEFAULT_INVALID_TEXT,
      repeatKey: null,
      finishKey: '#',
      keys: [{ id: 'k1', key: '1', label: '' }],
    });
    const start = parseNodeConfig('start', {});
    expect(start.ok && start.config.triggers).toEqual(['campaign', 'inbound', 'api', 'test']);
    const speech = parseNodeConfig('gather_speech', VALID.gather_speech);
    expect(speech.ok && speech.config).toMatchObject({
      timeoutSec: L.speechTimeoutSecDefault,
      matchMode: 'keywords',
      intents: [],
      prompt: { kind: 'audio', fallbackText: null },
    });
    const wait = parseNodeConfig('wait', {});
    expect(wait.ok && wait.config.seconds).toBe(5);
    const ai = parseNodeConfig('ai_agent', VALID.ai_agent);
    expect(ai.ok && ai.config).toMatchObject({
      maxTurns: L.aiMaxTurnsDefault,
      passVariables: [],
      speakOpeningLine: true,
      goal: null,
    });
  });

  it.each<[NodeType, Record<string, unknown>, string]>([
    ['start', { triggers: [] }, 'config.triggers'],
    ['start', { triggers: ['api', 'api'] }, 'config.triggers'],
    ['start', { triggers: ['sms'] }, 'config.triggers.0'],
    ['speak', { text: '' }, 'config.text'],
    ['speak', { text: 'x'.repeat(L.speakTextMaxChars + 1) }, 'config.text'],
    ['speak', { text: 'x', language: 'fr' }, 'config.language'],
    ['speak', { text: 'x', extra: 1 }, 'config'],
    ['play_audio', { audioId: '' }, 'config.audioId'],
    [
      'play_audio',
      { audioId: OID, fallbackText: 'x'.repeat(L.fallbackTextMaxChars + 1) },
      'config.fallbackText',
    ],
    ['gather_dtmf', { prompt: { kind: 'speak', text: 'x' } }, 'config.keys'],
    [
      'gather_dtmf',
      { prompt: { kind: 'speak', text: '' }, keys: [{ id: 'k1', key: '1' }] },
      'config.prompt.text',
    ],
    [
      'gather_dtmf',
      { prompt: { kind: 'video' }, keys: [{ id: 'k1', key: '1' }] },
      'config.prompt.kind',
    ],
    ['gather_dtmf', { ...VALID.gather_dtmf, keys: [{ id: 'K-1', key: '1' }] }, 'config.keys.0.id'],
    ['gather_dtmf', { ...VALID.gather_dtmf, keys: [{ id: 'k1', key: '11' }] }, 'config.keys.0.key'],
    [
      'gather_dtmf',
      {
        ...VALID.gather_dtmf,
        keys: Array.from({ length: L.dtmfKeysMax + 1 }, (_, i) => ({
          id: `k${String(i)}`,
          key: '1',
        })),
      },
      'config.keys',
    ],
    [
      'gather_dtmf',
      { ...VALID.gather_dtmf, timeoutSec: L.gatherTimeoutSecMin - 1 },
      'config.timeoutSec',
    ],
    [
      'gather_dtmf',
      { ...VALID.gather_dtmf, timeoutSec: L.gatherTimeoutSecMax + 1 },
      'config.timeoutSec',
    ],
    [
      'gather_dtmf',
      { ...VALID.gather_dtmf, maxRetries: L.gatherRetriesMax + 1 },
      'config.maxRetries',
    ],
    [
      'gather_dtmf',
      { prompt: { kind: 'speak', text: 'x' }, mode: 'digits', minDigits: 5, maxDigits: 4 },
      'config.minDigits',
    ],
    ['gather_dtmf', { ...VALID.gather_dtmf, saveAs: 'Amount' }, 'config.saveAs'],
    [
      'gather_speech',
      { ...VALID.gather_speech, intents: [{ id: 'i1', label: 'Pay', keywords: [] }] },
      'config.intents.0.keywords',
    ],
    ['gather_speech', { ...VALID.gather_speech, language: 'fr' }, 'config.language'],
    ['ai_agent', { agentId: 'nope' }, 'config.agentId'],
    ['ai_agent', { agentId: OID, maxTurns: L.aiMaxTurnsMax + 1 }, 'config.maxTurns'],
    [
      'ai_agent',
      {
        agentId: OID,
        passVariables: Array.from({ length: L.aiPassVariablesMax + 1 }, (_, i) => `v${String(i)}`),
      },
      'config.passVariables',
    ],
    ['api_request', { url: '' }, 'config.url'],
    ['api_request', { url: 'https://x', method: 'DELETE' }, 'config.method'],
    ['api_request', { url: 'https://x', bodyTemplate: '{bad' }, 'config.bodyTemplate'],
    ['api_request', { url: 'https://x', timeoutMs: 999 }, 'config.timeoutMs'],
    [
      'api_request',
      { url: 'https://x', headers: [{ name: 'X Bad', value: 'v' }] },
      'config.headers.0.name',
    ],
    [
      'api_request',
      { url: 'https://x', saveResponse: [{ path: 'a.b.c.d.e.f', variable: 'x' }] },
      'config.saveResponse.0.path',
    ],
    ['condition_router', { rules: [] }, 'config.rules'],
    [
      'condition_router',
      { rules: [{ id: 'r1', conditions: [{ variable: 'x', operator: 'equals', value: '' }] }] },
      'config.rules.0.conditions.0.value',
    ],
    [
      'condition_router',
      { rules: [{ id: 'r1', conditions: [{ variable: 'x', operator: 'near' }] }] },
      'config.rules.0.conditions.0.operator',
    ],
    ['set_variable', { assignments: [] }, 'config.assignments'],
    [
      'set_variable',
      { assignments: [{ variable: 'x', op: 'set', value: ' ' }] },
      'config.assignments.0.value',
    ],
    ['set_disposition', { disposition: 'happy' }, 'config.disposition'],
    ['transfer_to_agent', { phone: '' }, 'config.phone'],
    ['transfer_to_agent', { phone: '+91', timeoutSec: 5 }, 'config.timeoutSec'],
    ['send_sms', { text: 'x'.repeat(L.smsMaxChars + 1) }, 'config.text'],
    ['send_whatsapp', { templateName: 'Bad Name' }, 'config.templateName'],
    [
      'send_whatsapp',
      { templateName: 'ok', params: Array.from({ length: L.waTemplateParamsMax + 1 }, () => 'p') },
      'config.params',
    ],
    ['wait', { seconds: L.waitSecMax + 1 }, 'config.seconds'],
    ['wait', { seconds: 0 }, 'config.seconds'],
    ['hangup', { disposition: 'x' }, 'config.disposition'],
  ])('%s refuses %j at %s', (type, config, path) => {
    const result = parseNodeConfig(type, config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.path)).toContain(path);
  });

  it('accepts the edges of each limit', () => {
    expect(ok('speak', { text: 'x'.repeat(L.speakTextMaxChars) })).toBe(true);
    expect(ok('wait', { seconds: L.waitSecMax })).toBe(true);
    expect(ok('gather_dtmf', { ...VALID.gather_dtmf, timeoutSec: L.gatherTimeoutSecMin })).toBe(
      true,
    );
    expect(ok('gather_dtmf', { prompt: { kind: 'speak', text: 'x' }, mode: 'digits' })).toBe(true);
    expect(ok('api_request', { url: 'https://x', bodyTemplate: '  ' })).toBe(true);
    expect(ok('api_request', { url: 'https://x', bodyTemplate: '{"a":"{{name}}"}' })).toBe(true);
    expect(
      ok('condition_router', {
        rules: [{ id: 'r1', conditions: [{ variable: 'x', operator: 'is_empty' }] }],
      }),
    ).toBe(true);
    expect(ok('set_variable', { assignments: [{ variable: 'x', op: 'clear' }] })).toBe(true);
  });
});

describe('graph schema', () => {
  const node = (id: string, type: NodeType = 'speak') => ({
    id,
    type,
    position: { x: 0, y: 0 },
    config: {},
  });
  const graph = (extra: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    nodes: [node('a', 'start'), node('b')],
    edges: [{ id: 'e1', source: 'a', sourceHandle: 'next', target: 'b' }],
    ...extra,
  });

  it('accepts incomplete node configs and fills settings / variables', () => {
    const g = FlowGraphSchema.parse(graph());
    expect(g.variables).toEqual([]);
    expect(g.settings).toEqual({
      language: 'hinglish',
      voice: 'coral',
      errorMessage: DEFAULT_ERROR_MESSAGE,
      onError: 'hangup',
      errorTransferPhone: null,
      maxDurationSec: L.flowMaxDurationSecDefault,
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ['version 2', { schemaVersion: 2 }],
    ['unknown node type', { nodes: [{ ...node('a'), type: 'goto' }] }],
    ['bad node id', { nodes: [node('a b')] }],
    ['duplicate node ids', { nodes: [node('a'), node('a')] }],
    [
      'duplicate edge ids',
      {
        edges: [
          { id: 'e', source: 'a', sourceHandle: 'next', target: 'b' },
          { id: 'e', source: 'a', sourceHandle: 'error', target: 'b' },
        ],
      },
    ],
    ['bad handle', { edges: [{ id: 'e', source: 'a', sourceHandle: 'Next!', target: 'b' }] }],
    ['far position', { nodes: [{ ...node('a'), position: { x: L.positionAbsMax + 1, y: 0 } }] }],
    [
      'too many nodes',
      { nodes: Array.from({ length: L.nodesMax + 1 }, (_, i) => node(`n${String(i)}`)) },
    ],
    [
      'too many edges',
      {
        edges: Array.from({ length: L.edgesMax + 1 }, (_, i) => ({
          id: `e${String(i)}`,
          source: 'a',
          sourceHandle: 'next',
          target: 'b',
        })),
      },
    ],
    [
      'too many variables',
      {
        variables: Array.from({ length: L.variablesMax + 1 }, (_, i) => ({
          name: `v${String(i)}`,
          type: 'text',
        })),
      },
    ],
    [
      'duplicate variables',
      {
        variables: [
          { name: 'v', type: 'text' },
          { name: 'v', type: 'number' },
        ],
      },
    ],
    ['bad variable name', { variables: [{ name: '1v', type: 'text' }] }],
    ['bad variable type', { variables: [{ name: 'v', type: 'money' }] }],
    ['extra top-level key', { owner: 'x' }],
    ['bad settings', { settings: { maxDurationSec: 10 } }],
    ['bad viewport', { viewport: { x: 0, y: 0, zoom: 0 } }],
    ['long label', { nodes: [{ ...node('a'), label: 'x'.repeat(L.labelMaxChars + 1) }] }],
  ])('refuses %s', (_name, extra) => {
    expect(FlowGraphSchema.safeParse(graph(extra)).success).toBe(false);
  });

  it('builds a blank start → hangup graph', () => {
    const g = blankGraph();
    expect(g.nodes.map((n) => n.type)).toEqual(['start', 'hangup']);
    expect(g.edges).toEqual([
      { id: 'e_start', source: 'start', sourceHandle: 'next', target: 'hangup' },
    ]);
  });
});
