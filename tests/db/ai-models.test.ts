import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  AgentPlaygroundSessionModel,
  PLAYGROUND_TTL_MS,
} from '../../src/db/models/agent-playground-session.model';
import { AgentToolCallModel } from '../../src/db/models/agent-tool-call.model';
import { AgentUsageModel } from '../../src/db/models/agent-usage.model';
import {
  AiAgentModel,
  DEFAULT_FALLBACKS,
  DISPOSITIONS,
  defaultBuiltInTools,
} from '../../src/db/models/ai-agent.model';
import { KnowledgeBaseModel } from '../../src/db/models/knowledge-base.model';
import { KnowledgeChunkModel } from '../../src/db/models/knowledge-chunk.model';
import { KnowledgeSourceModel } from '../../src/db/models/knowledge-source.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { MockPaymentRecordModel } from '../../src/db/models/mock-payment-record.model';
import { DEFAULT_RATE_CARD, RateCardModel } from '../../src/db/models/rate-card.model';
import { useTestDb } from '../helpers/db';

useTestDb();

const accountId = new Types.ObjectId();
const agent = (overrides: Record<string, unknown> = {}) =>
  AiAgentModel.create({
    accountId,
    name: 'Recovery Bot',
    model: { textModel: 'gpt-4.1-mini' },
    ...overrides,
  });
const indexNames = async (model: {
  collection: {
    indexes: () => Promise<{ name?: string; key: object; expireAfterSeconds?: number }[]>;
  };
}) =>
  (await model.collection.indexes()).map((i) => ({
    key: JSON.stringify(i.key),
    ttl: i.expireAfterSeconds,
  }));

describe('AI agent model', () => {
  it('fills safe defaults', async () => {
    const a = (await agent()).toObject({ transform: false });
    expect(a).toMatchObject({
      isActive: true,
      voice: 'coral',
      languageMode: 'auto',
      language: 'hinglish',
      allowedVariables: ['name'],
      callBehaviour: {
        maxCallDurationSec: 300,
        silenceTimeoutSec: 8,
        bargeIn: true,
        endCallAfterSilenceRetries: 2,
      },
      model: { textModel: 'gpt-4.1-mini', temperatureTenths: 6, maxOutputTokens: 300 },
      limits: { dailySpendCapMicros: 0, monthlySpendCapMicros: 0, onCap: 'fallback' },
      guardrails: { neverSay: [], complianceMode: 'general' },
      fallback: DEFAULT_FALLBACKS,
      knowledge: { knowledgeBaseIds: [], topK: 4, minScoreHundredths: 35 },
      functions: [],
      deletedAt: null,
    });
    expect(a.builtInTools.setDisposition.allowed).toEqual([...DISPOSITIONS]);
    expect(defaultBuiltInTools().endCall.enabled).toBe(true);
  });

  it('validates enums, ranges, function names and caps', async () => {
    for (const bad of [
      { voice: 'robot' },
      { language: 'fr' },
      { callBehaviour: { maxCallDurationSec: 30 } },
      { model: { textModel: 'x', temperatureTenths: 13 } },
      { limits: { dailySpendCapMicros: 1.5 } },
      { limits: { monthlySpendCapMicros: 200_000_000_000 } },
      {
        functions: [
          { name: 'Bad Name', description: 'd'.repeat(10), method: 'GET', url: 'https://x' },
        ],
      },
      { functions: [{ name: 'check_x', description: 'd', method: 'DELETE', url: 'https://x' }] },
      { toneRules: [{ when: 'happy', respond: 'x' }] },
    ]) {
      await expect(agent({ name: `n-${Math.random()}`, ...bad })).rejects.toThrow();
    }
  });

  it('keeps names unique per account (case-insensitive) except for deleted agents', async () => {
    const first = await agent({ name: 'Unique Bot' });
    await expect(agent({ name: 'unique bot' })).rejects.toThrow(/duplicate key/);
    await agent({ name: 'Unique Bot', accountId: new Types.ObjectId() });
    first.deletedAt = new Date();
    await first.save();
    await expect(agent({ name: 'UNIQUE BOT' })).resolves.toBeTruthy();
  });

  it('declares its indexes', async () => {
    await AiAgentModel.syncIndexes();
    const keys = (await indexNames(AiAgentModel)).map((i) => i.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        '{"accountId":1,"name":1}',
        '{"accountId":1,"isActive":1}',
        '{"accountId":1,"updatedAt":-1}',
      ]),
    );
  });
});

describe('knowledge models', () => {
  it('stores bases, sources and chunks with defaults and hides internals', async () => {
    const kb = await KnowledgeBaseModel.create({ accountId, name: 'FAQ' });
    expect(kb.toObject({ transform: false })).toMatchObject({
      version: 0,
      sourcesCount: 0,
      chunksCount: 0,
      status: 'ok',
    });
    await expect(KnowledgeBaseModel.create({ accountId, name: 'faq' })).rejects.toThrow(
      /duplicate key/,
    );
    const source = await KnowledgeSourceModel.create({
      accountId,
      kbId: kb._id,
      kind: 'file',
      title: 'faq.txt',
      fileType: 'txt',
      fileKey: 'k',
    });
    expect(source.toObject({ transform: false })).toMatchObject({
      status: 'queued',
      progress: 0,
      version: 0,
    });
    expect(source.toJSON()).not.toHaveProperty('fileKey');
    await expect(
      KnowledgeSourceModel.create({ accountId, kbId: kb._id, kind: 'pdf', title: 'x' } as never),
    ).rejects.toThrow();
    const chunk = await KnowledgeChunkModel.create({
      accountId,
      kbId: kb._id,
      sourceId: source._id,
      sourceVersion: 0,
      order: 0,
      text: 'hello',
      embedding: [1, 0],
      dims: 2,
      model: 'fake',
    });
    expect(chunk.toJSON()).not.toHaveProperty('embedding');
    await expect(
      KnowledgeChunkModel.create({
        accountId,
        kbId: kb._id,
        sourceId: source._id,
        sourceVersion: 0,
        order: 1,
        text: 'x'.repeat(4001),
        embedding: [1],
        dims: 1,
        model: 'f',
      }),
    ).rejects.toThrow();
  });
});

describe('playground, tool call, usage and mock models', () => {
  it('expires playground sessions and tool calls by TTL and hides the test phone', async () => {
    await AgentPlaygroundSessionModel.syncIndexes();
    await AgentToolCallModel.syncIndexes();
    expect(await indexNames(AgentPlaygroundSessionModel)).toContainEqual({
      key: '{"expiresAt":1}',
      ttl: 0,
    });
    expect(await indexNames(AgentToolCallModel)).toContainEqual({ key: '{"expiresAt":1}', ttl: 0 });
    const s = await AgentPlaygroundSessionModel.create({
      accountId,
      agentId: new Types.ObjectId(),
      userId: new Types.ObjectId(),
      testPhone: '+919000000001',
      expiresAt: new Date(Date.now() + PLAYGROUND_TTL_MS),
    });
    expect(s.toJSON()).not.toHaveProperty('testPhone');
    const read = await AgentPlaygroundSessionModel.findById(s._id).lean();
    expect(read?.testPhone).toBeUndefined();
    expect(read?.outcome).toMatchObject({
      disposition: null,
      transferRequested: false,
      endRequested: false,
    });
    const withPhone = await AgentPlaygroundSessionModel.findById(s._id).select('+testPhone').lean();
    expect(withPhone?.testPhone).toBe('+919000000001');
    await expect(
      AgentToolCallModel.create({
        accountId,
        agentId: new Types.ObjectId(),
        source: 'mail' as never,
        tool: 'x',
        kind: 'custom',
        status: 'ok',
        expiresAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('keeps one usage row per agent and day', async () => {
    await AgentUsageModel.syncIndexes();
    const agentId = new Types.ObjectId();
    await AgentUsageModel.create({ accountId, agentId, day: '2026-10-09', month: '2026-10' });
    await expect(
      AgentUsageModel.create({ accountId, agentId, day: '2026-10-09', month: '2026-10' }),
    ).rejects.toThrow(/duplicate key/);
    await expect(
      AgentUsageModel.create({ accountId, agentId, day: '9 Oct', month: '2026-10' }),
    ).rejects.toThrow();
  });

  it('validates mock payment records', async () => {
    await MockPaymentRecordModel.create({
      phoneE164: '+919000000002',
      status: 'paid',
      amountMicros: 1,
      paidOn: '2026-10-08',
    });
    await expect(
      MockPaymentRecordModel.create({ phoneE164: '98765', status: 'paid', amountMicros: 1 }),
    ).rejects.toThrow();
    await expect(
      MockPaymentRecordModel.create({
        phoneE164: '+919000000002',
        status: 'maybe' as never,
        amountMicros: 1,
      }),
    ).rejects.toThrow();
  });
});

describe('Phase 4 models extended for AI', () => {
  it('rate cards carry AI prices with defaults', async () => {
    const {
      aiTextPer1kTokensMicros: _a,
      embeddingPer1kTokensMicros: _e,
      ...withoutAi
    } = DEFAULT_RATE_CARD;
    const card = await RateCardModel.create({
      ...withoutAi,
      accountId: null,
      effectiveFrom: new Date(),
    });
    expect(card.aiTextPer1kTokensMicros).toBe(200_000);
    expect(card.embeddingPer1kTokensMicros).toBe(10_000);
    await expect(
      RateCardModel.create({
        ...DEFAULT_RATE_CARD,
        aiTextPer1kTokensMicros: 1.5,
        effectiveFrom: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('ledger breakdown accepts token counts and usage kinds only', async () => {
    const base: Record<string, unknown> = {
      accountId,
      type: 'ai_charge',
      direction: 'debit',
      status: 'captured',
      amountMicros: 1,
      ref: { type: 'usage', id: 'x' },
    };
    const ok = await LedgerEntryModel.create({
      ...base,
      idempotencyKey: 'k1',
      breakdown: { inputTokens: 10, outputTokens: 5, model: 'gpt-4.1-mini', kind: 'playground' },
    });
    expect(ok.breakdown).toMatchObject({ inputTokens: 10, outputTokens: 5, kind: 'playground' });
    await expect(
      LedgerEntryModel.create({
        ...base,
        idempotencyKey: 'k2',
        breakdown: { kind: 'fun' },
      } as never),
    ).rejects.toThrow();
    await expect(
      LedgerEntryModel.create({
        ...base,
        idempotencyKey: 'k3',
        breakdown: { inputTokens: 1.5 },
      } as never),
    ).rejects.toThrow();
  });
});
