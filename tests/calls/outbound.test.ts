import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import type { Redis } from 'ioredis';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnv } from '../../src/config/env';
import { createFakeProvider } from '../../src/core/ai';
import { callCharge } from '../../src/core/billing/pricing';
import { effectiveRateCard } from '../../src/core/billing/rates';
import { PHRASES } from '../../src/core/telephony/scenarios';
import { FakeTts } from '../../src/core/voice/providers';
import { TtsCache } from '../../src/core/voice/tts-cache';
import { AiAgentModel } from '../../src/db/models/ai-agent.model';
import { CallModel, type CallSource } from '../../src/db/models/call.model';
import {
  defaultDryRun,
  SCENARIO_KEYS,
  type DryRunOutcome,
  type ScenarioKey,
} from '../../src/db/models/campaign.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { CustomFieldModel } from '../../src/db/models/custom-field.model';
import { FlowModel } from '../../src/db/models/flow.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { TranscriptTurnModel } from '../../src/db/models/transcript-turn.model';
import { CallManager, type StartOutboundCallInput } from '../../src/modules/calls/call.service';
import { createDryRunPrograms } from '../../src/modules/calls/dry-run';
import { CallRegistry } from '../../src/modules/calls/registry';
import { VirtualCallBilling } from '../../src/modules/calls/virtual-billing';
import { LOAN_TEXTS } from '../../src/modules/flows/templates';
import { createLogger } from '../../src/shared/logger';
import { addDays, ymdInZone } from '../../src/shared/time';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { ensureRateCard } from '../helpers/calls';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { FLOWS, auth } from '../helpers/flows';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const storage = useTempStorage();
const recordingDir = mkdtempSync(path.join(tmpdir(), 'cav-outbound-'));
const prefix = `${uniquePrefix('outbound')}:`;
const extraPorts: number[] = [];
const app = buildTestApp(
  {},
  {
    storage,
    aiProvider: createFakeProvider(),
    aiHttp: { extraPorts, resolve: () => Promise.resolve(['127.0.0.1']) },
  },
);
const logLines: string[] = [];
const logger = createLogger(
  { NODE_ENV: 'test', LOG_LEVEL: 'trace' },
  new Writable({
    write(chunk: Buffer, _enc, done) {
      logLines.push(chunk.toString());
      done();
    },
  }),
);

let server: Server;
let redis: Redis;
let t: TestAccount;
let owner: TestUser;
let manager: CallManager;
let flowId: string;
let flowVersionId: string;
let paid: string;
let unpaid: string;
const PAID_PHONE = '+919000500012';
const UNPAID_PHONE = '+919000500017';

beforeAll(async () => {
  server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  extraPorts.push(port);
  const base = `http://127.0.0.1:${String(port)}`;
  redis = (await requireRedis()).client;
  await ensureRateCard();
  t = await createTestAccount({ name: 'Acme Finance' });
  owner = await t.addUser('owner');
  await CustomFieldModel.create([
    { accountId: t.account._id, key: 'amount', label: 'Amount', type: 'currency' },
    { accountId: t.account._id, key: 'due_date', label: 'Due date', type: 'date' },
  ]);
  const agent = await request(app)
    .post('/api/v1/agents')
    .set(auth(owner))
    .send({ name: 'Recovery', templateKey: 'loan_recovery_hinglish' });
  const agentId = agent.body.data.id as string;
  const mockUrl = `${base}/api/v1/mock/payment-status?phone={{contact.phone}}`;
  await AiAgentModel.updateOne({ _id: agentId }, { $set: { 'functions.0.url': mockUrl } });
  const created = await request(app)
    .post(FLOWS)
    .set(auth(owner))
    .send({ name: 'Loan recovery', templateKey: 'loan_recovery', agentIds: { ai: agentId } });
  flowId = created.body.data.id;
  const draft = created.body.data.draft;
  draft.nodes.find((n: { id: string }) => n.id === 'check').config.url = mockUrl;
  await request(app)
    .put(`${FLOWS}/${flowId}/draft`)
    .set(auth(owner))
    .send({ revision: 1, graph: draft });
  const published = await request(app)
    .post(`${FLOWS}/${flowId}/publish`)
    .set(auth(owner))
    .send({ revision: 2 });
  expect(published.status, JSON.stringify(published.body)).toBe(201);
  flowVersionId = String((await FlowModel.findById(flowId).lean())?.publishedVersionId);
  const contact = (phone: string, name: string) =>
    ContactModel.create({
      accountId: t.account._id,
      phoneE164: phone,
      name,
      source: { type: 'manual' },
      variables: { amount: 2_500_000_000, due_date: '2026-10-10' },
    });
  paid = (await contact(PAID_PHONE, 'Asha Verma'))._id.toString();
  unpaid = (await contact(UNPAID_PHONE, 'Ravi Kumar'))._id.toString();
  const env = loadEnv({ MOCK_APIS_ENABLED: 'true', APP_URL: base, VOICE_PROVIDER: 'fake' });
  const programs = createDryRunPrograms({ env, storage, redis });
  manager = new CallManager({
    logger,
    registry: new CallRegistry(redis, prefix),
    tts: new TtsCache({ tts: new FakeTts(), storage }),
    storage,
    recordingDir,
    scriptFor: () => Promise.reject(new Error('web calls are not used here')),
    dryRun: programs,
  });
});
afterAll(async () => {
  await manager?.shutdown();
  await flushPrefix(redis, prefix);
  redis.disconnect();
  rmSync(recordingDir, { recursive: true, force: true });
  await new Promise<void>((done) => server.close(() => done()));
});

const ONLY = (key: ScenarioKey): Record<ScenarioKey, number> =>
  Object.fromEntries(SCENARIO_KEYS.map((k) => [k, k === key ? 100 : 0])) as Record<
    ScenarioKey,
    number
  >;
const MIX = (outcome: DryRunOutcome) => {
  const mix = { answered: 0, no_answer: 0, busy: 0, failed: 0, invalid_number: 0 };
  mix[outcome] = 10_000;
  return mix;
};

let attempts = 0;
const source = (): CallSource => ({
  kind: 'flow',
  flowId: new Types.ObjectId(flowId),
  flowVersionRef: 1,
  flowVersionId: new Types.ObjectId(flowVersionId),
});
const dial = (
  contactId: string,
  phone: string,
  over: Partial<StartOutboundCallInput> & {
    scenario?: ScenarioKey;
    outcome?: DryRunOutcome;
    seed?: string;
  } = {},
) => {
  attempts += 1;
  const { scenario = 'paid', outcome = 'answered', seed = `s-${String(attempts)}`, ...rest } = over;
  return manager.startOutboundCall({
    accountId: t.account._id.toString(),
    provider: 'dryrun',
    to: phone,
    contactId,
    source: source(),
    variables: { name: 'Snapshot Name' },
    campaign: {
      campaignId: new Types.ObjectId().toString(),
      campaignContactId: new Types.ObjectId().toString(),
      attempt: 1,
    },
    initiatedBy: null,
    groupLimit: 10,
    dryRun: {
      seed,
      mix: MIX(outcome),
      scenarios: ONLY(scenario),
      templateKey: 'loan_recovery',
      speed: 100,
    },
    ...rest,
  });
};
const texts = async (callId: string) =>
  (await TranscriptTurnModel.find({ callId }).sort({ seq: 1 }).lean()).map(
    (turn) => `${turn.speaker}: ${turn.text}`,
  );
const tomorrow = () => addDays(ymdInZone(new Date(), 'Asia/Kolkata'), 1);

describe('outbound dry-run calls', () => {
  it('pre-answer outcomes end the call without a session: busy / no answer / failed / invalid number', async () => {
    const cases = [
      ['no_answer', 'no_answer', 'no_answer'],
      ['busy', 'busy', 'busy'],
      ['failed', 'failed', 'media_error'],
      ['invalid_number', 'failed', 'invalid_number'],
    ] as const;
    for (const [outcome, status, endReason] of cases) {
      const call = await dial(paid, PAID_PHONE, { outcome });
      const summary = await call.ended;
      expect(summary).toMatchObject({ status, endReason, durationSec: 0, costMicros: 0 });
      expect(await CallModel.findById(call.callId).lean()).toMatchObject({
        provider: 'dryrun',
        from: 'dryrun',
        to: PAID_PHONE,
        isTest: true,
        charged: false,
        recording: null,
        timestamps: { answeredAt: null },
      });
    }
  });

  it('paid contact: the Loan recovery flow, key 1, payment found → Paid; priced, not charged', async () => {
    const before = await LedgerEntryModel.countDocuments({ accountId: t.account._id });
    const call = await dial(paid, PAID_PHONE, { scenario: 'paid' });
    const summary = await call.ended;
    expect(summary).toMatchObject({
      status: 'completed',
      endReason: 'hangup_node',
      disposition: 'paid',
    });
    const doc = await CallModel.findById(call.callId).lean();
    expect(doc?.charged).toBe(false);
    expect(doc?.recording).toBeNull();
    expect(doc?.durationSec).toBeGreaterThan(10); // virtual time
    const card = await effectiveRateCard(t.account._id);
    expect(doc?.cost.totalMicros).toBe(
      callCharge(card, {
        answered: true,
        durationSec: doc?.durationSec ?? 0,
        aiSeconds: Math.round(doc?.metrics.aiSeconds ?? 0),
        ttsChars: doc?.metrics.ttsChars ?? 0,
        telephony: true,
      }).totalMicros,
    );
    expect(doc?.cost.telephonyMicros).toBeGreaterThan(0);
    const lines = await texts(call.callId);
    expect(lines[0]).toMatch(/^bot: Namaste Snapshot Name/); // the snapshot wins
    expect(lines).toContain('customer: [1]');
    expect(lines).toContain(`bot: ${LOAN_TEXTS.paid}`);
    expect(await LedgerEntryModel.countDocuments({ accountId: t.account._id })).toBe(before);
  });

  it('unpaid contact: AI step, "kal tak de dunga" → promise for tomorrow (no AI charges)', async () => {
    const before = await LedgerEntryModel.countDocuments({ accountId: t.account._id });
    const call = await dial(unpaid, UNPAID_PHONE, { scenario: 'promise' });
    const summary = await call.ended;
    expect(summary.disposition).toBe('promise_to_pay');
    expect(summary.outcome).toMatchObject({ promiseToPay: { date: tomorrow() } });
    expect(await texts(call.callId)).toContain(`customer: ${PHRASES.promise}`);
    expect(await LedgerEntryModel.countDocuments({ accountId: t.account._id })).toBe(before);
  });

  it('callback request: key 3 → AI → "kal shaam 5 baje call karna" → callback tomorrow 17:00', async () => {
    const call = await dial(unpaid, UNPAID_PHONE, { scenario: 'callback' });
    const summary = await call.ended;
    expect(summary.disposition).toBe('callback_requested');
    expect(summary.outcome).toMatchObject({ callback: { date: tomorrow(), time: '17:00' } });
  });

  it('silence, wrong keys, wrong number and an early hang-up', async () => {
    const silence = await (await dial(paid, PAID_PHONE, { scenario: 'silence' })).ended;
    expect(silence.disposition).toBe('callback_requested');
    const keys = await (await dial(paid, PAID_PHONE, { scenario: 'wrong_keys' })).ended;
    expect(keys.disposition).toBe('callback_requested');
    const wrong = await (await dial(unpaid, UNPAID_PHONE, { scenario: 'wrong_number' })).ended;
    expect(wrong.disposition).toBe('wrong_number');
    const early = await (await dial(paid, PAID_PHONE, { scenario: 'hangup_early' })).ended;
    expect(early).toMatchObject({
      status: 'completed',
      endReason: 'customer_hangup',
      disposition: null,
    });
  });

  it('the same seed gives the same call', async () => {
    const a = await dial(unpaid, UNPAID_PHONE, { scenario: 'promise', seed: 'same-seed' });
    const sa = await a.ended;
    const b = await dial(unpaid, UNPAID_PHONE, { scenario: 'promise', seed: 'same-seed' });
    const sb = await b.ended;
    expect(sb.disposition).toBe(sa.disposition);
    expect(await texts(b.callId)).toEqual(await texts(a.callId));
  });

  it('refusals: sip line, no slot, a virtual wallet that is empty, a dialed attempt; slots come back', async () => {
    const accountId = t.account._id.toString();
    await expect(dial(paid, PAID_PHONE, { provider: 'sip' })).rejects.toMatchObject({
      code: 'CAMPAIGN_NOT_RUNNABLE',
    });
    await expect(dial(paid, PAID_PHONE, { groupLimit: 0 })).rejects.toMatchObject({
      code: 'CALL_LIMIT_REACHED',
    });
    const poor = dial(paid, PAID_PHONE, {
      dryRun: {
        seed: 'poor',
        mix: MIX('answered'),
        scenarios: ONLY('paid'),
        templateKey: 'loan_recovery',
        speed: 100,
        gate: () => Promise.resolve(false),
      },
    });
    await expect(poor).rejects.toMatchObject({ code: 'WALLET_INSUFFICIENT_BALANCE' });
    const campaign = {
      campaignId: new Types.ObjectId().toString(),
      campaignContactId: new Types.ObjectId().toString(),
      attempt: 1,
    };
    const first = await dial(paid, PAID_PHONE, { campaign, outcome: 'busy' });
    await first.ended;
    await expect(dial(paid, PAID_PHONE, { campaign, outcome: 'busy' })).rejects.toMatchObject({
      code: 'CONFLICT_INVALID_STATE',
    });
    expect(await manager.slots.count(accountId)).toBe(0);
  });

  it('a program that cannot be built ends the call as an engine error', async () => {
    const call = await dial(paid, PAID_PHONE, {
      source: { kind: 'flow', flowId: new Types.ObjectId(), flowVersionRef: 1 },
    });
    expect(await call.ended).toMatchObject({ status: 'failed', endReason: 'engine_error' });
  });

  it('single calls: the web group, no campaign; logs carry no phones, names or phrases', async () => {
    const call = await dial(paid, PAID_PHONE, {
      campaign: undefined,
      groupLimit: undefined,
      outcome: 'busy',
    });
    await call.ended;
    expect(await CallModel.findById(call.callId).lean()).toMatchObject({
      campaignId: null,
      campaignContactId: null,
      attempt: null,
    });
    const log = logLines.join('');
    for (const secret of [
      PAID_PHONE,
      UNPAID_PHONE,
      'Asha',
      'Ravi',
      'Snapshot Name',
      PHRASES.promise,
      PHRASES.callback,
    ]) {
      expect(log).not.toContain(secret);
    }
  });
});

describe('dry-run programs and virtual billing', () => {
  it('the fake voice runs dry runs even when the env asks for OpenAI', () => {
    const env = loadEnv({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'k', VOICE_PROVIDER: 'openai' });
    expect(createDryRunPrograms({ env, storage }).voiceName).toBe('fake');
  });

  it('prices like a phone call, never holds; the gate decides start and extensions', async () => {
    const card = await effectiveRateCard(t.account._id);
    const gate: boolean[] = [true, false];
    const billing = new VirtualCallBilling(t.account._id.toString(), () =>
      Promise.resolve(gate.shift() ?? false),
    );
    expect(billing.holdId).toBeNull();
    expect(await billing.canStart()).toBe(true);
    expect(billing.needsExtension(100)).toBe(false);
    expect(billing.needsExtension(130)).toBe(true);
    expect(await billing.extend()).toBe(false);
    const usage = { answered: true, durationSec: 95, aiSeconds: 40, ttsChars: 300 };
    const settled = await billing.settle(usage);
    expect(settled.ledgerEntryId).toBeNull();
    expect(settled.cost.totalMicros).toBe(
      callCharge(card, { ...usage, telephony: true }).totalMicros,
    );
    await expect(billing.release()).resolves.toBeUndefined();
    const always = new VirtualCallBilling(t.account._id.toString(), () => Promise.resolve(true));
    expect(await always.extend()).toBe(true);
    expect(always.needsExtension(130)).toBe(false); // covered 2 more minutes
    await expect(
      new VirtualCallBilling('nope', () => Promise.resolve(true)).canStart(),
    ).rejects.toThrow('Invalid id');
    expect(defaultDryRun().speed).toBe(10);
  });
});
