import { describe, expect, it } from 'vitest';

import { FLOW_LIMITS } from '../../config/limits';
import type { NodeType } from '../../db/models/flow.model';

import { FlowGraphSchema, type FlowGraph } from './schema';
import { ISSUE_CODES, hasErrors, validateFlow, type Issue, type ValidateContext } from './validate';

const AGENT = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OFF_AGENT = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const AUDIO = 'cccccccccccccccccccccccc';
const GONE = 'dddddddddddddddddddddddd';

const ctx: ValidateContext = {
  contactVars: [
    { name: 'name', label: 'Name', type: 'built_in' },
    { name: 'phone_last4', label: 'Last 4', type: 'built_in' },
    { name: 'amount', label: 'Amount', type: 'currency' },
  ],
  agents: new Map([
    [AGENT, { active: true }],
    [OFF_AGENT, { active: false }],
  ]),
  audios: new Set([AUDIO]),
  urlPolicy: { httpsOnly: true, allowPrivate: false },
};

type RawNode = { id: string; type: NodeType; label?: string; config?: Record<string, unknown> };
type RawEdge = [string, string, string];

const build = (
  nodes: RawNode[],
  edges: RawEdge[],
  extra: Record<string, unknown> = {},
): FlowGraph =>
  FlowGraphSchema.parse({
    schemaVersion: 1,
    nodes: nodes.map((n, i) => ({ position: { x: 0, y: i * 100 }, config: {}, ...n })),
    edges: edges.map(([source, sourceHandle, target], i) => ({
      id: `e${String(i)}`,
      source,
      sourceHandle,
      target,
    })),
    ...extra,
  });

/** A clean loan-recovery-like graph: no errors, a few error-exit warnings. */
const cleanNodes = (): RawNode[] => [
  { id: 'start', type: 'start' },
  {
    id: 'greet',
    type: 'speak',
    label: 'Greeting',
    config: { text: 'Namaste {{name}}, {{amount}} due hai.' },
  },
  {
    id: 'menu',
    type: 'gather_dtmf',
    label: 'Main menu',
    config: {
      prompt: { kind: 'speak', text: '1 ya 2 dabaiye' },
      keys: [
        { id: 'k1', key: '1', label: 'Paid' },
        { id: 'k2', key: '2', label: 'Agent' },
      ],
      saveAs: 'choice',
    },
  },
  {
    id: 'api',
    type: 'api_request',
    config: {
      url: 'https://api.example.com/status?phone={{contact.phone}}',
      saveResponse: [{ path: 'status', variable: 'payment_status' }],
    },
  },
  {
    id: 'router',
    type: 'condition_router',
    config: {
      rules: [
        {
          id: 'r1',
          conditions: [{ variable: 'payment_status', operator: 'equals', value: 'paid' }],
        },
      ],
    },
  },
  { id: 'ai', type: 'ai_agent', config: { agentId: AGENT, passVariables: ['payment_status'] } },
  { id: 'bye', type: 'hangup', config: { text: 'Dhanyavaad.' } },
];
const cleanEdges = (): RawEdge[] => [
  ['start', 'next', 'greet'],
  ['greet', 'next', 'menu'],
  ['menu', 'key_k1', 'api'],
  ['menu', 'key_k2', 'ai'],
  ['api', 'success', 'router'],
  ['router', 'rule_r1', 'bye'],
  ['router', 'else', 'ai'],
  ['ai', 'resolved', 'bye'],
];
const VARIABLES = {
  variables: [
    { name: 'choice', type: 'text' },
    { name: 'payment_status', type: 'text' },
  ],
};
const clean = () => build(cleanNodes(), cleanEdges(), VARIABLES);

const codes = (issues: Issue[]) => issues.map((i) => i.code);
const errorsOf = (g: FlowGraph) => validateFlow(g, ctx).filter((i) => i.severity === 'error');
const withNode = (id: string, patch: Partial<RawNode>) =>
  build(
    cleanNodes().map((n) =>
      n.id === id ? { ...n, ...patch, config: { ...n.config, ...patch.config } } : n,
    ),
    cleanEdges(),
    VARIABLES,
  );

describe('validateFlow', () => {
  it('a clean graph has no errors; unconnected error exits are warnings', () => {
    const issues = validateFlow(clean(), ctx);
    expect(hasErrors(issues)).toBe(false);
    expect(new Set(codes(issues))).toEqual(new Set(['error_exit_unconnected']));
    expect(issues.find((i) => i.nodeId === 'greet')?.message).toBe(
      '"Greeting": errors go to the flow error message.',
    );
  });

  it('start missing / multiple / with input', () => {
    expect(codes(errorsOf(build([{ id: 'bye', type: 'hangup' }], [])))).toEqual(['start_missing']);
    const two = build(
      [
        { id: 's1', type: 'start' },
        { id: 's2', type: 'start' },
        { id: 'bye', type: 'hangup' },
      ],
      [
        ['s1', 'next', 'bye'],
        ['s2', 'next', 's1'],
      ],
    );
    expect(codes(errorsOf(two))).toEqual([
      'start_has_input',
      'exit_required',
      'node_unreachable',
      'start_multiple',
    ]);
  });

  it('edges: unknown nodes / handles, a second edge on one exit', () => {
    const g = build(
      cleanNodes(),
      [
        ...cleanEdges(),
        ['ghost', 'next', 'bye'],
        ['greet', 'nope', 'bye'],
        ['greet', 'next', 'bye'],
        ['bye', 'next', 'greet'],
      ],
      VARIABLES,
    );
    const edgeIssues = errorsOf(g).filter((i) => i.code === 'edge_invalid');
    expect(edgeIssues.map((i) => i.edgeId).sort()).toEqual(['e10', 'e11', 'e8', 'e9']);
    expect(edgeIssues.find((i) => i.edgeId === 'e9')?.message).toBe(
      '"Greeting" has no exit "nope".',
    );
    expect(edgeIssues.find((i) => i.edgeId === 'e10')?.message).toBe(
      '"Greeting": an exit can connect to one next step only.',
    );
    expect(edgeIssues.find((i) => i.edgeId === 'e8')?.nodeId).toBeUndefined();
  });

  it('required exits must be connected; unreachable nodes and no ending', () => {
    const g = build(
      cleanNodes(),
      cleanEdges().filter(([, h]) => h !== 'key_k2' && h !== 'else'),
      VARIABLES,
    );
    const issues = errorsOf(g);
    expect(issues.filter((i) => i.code === 'exit_required').map((i) => i.field)).toEqual([
      'exits.key_k2',
      'exits.else',
    ]);
    expect(issues.find((i) => i.field === 'exits.key_k2')?.message).toBe(
      '"Main menu": "Press 2 · Agent" is not connected to a next step.',
    );
    expect(issues.filter((i) => i.code === 'node_unreachable').map((i) => i.nodeId)).toEqual([
      'ai',
    ]);
    const noEnd = build(
      [
        { id: 'start', type: 'start' },
        { id: 's', type: 'speak', config: { text: 'x' } },
        { id: 'bye', type: 'hangup' },
      ],
      [['start', 'next', 's']],
    );
    expect(codes(errorsOf(noEnd))).toEqual(['no_ending', 'exit_required', 'node_unreachable']);
    const viaTransfer = build(
      [
        { id: 'start', type: 'start' },
        { id: 't', type: 'transfer_to_agent', config: { phone: '+919876543210' } },
      ],
      [['start', 'next', 't']],
    );
    expect(errorsOf(viaTransfer)).toEqual([]);
  });

  it('unconfigured nodes report each bad field; duplicate dynamic ids', () => {
    const issues = errorsOf(withNode('greet', { config: { text: '' } }));
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'node_unconfigured',
        nodeId: 'greet',
        field: 'config.text',
        message: '"Greeting": text — Required',
      }),
    );
    const dupIds = errorsOf(
      withNode('menu', {
        config: {
          keys: [
            { id: 'k1', key: '1' },
            { id: 'k1', key: '2' },
          ],
        },
      }),
    );
    expect(dupIds).toContainEqual(
      expect.objectContaining({ code: 'node_unconfigured', field: 'config.keys' }),
    );
    const strict = errorsOf(withNode('bye', { config: { unknown: true } }));
    expect(strict).toContainEqual(
      expect.objectContaining({
        field: 'config',
        message: '"Hang up": settings — Unrecognized key: "unknown"',
      }),
    );
  });

  it('variables: unknown tokens, read-only targets, flow-only AI variables, name clashes', () => {
    const g = build(
      cleanNodes().map((n) =>
        n.id === 'greet'
          ? { ...n, config: { text: 'Hi {{nobody}} {{Bad Token}}' } }
          : n.id === 'menu'
            ? { ...n, config: { ...n.config, saveAs: 'phone_last4' } }
            : n.id === 'ai'
              ? { ...n, config: { agentId: AGENT, passVariables: ['name'] } }
              : n,
      ),
      cleanEdges(),
      {
        variables: [
          ...VARIABLES.variables,
          { name: 'amount', type: 'number' },
          { name: 'today', type: 'date' },
        ],
      },
    );
    const issues = errorsOf(g);
    expect(issues.filter((i) => i.code === 'variable_name_taken').map((i) => i.field)).toEqual([
      'variables.2.name',
      'variables.3.name',
    ]);
    expect(issues.filter((i) => i.code === 'variable_unknown').map((i) => i.message)).toEqual([
      '"Greeting": {{nobody}} is not a known variable.',
      '"Greeting": {{Bad Token}} is not a known variable.',
      '"Main menu": "phone_last4" is read-only — use a flow variable.',
      '"AI agent": only flow variables can be passed to the AI ("name").',
    ]);
    const unknownRef = errorsOf(
      withNode('router', {
        config: {
          rules: [{ id: 'r1', conditions: [{ variable: 'ghost', operator: 'is_empty' }] }],
        },
      }),
    );
    expect(unknownRef).toContainEqual(
      expect.objectContaining({
        code: 'variable_unknown',
        field: 'config.rules.0.conditions.0.variable',
      }),
    );
    const settings = errorsOf(
      build(cleanNodes(), cleanEdges(), {
        ...VARIABLES,
        settings: { errorMessage: 'Sorry {{ghost}}' },
      }),
    );
    expect(settings).toContainEqual(
      expect.objectContaining({ code: 'variable_unknown', field: 'settings.errorMessage' }),
    );
  });

  it('{{contact.phone}} only inside API requests (not in secret headers)', () => {
    const issues = errorsOf(withNode('greet', { config: { text: 'Number {{contact.phone}}' } }));
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'contact_token_not_allowed', field: 'config.text' }),
    );
    const api = errorsOf(
      withNode('api', {
        config: {
          headers: [
            { name: 'X-Phone', value: '{{contact.external_id}}' },
            { name: 'X-Key', secret: true, value: '{{ghost}}', sealed: 'v1:x' },
          ],
          method: 'POST',
          bodyTemplate: '{"p":"{{contact.phone}}","n":"{{name}}"}',
        },
      }),
    );
    expect(api).toEqual([]);
  });

  it('agents and audio must exist; an inactive agent is a warning', () => {
    expect(codes(errorsOf(withNode('ai', { config: { agentId: GONE } })))).toEqual([
      'agent_missing',
    ]);
    const off = validateFlow(withNode('ai', { config: { agentId: OFF_AGENT } }), ctx);
    expect(off.find((i) => i.code === 'agent_inactive')?.severity).toBe('warning');
    const audio = build(
      [
        { id: 'start', type: 'start' },
        { id: 'play', type: 'play_audio', config: { audioId: GONE } },
        { id: 'ok', type: 'play_audio', config: { audioId: AUDIO } },
        { id: 'menu', type: 'gather_speech', config: { prompt: { kind: 'audio', audioId: GONE } } },
        { id: 'bye', type: 'hangup' },
      ],
      [
        ['start', 'next', 'play'],
        ['play', 'next', 'ok'],
        ['ok', 'next', 'menu'],
        ['menu', 'next', 'bye'],
      ],
    );
    expect(errorsOf(audio).map((i) => [i.code, i.field])).toEqual([
      ['audio_missing', 'config.audioId'],
      ['audio_missing', 'config.prompt.audioId'],
    ]);
  });

  it('DTMF keys unique and the repeat key not a menu key', () => {
    const issues = errorsOf(
      withNode('menu', {
        config: {
          keys: [
            { id: 'k1', key: '1' },
            { id: 'k2', key: '1' },
          ],
          repeatKey: '1',
        },
      }),
    );
    expect(codes(issues)).toEqual(['dtmf_duplicate_key', 'dtmf_repeat_conflict']);
    expect(issues[0]?.field).toBe('config.keys.1.key');
  });

  it('silent loops (never waiting) are errors; loops through a waiting node are fine', () => {
    const loop = build(
      [
        { id: 'start', type: 'start' },
        {
          id: 'a',
          type: 'set_variable',
          config: { assignments: [{ variable: 'n', op: 'increment', value: '1' }] },
        },
        {
          id: 'b',
          type: 'condition_router',
          config: {
            rules: [{ id: 'r1', conditions: [{ variable: 'n', operator: 'gt', value: '3' }] }],
          },
        },
        { id: 'self', type: 'speak', config: { text: 'x' } },
        { id: 'bye', type: 'hangup' },
      ],
      [
        ['start', 'next', 'a'],
        ['a', 'next', 'b'],
        ['b', 'else', 'a'],
        ['b', 'rule_r1', 'self'],
        ['self', 'next', 'self'],
        ['self', 'error', 'bye'],
      ],
      { variables: [{ name: 'n', type: 'number' }] },
    );
    expect(
      errorsOf(loop)
        .filter((i) => i.code === 'silent_loop')
        .map((i) => i.nodeId),
    ).toEqual(['a', 'b', 'self']);
    const waits = build(
      [
        { id: 'start', type: 'start' },
        {
          id: 'menu',
          type: 'gather_dtmf',
          config: { prompt: { kind: 'speak', text: 'x' }, keys: [{ id: 'k1', key: '1' }] },
        },
        { id: 'bye', type: 'hangup' },
      ],
      [
        ['start', 'next', 'menu'],
        ['menu', 'key_k1', 'menu'],
        ['menu', 'no_input', 'bye'],
      ],
    );
    expect(codes(errorsOf(waits))).toEqual([]);
  });

  it('API URLs follow the address rules; no variables in the host', () => {
    for (const url of [
      'http://api.example.com/x',
      'https://169.254.169.254/latest',
      'https://10.0.0.5/x',
      'ftp://x',
      'https://api.example.com:22/x',
      'not a url',
    ]) {
      expect(codes(errorsOf(withNode('api', { config: { url } }))), url).toEqual(['url_blocked']);
    }
    expect(
      errorsOf(withNode('api', { config: { url: 'https://{{name}}.example.com/x' } })),
    ).toContainEqual(expect.objectContaining({ code: 'node_unconfigured', field: 'config.url' }));
    const dev = validateFlow(
      withNode('api', {
        config: { url: 'http://localhost:5100/api/v1/mock/payment-status?phone={{contact.phone}}' },
      }),
      {
        ...ctx,
        urlPolicy: { httpsOnly: false, allowPrivate: true, extraPorts: [5100] },
      },
    );
    expect(hasErrors(dev)).toBe(false);
  });

  it('transfer phones: Indian mobile or one known variable; settings transfer phone', () => {
    const transfer = (phone: string) =>
      errorsOf(
        build(
          [
            { id: 'start', type: 'start' },
            { id: 't', type: 'transfer_to_agent', config: { phone } },
          ],
          [['start', 'next', 't']],
          { variables: [{ name: 'agent_phone', type: 'text' }] },
        ),
      );
    expect(transfer('+919876543210')).toEqual([]);
    expect(transfer('{{agent_phone}}')).toEqual([]);
    expect(codes(transfer('9876543210'))).toEqual(['transfer_phone_invalid']);
    expect(codes(transfer('{{ghost}}'))).toEqual(['transfer_phone_invalid', 'variable_unknown']);
    const settings = errorsOf(
      build(cleanNodes(), cleanEdges(), { ...VARIABLES, settings: { onError: 'transfer' } }),
    );
    expect(settings).toContainEqual(
      expect.objectContaining({
        code: 'transfer_phone_invalid',
        field: 'settings.errorTransferPhone',
      }),
    );
    const ok = errorsOf(
      build(cleanNodes(), cleanEdges(), {
        ...VARIABLES,
        settings: { onError: 'transfer', errorTransferPhone: '+919876543210' },
      }),
    );
    expect(ok).toEqual([]);
  });

  it('checks tokens in disposition notes and WhatsApp params', () => {
    const g = build(
      [
        { id: 'start', type: 'start' },
        {
          id: 'd',
          type: 'set_disposition',
          config: { disposition: 'other', note: 'By {{ghost}}' },
        },
        {
          id: 'w',
          type: 'send_whatsapp',
          config: { templateName: 'link', params: ['{{name}}', '{{ghost2}}'] },
        },
        { id: 'bye', type: 'hangup' },
      ],
      [
        ['start', 'next', 'd'],
        ['d', 'next', 'w'],
        ['w', 'next', 'bye'],
      ],
    );
    expect(errorsOf(g).map((i) => i.field)).toEqual(['config.note', 'config.params.1']);
  });

  it('API headers: reserved / repeated names, missing secrets, line breaks; GET has no body', () => {
    const issues = errorsOf(
      withNode('api', {
        config: {
          headers: [
            { name: 'Host', value: 'x' },
            { name: 'X-Key', secret: true, value: null },
            { name: 'x-key', value: 'b' },
            { name: 'X-Line', value: 'a\nb' },
            { name: 'X-Ok', secret: true, value: null, sealed: 'v1:sealed', valueHint: '••••1234' },
          ],
          bodyTemplate: '{"a":1}',
        },
      }),
    );
    expect(issues.map((i) => [i.field, i.message])).toEqual([
      ['config.headers.0.name', '"API request": header Host is set automatically.'],
      ['config.headers.1.value', '"API request": header X-Key needs its secret value.'],
      ['config.headers.2.name', '"API request": header x-key is listed twice.'],
      ['config.headers.3.value', '"API request": header X-Line has a line break.'],
      ['config.bodyTemplate', '"API request": GET requests have no body.'],
    ]);
    expect(
      errorsOf(withNode('api', { config: { method: 'POST', bodyTemplate: '{"a":1}' } })),
    ).toEqual([]);
  });

  it('long SMS / speak texts are warnings', () => {
    const g = build(
      [
        { id: 'start', type: 'start' },
        {
          id: 's',
          type: 'speak',
          config: { text: 'x'.repeat(FLOW_LIMITS.speakLongWarnChars + 1) },
        },
        {
          id: 'sms',
          type: 'send_sms',
          config: { text: 'y'.repeat(FLOW_LIMITS.smsSinglePartChars + 1) },
        },
        { id: 'bye', type: 'hangup' },
      ],
      [
        ['start', 'next', 's'],
        ['s', 'next', 'sms'],
        ['sms', 'next', 'bye'],
      ],
    );
    const issues = validateFlow(g, ctx);
    expect(hasErrors(issues)).toBe(false);
    expect(
      issues.filter((i) => i.code !== 'error_exit_unconnected').map((i) => [i.code, i.severity]),
    ).toEqual([
      ['speak_long', 'warning'],
      ['sms_long', 'warning'],
    ]);
  });

  it('a too-large graph is an error', () => {
    const g = clean();
    const huge = {
      ...g,
      nodes: [
        ...g.nodes,
        { ...g.nodes[1]!, id: 'big', config: { text: 'x'.repeat(FLOW_LIMITS.graphMaxBytes) } },
      ],
    };
    expect(codes(validateFlow(huge, ctx))[0]).toBe('limits_exceeded');
  });

  it('orders issues deterministically and every code is reachable by a test above', () => {
    const g = withNode('greet', { config: { text: '' } });
    expect(validateFlow(g, ctx)).toEqual(validateFlow(g, ctx));
    expect(ISSUE_CODES).toHaveLength(23);
  });

  it('validates the largest allowed graph quickly', () => {
    const nodes: RawNode[] = [{ id: 'start', type: 'start' }];
    const edges: RawEdge[] = [];
    let prev = 'start';
    for (let i = 0; i < FLOW_LIMITS.nodesMax - 2; i += 1) {
      const id = `n${String(i)}`;
      nodes.push(
        i % 2
          ? {
              id,
              type: 'gather_dtmf',
              config: { prompt: { kind: 'speak', text: 'x' }, keys: [{ id: 'k1', key: '1' }] },
            }
          : { id, type: 'speak', config: { text: 'Hi {{name}}' } },
      );
      edges.push([prev, prev === 'start' || i % 2 === 1 ? 'next' : 'next', id]);
      prev = id;
    }
    nodes.push({ id: 'bye', type: 'hangup' });
    const fixed = edges.map(
      ([s, , t]) =>
        [
          s,
          nodes.find((n) => n.id === s)?.type === 'gather_dtmf' ? 'key_k1' : 'next',
          t,
        ] as RawEdge,
    );
    fixed.push([
      prev,
      nodes.find((n) => n.id === prev)?.type === 'gather_dtmf' ? 'key_k1' : 'next',
      'bye',
    ]);
    const g = build(nodes, fixed);
    const t0 = performance.now();
    const issues = validateFlow(g, ctx);
    const ms = performance.now() - t0;
    expect(hasErrors(issues)).toBe(false);
    expect(ms).toBeLessThan(100);
  });
});
