import { randomBytes, randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeProvider } from '../../src/core/ai';
import type { HttpToolOptions } from '../../src/core/ai/http-tool';
import { seal } from '../../src/core/ai/secret-box';
import type { AiProvider, ChatRequest } from '../../src/core/ai/types';
import { credit } from '../../src/core/billing/engine';
import { advance } from '../../src/core/engine/engine';
import { parseNodeConfig, type NodeConfig } from '../../src/core/engine/schema';
import { memoryStatsRecorder } from '../../src/core/engine/stats';
import { AiAgentModel, type AiAgentDoc } from '../../src/db/models/ai-agent.model';
import { FlowAudioModel } from '../../src/db/models/flow-audio.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { DEFAULT_RATE_CARD, RateCardModel } from '../../src/db/models/rate-card.model';
import { findTemplate } from '../../src/modules/ai-agents/templates';
import {
  agentValues,
  createFlowEffects,
  type FlowEffectsDeps,
} from '../../src/modules/flows/effects';
import { useTestDb } from '../helpers/db';
import { buildGraph } from '../helpers/engine';
import { json, useStubServer } from '../helpers/stub-server';

const fake = createFakeProvider();
const spyChat = () => vi.fn((request: ChatRequest) => fake.chat(request));

useTestDb();
const stub = useStubServer();
const KEY = randomBytes(32);
const NOW = new Date('2026-10-08T19:00:00Z'); // 9 Oct 2026, 00:30 IST
const PHONE = '+919000000017';

let accountId: Types.ObjectId;

const fund = (id: Types.ObjectId, micros = 100_000_000) =>
  credit({
    accountId: id,
    type: 'adjustment',
    amountMicros: micros,
    ref: { type: 'manual', id: 'x' },
    idempotencyKey: `fund-${id.toString()}-${String(micros)}`,
  });

beforeAll(async () => {
  await RateCardModel.create({ accountId: null, ...DEFAULT_RATE_CARD, effectiveFrom: new Date(0) });
  accountId = new Types.ObjectId();
  await fund(accountId);
});
beforeEach(() => stub.reset());
afterEach(() => vi.restoreAllMocks());

const http = (resolveTo = '1.2.3.4'): HttpToolOptions => ({
  policy: { httpsOnly: false, allowPrivate: false, extraPorts: [stub.port] },
  resolve: () => Promise.resolve([resolveTo]),
  dial: () => '127.0.0.1',
});

const deps = (over: Partial<FlowEffectsDeps> = {}): FlowEffectsDeps => ({
  accountId,
  company: 'Acme Finance',
  timezone: 'Asia/Kolkata',
  runId: new Types.ObjectId(),
  mode: 'simulator',
  contact: {
    phone: PHONE,
    externalId: 'EXT-9',
    templateValues: { phone: PHONE, name: 'Asha Verma' },
  },
  provider: createFakeProvider(),
  textModel: 'gpt-4.1-mini',
  embeddingModel: 'text-embedding-3-small',
  secretKey: KEY,
  http: http(),
  now: () => NOW,
  ...over,
});

const api = (config: Record<string, unknown>) => {
  const parsed = parseNodeConfig('api_request', config);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.config;
};
const aiConfig = (agentId: string, over: Record<string, unknown> = {}): NodeConfig<'ai_agent'> => {
  const parsed = parseNodeConfig('ai_agent', { agentId, ...over });
  if (!parsed.ok) throw new Error('bad ai config');
  return parsed.config;
};

const makeAgent = async (
  over: Record<string, unknown> = {},
  account = accountId,
): Promise<AiAgentDoc> => {
  const t = findTemplate(
    { APP_URL: 'http://x', MOCK_APIS_ENABLED: true },
    'loan_recovery_hinglish',
  );
  const values = t?.values ?? ({} as never);
  return (
    await AiAgentModel.create({
      ...values,
      accountId: account,
      name: `Agent ${randomUUID().slice(0, 8)}`,
      model: { textModel: 'gpt-4.1-mini' },
      functions: values.functions.map((f) => ({
        ...f,
        url: `http://pay.public.test:${String(stub.port)}/status?phone={{contact.phone}}`,
      })),
      ...over,
    })
  ).toObject({ transform: false });
};

describe('API request effect', () => {
  it('renders flat + server-only tokens, opens secrets, sends JSON and parses the answer', async () => {
    stub.next(json(200, { status: 'paid', amount: 2500 }));
    const effects = createFlowEffects(deps());
    const config = api({
      method: 'POST',
      url: `http://api.public.test:${String(stub.port)}/check/{{name}}?phone={{contact.phone}}&ext={{contact.external_id}}`,
      headers: [
        { name: 'X-Name', value: 'Hi {{name}}' },
        {
          name: 'X-Key',
          secret: true,
          sealed: seal(KEY, 'sk_flow_secret_1'),
          valueHint: '••••et_1',
        },
      ],
      bodyTemplate: '{"who":"{{name}}","n":"{{count}}"}',
    });
    const res = await effects.callApi({
      nodeId: 'api',
      config,
      values: { name: 'Asha V', count: '3' },
    });
    expect(res).toMatchObject({ ok: true, status: 200, body: { status: 'paid', amount: 2500 } });
    const req = stub.requests[0]!;
    expect(req.url).toBe('/check/Asha%20V?phone=%2B919000000017&ext=EXT-9');
    expect(req.headers['x-key']).toBe('sk_flow_secret_1');
    expect(req.headers['x-name']).toBe('Hi Asha V');
    expect(req.headers['content-type']).toBe('application/json');
    expect(JSON.parse(req.body)).toEqual({ who: 'Asha V', n: '3' });
  });

  it('any status is an answer; blocked / timeout / broken secret / bad JSON are errors', async () => {
    const effects = createFlowEffects(deps());
    const url = `http://api.public.test:${String(stub.port)}/x`;
    stub.next(json(404, { error: 'nope' }));
    expect(await effects.callApi({ nodeId: 'a', config: api({ url }), values: {} })).toMatchObject({
      ok: true,
      status: 404,
    });
    const metadata = createFlowEffects(deps({ http: http('169.254.169.254') }));
    expect(await metadata.callApi({ nodeId: 'a', config: api({ url }), values: {} })).toMatchObject(
      { ok: false, error: 'blocked' },
    );
    stub.next((_req, res) => setTimeout(() => res.end('{}'), 1500));
    expect(
      await effects.callApi({ nodeId: 'a', config: api({ url, timeoutMs: 1000 }), values: {} }),
    ).toMatchObject({ ok: false, error: 'timeout' });
    const broken = api({ url, headers: [{ name: 'X-Key', secret: true, sealed: 'v1:garbage' }] });
    expect(await effects.callApi({ nodeId: 'a', config: broken, values: {} })).toMatchObject({
      ok: false,
      error: 'secret_unavailable',
    });
    const crlf = api({ url, headers: [{ name: 'X-A', value: '{{evil}}' }] });
    expect(
      await effects.callApi({ nodeId: 'a', config: crlf, values: { evil: 'a\r\nb' } }),
    ).toMatchObject({ ok: false, error: 'invalid_request' });
    stub.next((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{bad');
    });
    expect(await effects.callApi({ nodeId: 'a', config: api({ url }), values: {} })).toMatchObject({
      ok: false,
      error: 'invalid_json',
    });
    expect(
      await effects.callApi({ nodeId: 'a', config: api({ url: 'not a url {{x}}' }), values: {} }),
    ).toMatchObject({ ok: false, error: 'invalid_request' });
    // GET never sends a body
    stub.next(json(200, {}));
    await effects.callApi({
      nodeId: 'a',
      config: api({ url, bodyTemplate: '{"a":1}' }),
      values: {},
    });
    expect(stub.requests.at(-1)?.body).toBe('');
  });
});

describe('AI agent effects', () => {
  it('aiStart: opening line; missing agent; turned-off agent gives its fallback', async () => {
    const agent = await makeAgent();
    const effects = createFlowEffects(deps());
    const start = await effects.aiStart({
      nodeId: 'ai',
      config: aiConfig(agent._id.toString()),
      values: { name: 'Asha' },
    });
    expect(start).toMatchObject({ ok: true, reason: null });
    expect(start.text).toContain('Asha');
    expect(
      await effects.aiStart({ nodeId: 'ai', config: aiConfig('c'.repeat(24)), values: {} }),
    ).toEqual({ ok: false, text: null, reason: 'agent_missing' });
    const other = await makeAgent({}, new Types.ObjectId());
    expect(
      (await effects.aiStart({ nodeId: 'ai', config: aiConfig(other._id.toString()), values: {} }))
        .reason,
    ).toBe('agent_missing');
    const off = await makeAgent({ isActive: false });
    const offStart = await effects.aiStart({
      nodeId: 'ai',
      config: aiConfig(off._id.toString()),
      values: {},
    });
    expect(offStart).toMatchObject({ ok: false, reason: 'agentOff' });
    expect(offStart.text).toBeTruthy();
  });

  it('only allowed contact variables + pass variables reach the AI', () => {
    expect(
      agentValues(
        { allowedVariables: ['name'] },
        { passVariables: ['status'] },
        { name: 'A', status: 'paid', phone_last4: '0017' },
      ),
    ).toEqual({
      name: 'A',
      status: 'paid',
    });
  });

  it('a promise turn: outcome, ledger row (flow simulator, run ref, per-input key), replay charges once', async () => {
    const agent = await makeAgent();
    const runId = new Types.ObjectId();
    const chat = spyChat();
    const provider: AiProvider = { ...createFakeProvider(), chat };
    const effects = createFlowEffects(deps({ runId, provider }));
    const input = {
      nodeId: 'ai',
      config: aiConfig(agent._id.toString(), {
        goal: 'Collect a date for {{name}}',
        passVariables: ['status'],
      }),
      values: { name: 'Asha', status: 'unpaid', phone_last4: '0017' },
      turns: [],
      userText: 'kal tak de dunga',
      inputId: 'in-1',
    };
    const first = await effects.aiTurn(input);
    expect(first.outcome.promiseToPay?.date).toBe('2026-10-10');
    expect(first.fallback).toBeNull();
    expect(first.costMicros).toBeGreaterThan(0);
    const system = chat.mock.calls[0]![0].messages[0]!.content;
    expect(system).toContain('## Task in this step\nCollect a date for Asha');
    expect(system).toContain('status: unpaid');
    expect(system).not.toContain('0017');
    await effects.aiTurn(input);
    const rows = await LedgerEntryModel.find({ 'ref.id': runId.toString() }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'ai_charge', breakdown: { kind: 'flow_simulator' } });
  });

  it('wallet empty → fallback without a model call; cap stop → capReached fallback; missing agent → agentOff', async () => {
    const poor = new Types.ObjectId();
    const agent = await makeAgent({}, poor);
    const chat = spyChat();
    const provider: AiProvider = { ...createFakeProvider(), chat };
    const empty = await createFlowEffects(deps({ accountId: poor, provider })).aiTurn({
      nodeId: 'ai',
      config: aiConfig(agent._id.toString()),
      values: {},
      turns: [],
      userText: 'hello',
      inputId: 'x',
    });
    expect(empty).toMatchObject({ fallback: 'walletEmpty', costMicros: 0 });
    expect(chat).not.toHaveBeenCalled();
    const capped = await makeAgent({
      limits: { dailySpendCapMicros: 1, monthlySpendCapMicros: 0, onCap: 'stop' },
    });
    const effects = createFlowEffects(deps());
    const t = (id: string, inputId: string) =>
      effects.aiTurn({
        nodeId: 'ai',
        config: aiConfig(id),
        values: {},
        turns: [],
        userText: 'hello',
        inputId,
      });
    await t(capped._id.toString(), 'c1');
    expect(await t(capped._id.toString(), 'c2')).toMatchObject({ fallback: 'capReached' });
    expect(await t('c'.repeat(24), 'c3')).toMatchObject({ fallback: 'agentOff' });
  });

  it('the engine + live effects: unpaid customer promises → promise_to_pay exit', async () => {
    const agent = await makeAgent();
    const graph = buildGraph(
      [
        { id: 'start', type: 'start' },
        { id: 'ai', type: 'ai_agent', config: { agentId: agent._id.toString() } },
        { id: 'ok', type: 'hangup', config: { text: 'Promise {{promise_date}}' } },
        { id: 'bye', type: 'hangup' },
      ],
      [
        ['start', 'next', 'ai'],
        ['ai', 'promise_to_pay', 'ok'],
        ['ai', 'resolved', 'bye'],
      ],
    );
    const effects = createFlowEffects(deps());
    const ctx = {
      now: () => NOW,
      timezone: 'Asia/Kolkata',
      company: 'Acme Finance',
      mode: 'simulator' as const,
      stats: memoryStatsRecorder(),
    };
    const first = await advance(
      graph,
      null,
      { kind: 'start', trigger: 'test', inputId: 's' },
      effects,
      ctx,
      { name: 'Asha' },
    );
    const next = await advance(
      graph,
      first.state,
      { kind: 'speech', text: 'kal tak de dunga', inputId: 'u1' },
      effects,
      ctx,
    );
    const said = next.outputs.flatMap((o) =>
      o.type === 'say' || o.type === 'ai_reply' ? [o.text] : [],
    );
    expect(said).toEqual([
      'Theek hai, 10 Oct 2026 tak ka promise note kar liya.',
      'Promise 10 Oct 2026',
    ]);
    expect(next.state.outcome.disposition).toBe('promise_to_pay');
  });
});

describe('intent and audio effects', () => {
  it('classifies with the text model and charges flow_intent once per input', async () => {
    const runId = new Types.ObjectId();
    const effects = createFlowEffects(deps({ runId }));
    const intents = [{ id: 'pay', label: 'Pay', keywords: ['pay kar diya'] }];
    expect(
      await effects.classifyIntent({
        nodeId: 'g',
        text: 'maine pay kar diya',
        intents,
        inputId: 'i1',
      }),
    ).toBe('pay');
    expect(
      await effects.classifyIntent({
        nodeId: 'g',
        text: 'maine pay kar diya',
        intents,
        inputId: 'i1',
      }),
    ).toBe('pay');
    const rows = await LedgerEntryModel.find({ 'ref.id': runId.toString() }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.breakdown).toMatchObject({ kind: 'flow_intent', model: 'gpt-4.1-mini' });
    const poor = new Types.ObjectId();
    await expect(
      createFlowEffects(deps({ accountId: poor })).classifyIntent({
        nodeId: 'g',
        text: 'x',
        intents,
        inputId: 'i2',
      }),
    ).rejects.toThrow('wallet_empty');
    // dry-run calls (Phase 8): no wallet check, no charge
    const free = createFlowEffects({ ...deps({ accountId: poor }), billing: 'none' });
    expect(
      await free.classifyIntent({
        nodeId: 'g',
        text: 'maine pay kar diya',
        intents,
        inputId: 'i3',
      }),
    ).toBe('pay');
    expect(await LedgerEntryModel.countDocuments({ accountId: poor })).toBe(0);
  });

  it('loads audio of the account only', async () => {
    const audio = await FlowAudioModel.create({
      accountId,
      name: 'Hello tone',
      fileKey: 'accounts/x/flow-audio/a.wav',
      format: 'wav',
      bytes: 1,
      durationMs: 1,
      sampleRate: 8000,
      channels: 1,
    });
    const effects = createFlowEffects(deps());
    expect(await effects.loadAudio(audio._id.toString())).toEqual({
      id: audio._id.toString(),
      name: 'Hello tone',
    });
    expect(await effects.loadAudio('nope')).toBeNull();
    expect(
      await createFlowEffects(deps({ accountId: new Types.ObjectId() })).loadAudio(
        audio._id.toString(),
      ),
    ).toBeNull();
  });
});
