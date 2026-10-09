import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Types } from 'mongoose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { createFakeProvider } from '../../src/core/ai';
import type { HttpToolOptions } from '../../src/core/ai/http-tool';
import {
  HISTORY_MARKER,
  historyWindow,
  runAgentTurn,
  type TurnInput,
} from '../../src/core/ai/run-turn';
import type { AiProvider, ChatRequest } from '../../src/core/ai/types';
import * as billingEngine from '../../src/core/billing/engine';
import { credit } from '../../src/core/billing/engine';
import { storageKey } from '../../src/core/storage';
import { AgentToolCallModel } from '../../src/db/models/agent-tool-call.model';
import { AgentUsageModel } from '../../src/db/models/agent-usage.model';
import { AiAgentModel, type AiAgentDoc } from '../../src/db/models/ai-agent.model';
import { KnowledgeBaseModel } from '../../src/db/models/knowledge-base.model';
import { KnowledgeSourceModel } from '../../src/db/models/knowledge-source.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { DEFAULT_RATE_CARD, RateCardModel } from '../../src/db/models/rate-card.model';
import { findTemplate } from '../../src/modules/ai-agents/templates';
import { ingestSource } from '../../src/modules/knowledge/ingest.job';
import { AppError } from '../../src/shared/errors/app-error';
import { recordingAiJobs } from '../helpers/ai';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { json, useStubServer } from '../helpers/stub-server';

useTestDb();
const stub = useStubServer();
const storage = useTempStorage();
const KEY = randomBytes(32);
const NOW = new Date('2026-10-08T19:00:00Z'); // 9 Oct 2026, 00:30 IST
const PHONE = '+919000000002';

let accountId: Types.ObjectId;

const fund = (id: Types.ObjectId, micros = 100_000_000) =>
  credit({
    accountId: id,
    type: 'adjustment',
    amountMicros: micros,
    ref: { type: 'manual', id: 'x' },
    idempotencyKey: `fund-${id.toString()}-${micros}`,
  });

beforeAll(async () => {
  await RateCardModel.create({ accountId: null, ...DEFAULT_RATE_CARD, effectiveFrom: new Date(0) });
  accountId = new Types.ObjectId();
  await fund(accountId);
});
beforeEach(() => stub.reset());
afterEach(() => vi.restoreAllMocks());

const http = (): HttpToolOptions => ({
  policy: { httpsOnly: false, allowPrivate: false, extraPorts: [stub.port] },
  resolve: () => Promise.resolve(['1.2.3.4']),
  dial: () => '127.0.0.1',
});

const makeAgent = async (
  over: Record<string, unknown> = {},
  account = accountId,
): Promise<AiAgentDoc> => {
  const t = findTemplate(
    { APP_URL: 'http://x', MOCK_APIS_ENABLED: true },
    'loan_recovery_hinglish',
  );
  const values = t?.values ?? ({} as never);
  const doc = await AiAgentModel.create({
    ...values,
    accountId: account,
    name: `Agent ${randomUUID().slice(0, 8)}`,
    model: { textModel: 'gpt-4.1-mini' },
    functions: values.functions.map((f) => ({
      ...f,
      url: `http://pay.public.test:${stub.port}/status?phone={{contact.phone}}`,
    })),
    ...over,
  });
  return doc.toObject({ transform: false });
};

const session = (over: Partial<TurnInput['session']> = {}) => ({
  _id: new Types.ObjectId(),
  turns: [],
  variables: { name: 'Asha Verma' },
  ...over,
});

const turn = (agent: AiAgentDoc, userText: string, over: Partial<TurnInput> = {}) =>
  runAgentTurn({
    accountId: agent.accountId,
    agent,
    session: session(),
    userText,
    clientTurnId: randomUUID(),
    provider: createFakeProvider(),
    now: NOW,
    timezone: 'Asia/Kolkata',
    company: 'Acme Finance',
    contact: { phone: PHONE, name: 'Asha Verma' },
    secretKey: KEY,
    http: http(),
    embeddingModel: 'text-embedding-3-small',
    ...over,
  });

describe('runAgentTurn — conversations', () => {
  it('payment claim → checks the API with the contact phone → paid reply, billed once', async () => {
    const agent = await makeAgent();
    stub.next(
      json(200, {
        found: true,
        status: 'paid',
        amountRupees: 2500,
        paidOn: '2026-10-08',
        loanId: null,
      }),
    );
    const s = session();
    const clientTurnId = randomUUID();
    const out = await turn(agent, 'maine payment kar diya hai', { session: s, clientTurnId });
    expect(stub.requests[0]?.url).toBe('/status?phone=%2B919000000002');
    expect(out.turn.toolCalls).toEqual([
      expect.objectContaining({
        name: 'check_payment_status',
        kind: 'custom',
        ok: true,
        simulated: false,
      }),
    ]);
    expect(out.turn.text).toContain('Dhanyavaad');
    expect(out.turn.text).toContain('2500');
    expect(out.turn).toMatchObject({
      billing: 'charged',
      fallback: null,
      guardrail: null,
      clientTurnId,
    });
    expect(out.turn.costMicros).toBeGreaterThan(0);
    expect(out.turn.inputTokens).toBeGreaterThan(0);

    const ledger = await LedgerEntryModel.find({
      idempotencyKey: `aiturn:${s._id.toString()}:${clientTurnId}`,
    }).lean();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.breakdown).toMatchObject({
      kind: 'playground',
      model: 'gpt-4.1-mini',
      inputTokens: out.turn.inputTokens,
    });
    expect(await AgentUsageModel.findOne({ agentId: agent._id }).lean()).toMatchObject({
      turns: 1,
      day: '2026-10-09',
    });
    const log = await AgentToolCallModel.findOne({ agentId: agent._id }).lean();
    expect(log).toMatchObject({
      source: 'playground',
      sessionId: s._id,
      tool: 'check_payment_status',
      status: 'ok',
    });
    expect(JSON.stringify(log)).not.toContain('9000000002');

    // the same turn again (retry): one ledger row, counters unchanged
    stub.next(json(200, { status: 'paid', amountRupees: 2500, paidOn: '2026-10-08' }));
    const again = await turn(agent, 'maine payment kar diya hai', { session: s, clientTurnId });
    expect(again.turn.billing).toBe('charged');
    expect(
      await LedgerEntryModel.countDocuments({
        idempotencyKey: `aiturn:${s._id.toString()}:${clientTurnId}`,
      }),
    ).toBe(1);
    expect((await AgentUsageModel.findOne({ agentId: agent._id }).lean())?.turns).toBe(1);
  });

  it('unpaid → asks for a date; promise → outcome with tomorrow in IST', async () => {
    const agent = await makeAgent();
    stub.next(json(200, { status: 'unpaid', amountRupees: 2500, paidOn: null }));
    const unpaid = await turn(agent, 'maine pay kar diya');
    expect(unpaid.turn.text).toContain('payment nahi dikh raha');
    const promise = await turn(agent, 'kal tak de dunga');
    expect(promise.outcome).toEqual({ promiseToPay: { date: '2026-10-10', amountMicros: null } });
    expect(promise.turn.toolCalls[0]).toMatchObject({
      name: 'save_promise_to_pay',
      kind: 'built_in',
      ok: true,
      simulated: true,
    });
    expect(promise.turn.text).toContain('10 Oct 2026');
  });

  it('transfer and goodbye set the outcome; goodbye ends with the closing line', async () => {
    const agent = await makeAgent({
      builtInTools: {
        ...(await makeAgent()).builtInTools,
        transferToHuman: { enabled: true, phone: null, message: null },
      },
    });
    expect((await turn(agent, 'mujhe insaan se baat karni hai')).outcome).toEqual({
      transferRequested: true,
    });
    const bye = await turn(agent, 'ok bye');
    expect(bye).toMatchObject({ ended: true, outcome: { endRequested: true } });
    expect(bye.turn.text).toBe('Aapke samay ke liye dhanyavaad. Aapka din shubh ho.');
  });

  it('answers from the knowledge base and returns the references', async () => {
    const kb = await KnowledgeBaseModel.create({
      accountId,
      name: `KB ${randomUUID().slice(0, 6)}`,
    });
    const _id = new Types.ObjectId();
    const key = storageKey({
      accountId: accountId.toString(),
      area: 'knowledge',
      id: _id.toString(),
      ext: 'txt',
    });
    await storage.put(key, readFileSync(path.resolve(__dirname, '../fixtures/knowledge/faq.txt')), {
      contentType: 'text/plain',
    });
    await KnowledgeSourceModel.create({
      _id,
      accountId,
      kbId: kb._id,
      kind: 'file',
      title: 'faq.txt',
      fileType: 'txt',
      fileKey: key,
      version: 1,
    });
    await ingestSource(
      {
        accountId: accountId.toString(),
        kbId: kb._id.toString(),
        sourceId: _id.toString(),
        version: 1,
      },
      { provider: createFakeProvider(), storage, jobs: recordingAiJobs().jobs, throttleMs: 0 },
    );
    const agent = await makeAgent({
      knowledge: { knowledgeBaseIds: [kb._id], topK: 2, minScoreHundredths: 10 },
    });
    const out = await turn(agent, 'late fee kitni lagti hai?');
    expect(out.turn.text).toBe(
      'Due date ke baad har din ₹50 late fee lagti hai, maximum ₹500 tak.',
    );
    expect(out.turn.knowledge[0]).toMatchObject({ title: 'Late fee' });
    expect(out.turn.knowledge[0]?.snippet.length).toBeLessThanOrEqual(200);
    const row = await LedgerEntryModel.findOne({
      'ref.id': { $exists: true },
      'breakdown.kind': 'playground',
      'breakdown.embeddingTokens': { $gt: 0 },
    }).lean();
    expect(row).not.toBeNull();
  });

  it('bad tool arguments never reach the API; the model is told and replies', async () => {
    const agent = await makeAgent();
    agent.functions[0]!.parameters = [
      { name: 'loan_no', type: 'integer', description: 'Loan', required: true },
    ];
    const out = await turn(agent, 'maine pay kar diya');
    expect(stub.requests).toHaveLength(0);
    expect(out.turn.toolCalls[0]).toMatchObject({ ok: false, error: 'invalid_arguments' });
    expect(out.turn.text).toBe('Maaf kijiye, abhi check nahi ho pa raha.');
  });

  it('a timed-out API becomes a tool error and the model still replies', async () => {
    const agent = await makeAgent();
    agent.functions[0]!.timeoutMs = 1000;
    stub.next(() => undefined);
    const out = await turn(agent, 'maine pay kar diya');
    expect(out.turn.toolCalls[0]).toMatchObject({ ok: false, error: 'timeout' });
    expect(out.turn.text).toBe('Maaf kijiye, abhi check nahi ho pa raha.');
  });
});

describe('runAgentTurn — guardrails, fallbacks and gates', () => {
  const scripted = (...replies: string[]): AiProvider & { calls: Mock<AiProvider['chat']> } => {
    const fake = createFakeProvider();
    let i = 0;
    const calls = vi.fn<AiProvider['chat']>(() => {
      const content = replies[Math.min(i, replies.length - 1)] ?? '';
      i += 1;
      return Promise.resolve({
        content,
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        finishReason: 'stop' as const,
      });
    });
    return { name: 'fake', embed: (request) => fake.embed(request), chat: calls, calls };
  };

  it('a blocked reply is retried once and replaced when it passes', async () => {
    const agent = await makeAgent();
    const provider = scripted('Apna OTP batao jaldi.', 'Ji, main aapki madad karunga.');
    const out = await turn(agent, 'hello', { provider });
    expect(out.turn).toMatchObject({
      text: 'Ji, main aapki madad karunga.',
      guardrail: 'secret_request',
      fallback: null,
      billing: 'charged',
    });
    const retry = provider.calls.mock.calls[1]?.[0] as ChatRequest;
    expect(retry.messages.at(-1)?.content).toContain('Your last reply broke a rule');
    expect(retry.tools).toBeUndefined();
  });

  it('a reply blocked twice becomes the AI-failed fallback (tokens still billed)', async () => {
    const agent = await makeAgent();
    const out = await turn(agent, 'hello', { provider: scripted('Legal notice aa raha hai.') });
    expect(out.turn).toMatchObject({
      guardrail: 'never_say',
      fallback: 'aiFailed',
      billing: 'charged',
    });
    expect(out.turn.text).toBe(agent.fallback.aiFailed);
  });

  it('provider down → AI-failed fallback, nothing billed', async () => {
    const agent = await makeAgent();
    const before = await LedgerEntryModel.countDocuments({ accountId });
    const down: AiProvider = {
      ...createFakeProvider(),
      chat: () => Promise.reject(new AppError('PROVIDER_UNAVAILABLE')),
    };
    const out = await turn(agent, 'hello', { provider: down });
    expect(out.turn).toMatchObject({ fallback: 'aiFailed', billing: 'none', costMicros: 0 });
    expect(await LedgerEntryModel.countDocuments({ accountId })).toBe(before);
    await expect(
      turn(agent, 'hello', { provider: { ...down, chat: () => Promise.reject(new Error('bug')) } }),
    ).rejects.toThrow('bug');
  });

  it('inactive agent and empty wallet answer with fallbacks without calling the model', async () => {
    const provider = scripted('x');
    const off = await makeAgent({ isActive: false });
    expect((await turn(off, 'hi', { provider })).turn).toMatchObject({
      fallback: 'agentOff',
      text: off.fallback.agentOff,
      billing: 'none',
    });
    const poor = new Types.ObjectId();
    const agent = await makeAgent({}, poor);
    expect((await turn(agent, 'hi', { provider })).turn).toMatchObject({
      fallback: 'walletEmpty',
      costMicros: 0,
    });
    expect(provider.calls).not.toHaveBeenCalled();
  });

  it('spend caps: stop throws, fallback answers', async () => {
    const stop = await makeAgent({
      limits: { dailySpendCapMicros: 100, monthlySpendCapMicros: 0, onCap: 'stop' },
    });
    await AgentUsageModel.create({
      accountId,
      agentId: stop._id,
      day: '2026-10-09',
      month: '2026-10',
      spentMicros: 100,
      turns: 1,
    });
    await expect(turn(stop, 'hi')).rejects.toMatchObject({ code: 'AI_SPEND_CAP_REACHED' });
    const soft = await makeAgent({
      limits: { dailySpendCapMicros: 0, monthlySpendCapMicros: 50, onCap: 'fallback' },
    });
    await AgentUsageModel.create({
      accountId,
      agentId: soft._id,
      day: '2026-10-01',
      month: '2026-10',
      spentMicros: 60,
      turns: 1,
    });
    expect((await turn(soft, 'hi')).turn).toMatchObject({
      fallback: 'capReached',
      text: soft.fallback.capReached,
    });
  });

  it('a charge refused at the last moment keeps the reply and records billing failed', async () => {
    const agent = await makeAgent();
    vi.spyOn(billingEngine, 'chargeUsage').mockRejectedValueOnce(
      new AppError('WALLET_INSUFFICIENT_BALANCE'),
    );
    const out = await turn(agent, 'hello');
    expect(out.turn).toMatchObject({ billing: 'failed', costMicros: 0, fallback: null });
    expect(out.turn.text.length).toBeGreaterThan(0);
  });

  it('logs no message, persona or contact text', async () => {
    const agent = await makeAgent();
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    stub.next(json(200, { status: 'paid', amountRupees: 2500, paidOn: '2026-10-08' }));
    await turn(agent, 'SECRET-USER-TEXT maine pay kar diya');
    const all = writes.join('\n');
    for (const s of ['SECRET-USER-TEXT', 'vinamra recovery', 'Asha Verma', '9000000002'])
      expect(all).not.toContain(s);
  });
});

describe('historyWindow', () => {
  it('keeps the last 20 turns within the token budget and marks dropped ones', () => {
    const turns = Array.from({ length: 25 }, (_, i) => ({
      role: i % 2 ? ('assistant' as const) : ('user' as const),
      text: `t${i}`,
      clientTurnId: null,
    }));
    const h = historyWindow(turns);
    expect(h[0]).toEqual({ role: 'system', content: HISTORY_MARKER });
    expect(h).toHaveLength(21);
    expect(h[1]?.content).toBe('t5');
    const big = [
      { role: 'user' as const, text: 'x'.repeat(40_000), clientTurnId: null },
      { role: 'assistant' as const, text: 'y'.repeat(20_000), clientTurnId: null },
    ];
    expect(historyWindow(big).map((m) => m.content.slice(0, 1))).toEqual([
      HISTORY_MARKER.slice(0, 1),
      'y',
    ]);
    expect(historyWindow(turns.slice(0, 3))).toHaveLength(3);
  });
});
