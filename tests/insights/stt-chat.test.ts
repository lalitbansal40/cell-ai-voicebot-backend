import { Types } from 'mongoose';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeProvider, createOpenAiProvider } from '../../src/core/ai';
import type { AiJobs } from '../../src/core/ai/jobs';
import { sttCost } from '../../src/core/ai/pricing';
import type { AiProvider, ChatRequest } from '../../src/core/ai/types';
import { sliceMs, speechSegments, splitStereo } from '../../src/core/voice/audio/segments';
import { wavBuffer } from '../../src/core/voice/audio/wav';
import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { CallInsightModel } from '../../src/db/models/call-insight.model';
import { CallModel, type CallDoc } from '../../src/db/models/call.model';
import { ConversationSummaryModel } from '../../src/db/models/conversation-summary.model';
import { ConversationModel } from '../../src/db/models/conversation.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { MessageModel } from '../../src/db/models/message.model';
import { TranscriptTurnModel } from '../../src/db/models/transcript-turn.model';
import { purgeCalls } from '../../src/modules/calls/maintenance';
import { runInboxRetention } from '../../src/modules/inbox/retention.job';
import { runChatSummary, summarizeOnClose } from '../../src/modules/insights/chat-summary.service';
import { sweepInsights } from '../../src/modules/insights/insights.service';
import { runStt, sttJobId, type SttDeps } from '../../src/modules/insights/stt.service';
import { callDoc, messageDoc } from '../helpers/analytics';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { ensureRateCard, fund } from '../helpers/calls';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { json, useStubServer } from '../helpers/stub-server';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const storage = useTempStorage();
const stub = useStubServer();
afterEach(() => stub.reset());

const RATE = 8_000;
const NOW = new Date('2026-10-27T10:00:00.000Z');
const queued: { name: string; data: unknown; jobId?: string }[] = [];
const jobs: AiJobs = {
  enqueue: (name, data, options) => {
    queued.push({ name, data, jobId: options?.jobId });
    return Promise.resolve();
  },
};
const deps = (over: Partial<SttDeps> = {}): SttDeps => ({
  provider: createFakeProvider(),
  model: 'gpt-4.1-mini',
  transcribeModel: 'gpt-4o-mini-transcribe',
  jobs,
  storage,
  now: () => NOW,
  ...over,
});

let t: TestAccount;
let owner: TestUser;
let viewer: TestUser;
let app: ReturnType<typeof buildTestApp>;
const auth = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });

beforeAll(async () => {
  await ensureRateCard();
  t = await createTestAccount();
  owner = await t.addUser('owner');
  viewer = await t.addUser('viewer');
  await fund(t.account._id);
  app = buildTestApp({}, { aiJobs: jobs });
});
beforeEach(() => {
  queued.length = 0;
});

/** Mono tone bursts at the given [startMs, endMs] (amplitude well above the VAD threshold). */
const bursts = (totalMs: number, spans: [number, number][]): Int16Array => {
  const pcm = new Int16Array((totalMs * RATE) / 1000);
  for (const [a, b] of spans)
    for (let i = (a * RATE) / 1000; i < (b * RATE) / 1000; i += 1)
      pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / RATE));
  return pcm;
};
const stereo = (left: Int16Array, right: Int16Array): Buffer => {
  const out = new Int16Array(left.length * 2);
  for (let i = 0; i < left.length; i += 1) {
    out[i * 2] = left[i] as number;
    out[i * 2 + 1] = right[i] as number;
  }
  return wavBuffer(out, RATE, 2);
};

describe('recording segments', () => {
  it('splits stereo into customer / agent and finds speech by time', () => {
    const left = bursts(8000, [
      [500, 1500],
      [4000, 5200],
      [7000, 7100],
    ]);
    const right = bursts(8000, [[2000, 3000]]);
    const audio = splitStereo(stereo(left, right));
    expect(audio.rate).toBe(RATE);
    expect(audio.left).toHaveLength(left.length);
    const segs = speechSegments(audio.left, RATE);
    expect(segs).toHaveLength(2);
    expect(segs[0]?.startMs).toBeGreaterThanOrEqual(400);
    expect(segs[0]?.startMs).toBeLessThanOrEqual(560);
    expect(segs[0]?.endMs).toBeGreaterThanOrEqual(1460);
    expect(segs[0]?.endMs).toBeLessThanOrEqual(1560);
    expect(speechSegments(audio.right, RATE)).toHaveLength(1);
    // long speech is cut, speech running to the end is kept
    const long = speechSegments(bursts(5000, [[0, 5000]]), RATE, { maxMs: 2000 });
    expect(long.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 2000],
      [2000, 4000],
      [4000, 5000],
    ]);
    expect(sliceMs(audio.left, RATE, { startMs: 1000, endMs: 1500 })).toHaveLength(4000);
    const mono = splitStereo(wavBuffer(left, RATE, 1));
    expect(mono.right).toHaveLength(0);
  });

  it('rejects files it cannot read', () => {
    expect(() => splitStereo(Buffer.from('nope'))).toThrow('Not a WAV file');
    const ulaw = wavBuffer(new Int16Array(8), RATE, 1);
    ulaw.writeUInt16LE(7, 20);
    expect(() => splitStereo(ulaw)).toThrow('Only 16-bit PCM');
    expect(() => splitStereo(wavBuffer(new Int16Array(0), RATE).subarray(0, 36))).toThrow(
      'no data',
    );
  });

  it('prices transcription per second at the per-minute rate (rounded up)', () => {
    expect(sttCost({ sttPerMinuteMicros: 500_000 }, 60)).toBe(500_000);
    expect(sttCost({ sttPerMinuteMicros: 500_000 }, 1.2)).toBe(16_667);
    expect(sttCost({ sttPerMinuteMicros: 500_000 }, 0)).toBe(0);
    expect(sttCost({ sttPerMinuteMicros: 0 }, 30)).toBe(0);
  });
});

describe('transcription request (OpenAI)', () => {
  it('posts the clip as multipart with the model; fake sizes its words by the clip', async () => {
    stub.next(json(200, { text: '  haan ji  ' }));
    const provider = createOpenAiProvider({
      apiKey: 'sk-test-not-real',
      baseUrl: `${stub.url}/v1`,
    });
    const clip = wavBuffer(new Int16Array(16_000), RATE);
    expect(await provider.transcribe?.({ model: 'gpt-4o-mini-transcribe', audio: clip })).toEqual({
      text: 'haan ji',
    });
    const req = stub.requests[0];
    expect(req?.url).toBe('/v1/audio/transcriptions');
    expect(req?.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(req?.body).toContain('name="model"');
    expect(req?.body).toContain('gpt-4o-mini-transcribe');
    expect(req?.body).toContain('filename="audio.wav"');
    stub.next(json(200, {}));
    expect(await provider.transcribe?.({ model: 'm', audio: clip })).toEqual({ text: '' });
    expect(await createFakeProvider().transcribe?.({ model: 'm', audio: clip })).toEqual({
      text: 'Fake speech 2.0 s.',
    });
  });
});

const pendingHuman = async (over: Record<string, unknown> = {}) => {
  const id = new Types.ObjectId();
  const key = `accounts/${t.account._id.toString()}/recordings/${id.toString()}.wav`;
  await storage.put(
    key,
    stereo(
      bursts(10_000, [
        [500, 1500],
        [4000, 5000],
      ]),
      bursts(10_000, [[2000, 3000]]),
    ),
    { contentType: 'audio/wav' },
  );
  await CallModel.collection.insertOne(
    callDoc(t.account._id, {
      _id: id,
      mode: 'human',
      source: { kind: null },
      recording: { fileKey: key, durationSec: 10, sizeBytes: 1, format: 'wav' },
      insights: {
        status: 'pending',
        version: 1,
        reason: null,
        sentiment: null,
        hasPromise: false,
        promiseAmountMicros: null,
        hasSummary: false,
        at: NOW,
      },
      ...over,
    }),
  );
  return { id, data: { accountId: t.account._id.toString(), callId: id.toString() } };
};

describe('human-call transcription', () => {
  it('the sweep sends recorded human calls to transcription when the account asked', async () => {
    await AccountModel.updateOne(
      { _id: t.account._id },
      { $set: { 'settings.whatsappCalling.transcribeHumanCalls': true } },
    );
    const { id } = await pendingHuman({
      insights: null,
      timestamps: {
        queuedAt: NOW,
        ringingAt: NOW,
        answeredAt: NOW,
        endedAt: new Date(NOW.getTime() - 60_000),
      },
    });
    const noRecording = callDoc(t.account._id, {
      mode: 'human',
      source: { kind: null },
      insights: null,
      recording: null,
      timestamps: {
        queuedAt: NOW,
        ringingAt: NOW,
        answeredAt: NOW,
        endedAt: new Date(NOW.getTime() - 60_000),
      },
    });
    await CallModel.collection.insertOne(noRecording);
    await sweepInsights(deps());
    expect(queued).toContainEqual({
      name: 'insights.stt',
      data: { accountId: t.account._id.toString(), callId: id.toString() },
      jobId: sttJobId(id.toString()),
    });
    expect((await CallModel.findById(id).lean<CallDoc>())?.insights?.status).toBe('pending');
    expect((await CallModel.findById(noRecording._id).lean<CallDoc>())?.insights?.reason).toBe(
      'no_transcript',
    );
    await AccountModel.updateOne(
      { _id: t.account._id },
      { $set: { 'settings.whatsappCalling.transcribeHumanCalls': false } },
    );
  });

  it('writes customer / agent turns in time order, charges once, then queues the insights', async () => {
    const { id, data } = await pendingHuman();
    await TranscriptTurnModel.create({
      accountId: t.account._id,
      callId: id,
      seq: 1,
      speaker: 'agent',
      text: 'notice',
      source: 'system',
    });
    const result = await runStt(data, deps());
    expect(result).toEqual({ status: 'transcribed', turns: 3 });
    const turns = await TranscriptTurnModel.find({ callId: id }).sort({ seq: 1 }).lean();
    expect(turns.map((x) => [x.seq, x.speaker, x.source])).toEqual([
      [1, 'agent', 'system'],
      [2, 'customer', 'stt'],
      [3, 'agent', 'stt'],
      [4, 'customer', 'stt'],
    ]);
    expect(turns[1]?.text).toMatch(/^Fake speech \d\.\d s\.$/);
    const charges = await LedgerEntryModel.find({
      'ref.id': id.toString(),
      type: 'ai_charge',
    }).lean();
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({
      breakdown: { kind: 'stt', model: 'gpt-4o-mini-transcribe' },
    });
    expect(queued).toEqual([
      {
        name: 'insights.run',
        data: { ...data, version: 1 },
        jobId: `insights-${id.toString()}-v1`,
      },
    ]);
    // a retry replaces the turns and is not charged again
    await runStt(data, deps());
    expect(await TranscriptTurnModel.countDocuments({ callId: id, source: 'stt' })).toBe(3);
    expect(
      await LedgerEntryModel.countDocuments({ 'ref.id': id.toString(), type: 'ai_charge' }),
    ).toBe(1);
  });

  it('missing / deleted recording, too little customer speech, empty wallet, stale jobs', async () => {
    const gone = await pendingHuman({ recording: null });
    expect(await runStt(gone.data, deps())).toEqual({ status: 'skipped', reason: 'no_recording' });
    const deleted = await pendingHuman();
    await CallModel.updateOne({ _id: deleted.id }, { $set: { 'recording.deletedAt': NOW } });
    expect(await runStt(deleted.data, deps())).toEqual({
      status: 'skipped',
      reason: 'no_recording',
    });
    expect(await runStt((await pendingHuman()).data, deps({ storage: undefined }))).toEqual({
      status: 'skipped',
      reason: 'no_recording',
    });
    const quiet = await pendingHuman();
    await storage.put(
      `accounts/${t.account._id.toString()}/recordings/${quiet.id.toString()}.wav`,
      stereo(bursts(4000, [[500, 1500]]), bursts(4000, [])),
      { contentType: 'audio/wav' },
    );
    expect(await runStt(quiet.data, deps())).toEqual({ status: 'skipped', reason: 'too_short' });
    expect(await runStt(quiet.data, deps())).toEqual({ status: 'stale' });
    const poor = await createTestAccount();
    const other = await pendingHuman();
    await CallModel.updateOne({ _id: other.id }, { $set: { accountId: poor.account._id } });
    expect(await runStt({ ...other.data, accountId: poor.account._id.toString() }, deps())).toEqual(
      { status: 'skipped', reason: 'low_balance' },
    );
  });

  it('provider failures retry through the queue, then fail; no transcription → error', async () => {
    const broken: AiProvider = {
      ...createFakeProvider(),
      transcribe: () => Promise.reject(new Error('down')),
    };
    const { id, data } = await pendingHuman();
    await expect(runStt(data, deps({ provider: broken }), { made: 0, max: 3 })).rejects.toThrow(
      'down',
    );
    expect(await runStt(data, deps({ provider: broken }), { made: 2, max: 3 })).toEqual({
      status: 'failed',
      reason: 'stt_failed',
    });
    expect((await CallModel.findById(id).lean<CallDoc>())?.insights?.reason).toBe('stt_failed');
    const bare: AiProvider = {
      name: 'fake',
      chat: () => Promise.reject(new Error('x')),
      embed: () => Promise.reject(new Error('x')),
    };
    await expect(runStt((await pendingHuman()).data, deps({ provider: bare }))).rejects.toThrow(
      'not configured',
    );
  });
});

const chat = async (accountId = t.account._id) => {
  const conversationId = new Types.ObjectId();
  await ConversationModel.collection.insertOne({
    _id: conversationId,
    accountId,
    status: 'open',
    channelId: new Types.ObjectId(),
    contactId: new Types.ObjectId(),
    waId: '919876543210',
  });
  const at = (m: number) => new Date(NOW.getTime() - 3_600_000 + m * 60_000);
  const base = { conversationId, updatedAt: NOW };
  await MessageModel.collection.insertMany([
    messageDoc(accountId, {
      ...base,
      at: at(0),
      direction: 'in',
      origin: 'customer',
      type: 'text',
      text: 'mera EMI kab due hai?',
    }),
    messageDoc(accountId, { ...base, at: at(1), type: 'note', text: 'internal: call him' }),
    messageDoc(accountId, { ...base, at: at(2), type: 'text', text: '30 October ko' }),
    messageDoc(accountId, {
      ...base,
      at: at(3),
      direction: 'in',
      origin: 'customer',
      type: 'image',
      text: null,
      media: { fileName: 'aadhaar-card.jpg' },
    }),
    messageDoc(accountId, { ...base, at: at(4), type: 'reaction', text: null }),
  ]);
  return conversationId;
};

describe('chat summaries', () => {
  it('POST queues a summary (audited), GET lists it; the job summarises new messages only, never notes or file names', async () => {
    const id = await chat();
    const res = await request(app)
      .post(`/api/v1/inbox/conversations/${id.toString()}/summary`)
      .set(auth(owner));
    expect(res.status).toBe(202);
    expect(res.body.data[0]).toMatchObject({
      status: 'pending',
      createdBy: { id: owner.user._id.toString() },
    });
    const summaryId = res.body.data[0].id as string;
    expect(queued).toEqual([
      {
        name: 'insights.chat_summary',
        data: { accountId: t.account._id.toString(), summaryId },
        jobId: `chat-summary-${summaryId}`,
      },
    ]);
    expect(
      await AuditLogModel.exists({
        action: 'conversation.summary_created',
        'meta.summaryId': summaryId,
      }),
    ).toBeTruthy();
    expect(
      (
        await request(app)
          .post(`/api/v1/inbox/conversations/${id.toString()}/summary`)
          .set(auth(owner))
      ).status,
    ).toBe(409);

    const seen: ChatRequest[] = [];
    const fake = createFakeProvider();
    const spy: AiProvider = { ...fake, chat: (r) => (seen.push(r), fake.chat(r)) };
    expect(
      await runChatSummary(
        { accountId: t.account._id.toString(), summaryId },
        { ...deps(), provider: spy },
      ),
    ).toEqual({ status: 'done' });
    const sent = seen[0]?.messages[1]?.content ?? '';
    expect(sent).toContain('[customer] mera EMI kab due hai?');
    expect(sent).toContain('[agent] 30 October ko');
    expect(sent).toContain('[customer] [image]');
    expect(sent).not.toContain('internal');
    expect(sent).not.toContain('aadhaar');
    const list = await request(app)
      .get(`/api/v1/inbox/conversations/${id.toString()}/summary`)
      .set(auth(viewer));
    expect(list.body.data[0]).toMatchObject({
      status: 'done',
      messageCount: 3,
      summary: '3 messages. Customer: "mera EMI kab due hai?".',
    });
    expect(
      await LedgerEntryModel.countDocuments({
        'ref.id': summaryId,
        type: 'ai_charge',
        'breakdown.kind': 'chat_summary',
      }),
    ).toBe(1);
    // nothing new since → 409 CHAT_SUMMARY_EMPTY
    const empty = await request(app)
      .post(`/api/v1/inbox/conversations/${id.toString()}/summary`)
      .set(auth(owner));
    expect([empty.status, empty.body.error.code]).toEqual([409, 'CHAT_SUMMARY_EMPTY']);
    // a new message → the next summary covers only it
    await MessageModel.collection.insertOne(
      messageDoc(t.account._id, {
        conversationId: id,
        at: NOW,
        direction: 'in',
        origin: 'customer',
        text: 'theek hai',
      }),
    );
    const next = await request(app)
      .post(`/api/v1/inbox/conversations/${id.toString()}/summary`)
      .set(auth(owner));
    await runChatSummary(
      { accountId: t.account._id.toString(), summaryId: next.body.data[0].id as string },
      deps(),
    );
    expect(
      (await ConversationSummaryModel.findById(next.body.data[0].id).lean())?.messageCount,
    ).toBe(1);
    expect(
      await runChatSummary({ accountId: t.account._id.toString(), summaryId }, deps()),
    ).toEqual({ status: 'stale' });
  });

  it('refusals and permissions', async () => {
    const id = await chat();
    expect(
      (
        await request(app)
          .post(`/api/v1/inbox/conversations/${id.toString()}/summary`)
          .set(auth(viewer))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get(`/api/v1/inbox/conversations/${new Types.ObjectId().toString()}/summary`)
          .set(auth(owner))
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post(`/api/v1/inbox/conversations/${new Types.ObjectId().toString()}/summary`)
          .set(auth(owner))
      ).status,
    ).toBe(404);
    await AccountModel.updateOne(
      { _id: t.account._id },
      { $set: { 'settings.insights.enabled': false } },
    );
    const off = await request(app)
      .post(`/api/v1/inbox/conversations/${id.toString()}/summary`)
      .set(auth(owner));
    expect(off.body.error.code).toBe('INSIGHTS_DISABLED');
    await AccountModel.updateOne(
      { _id: t.account._id },
      { $set: { 'settings.insights.enabled': true } },
    );
    const poor = await createTestAccount();
    const poorOwner = await poor.addUser('owner');
    const poorChat = await chat(poor.account._id);
    const broke = await request(app)
      .post(`/api/v1/inbox/conversations/${poorChat.toString()}/summary`)
      .set(auth(poorOwner));
    expect(broke.body.error.code).toBe('WALLET_INSUFFICIENT_BALANCE');
  });

  it('job outcomes: invalid output, provider failures, empty, low balance', async () => {
    const make = async () => {
      const id = await chat();
      return (
        await ConversationSummaryModel.create({
          accountId: t.account._id,
          conversationId: id,
          status: 'pending',
        })
      )._id.toString();
    };
    const bad: AiProvider = {
      ...createFakeProvider(),
      chat: () =>
        Promise.resolve({
          content: '{}',
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 1 },
          finishReason: 'stop',
        }),
    };
    const a = await make();
    expect(
      await runChatSummary(
        { accountId: t.account._id.toString(), summaryId: a },
        { ...deps(), provider: bad },
      ),
    ).toEqual({ status: 'failed', reason: 'invalid_output' });
    const down: AiProvider = {
      ...createFakeProvider(),
      chat: () => Promise.reject(new Error('down')),
    };
    const b = await make();
    await expect(
      runChatSummary(
        { accountId: t.account._id.toString(), summaryId: b },
        { ...deps(), provider: down },
        { made: 0, max: 3 },
      ),
    ).rejects.toThrow('down');
    expect(
      await runChatSummary(
        { accountId: t.account._id.toString(), summaryId: b },
        { ...deps(), provider: down },
        { made: 2, max: 3 },
      ),
    ).toEqual({ status: 'failed', reason: 'provider_error' });
    const empty = await ConversationSummaryModel.create({
      accountId: t.account._id,
      conversationId: new Types.ObjectId(),
      status: 'pending',
    });
    expect(
      await runChatSummary(
        { accountId: t.account._id.toString(), summaryId: empty._id.toString() },
        deps(),
      ),
    ).toEqual({ status: 'skipped', reason: 'empty' });
    const c = await make();
    await expect(
      runChatSummary(
        { accountId: t.account._id.toString(), summaryId: c },
        { ...deps(), provider: undefined },
      ),
    ).rejects.toThrow('not configured');
    const poor = await createTestAccount();
    const pc = await chat(poor.account._id);
    const ps = await ConversationSummaryModel.create({
      accountId: poor.account._id,
      conversationId: pc,
      status: 'pending',
    });
    expect(
      await runChatSummary(
        { accountId: poor.account._id.toString(), summaryId: ps._id.toString() },
        deps(),
      ),
    ).toEqual({ status: 'skipped', reason: 'low_balance' });
  });

  it('on close: only when the account asked, only with news, never twice at once, never throws', async () => {
    const id = await chat();
    const conversation = { _id: id, accountId: t.account._id };
    await summarizeOnClose(conversation, jobs);
    expect(queued).toEqual([]);
    await AccountModel.updateOne(
      { _id: t.account._id },
      { $set: { 'settings.insights.chatSummaryOnClose': true } },
    );
    await summarizeOnClose(conversation, jobs);
    await summarizeOnClose(conversation, jobs);
    expect(queued).toHaveLength(1);
    expect(
      (await ConversationSummaryModel.findOne({ conversationId: id }).lean())?.createdBy,
    ).toBeNull();
    await summarizeOnClose({ _id: new Types.ObjectId(), accountId: t.account._id }, jobs);
    expect(queued).toHaveLength(1);
    const warn = vi.fn();
    await expect(
      summarizeOnClose({ _id: id, accountId: 'bad' as never }, { enqueue: warn }),
    ).resolves.toBeUndefined();
    await AccountModel.updateOne(
      { _id: t.account._id },
      { $set: { 'settings.insights.chatSummaryOnClose': false } },
    );
  });
});

describe('retention keeps insights and summaries with their raw data', () => {
  it('purged calls take their insights; purged chats take their summaries', async () => {
    const old = new Date('2026-01-01T00:00:00.000Z');
    const c = callDoc(t.account._id, { createdAt: old });
    await CallModel.collection.insertOne(c);
    await CallInsightModel.create({
      accountId: t.account._id,
      callId: c._id,
      version: 1,
      status: 'done',
    });
    await purgeCalls(undefined, 180, NOW);
    expect(await CallInsightModel.countDocuments({ callId: c._id })).toBe(0);
    await ConversationSummaryModel.collection.insertOne({
      accountId: t.account._id,
      conversationId: new Types.ObjectId(),
      status: 'done',
      createdAt: old,
    });
    const result = await runInboxRetention(storage, 90, NOW);
    expect(result.summaries).toBeGreaterThanOrEqual(1);
    expect(await ConversationSummaryModel.countDocuments({ createdAt: old })).toBe(0);
  });
});
