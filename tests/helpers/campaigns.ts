import type { Express, Request } from 'express';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { expect } from 'vitest';

import { loadEnv } from '../../src/config/env';
import type { StorageProvider } from '../../src/core/storage';
import { FakeClock } from '../../src/core/voice/clock';
import { FakeTts } from '../../src/core/voice/providers';
import { TtsCache } from '../../src/core/voice/tts-cache';
import { AccountModel } from '../../src/db/models/account.model';
import { AiAgentModel } from '../../src/db/models/ai-agent.model';
import { CampaignModel, type CampaignDoc } from '../../src/db/models/campaign.model';
import { ContactListModel } from '../../src/db/models/contact-list.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { CustomFieldModel } from '../../src/db/models/custom-field.model';
import { CallManager } from '../../src/modules/calls/call.service';
import { createDryRunPrograms } from '../../src/modules/calls/dry-run';
import { CallRegistry } from '../../src/modules/calls/registry';
import { createCampaign } from '../../src/modules/campaigns/campaigns.service';
import { CampaignDispatcher } from '../../src/modules/campaigns/dispatcher';
import { DialRate } from '../../src/modules/campaigns/slots';
import type { Logger } from '../../src/shared/logger';

import { createTestAccount, type TestAccount, type TestUser } from './auth';
import { fund } from './calls';
import { FLOWS, auth } from './flows';

export const ALL_DAY = { start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] };

export interface CampaignWorldDeps {
  app: Express;
  /** Port of the running app (the flow's payment check calls its mock API). */
  port: number;
  redis: Redis;
  prefix: string;
  storage: StorageProvider;
  recordingDir: string;
  logger: Logger;
  /** Phone prefix of this test file (`+91` + 5 digits) — numbers stay unique per DB. */
  phonePrefix: string;
}

export interface CampaignWorld {
  t: TestAccount;
  owner: TestUser;
  req: Request;
  flowId: string;
  agentId: string;
  clock: FakeClock;
  calls: CallManager;
  dispatcher: CampaignDispatcher;
  accountId: string;
  /** Another dispatcher + call manager on the same Redis / Mongo ("a second process"). */
  process(clock?: FakeClock): { calls: CallManager; dispatcher: CampaignDispatcher };
  listOf(n: number, over?: Record<string, unknown>): Promise<string>;
  campaign(over?: Record<string, unknown>): Promise<string>;
  docOf(id: string): Promise<CampaignDoc>;
  /** Ticks (and lets real dry-run calls run) until `done`, at most `rounds` rounds. */
  drive(
    done: () => Promise<boolean>,
    opts?: { rounds?: number; each?: () => Promise<void>; stepMs?: number },
  ): Promise<boolean>;
  shutdown(): Promise<void>;
}

/**
 * A FakeClock whose timers never fire: the dispatcher's own (wake / loop)
 * ticks don't run, only the test's explicit `tick()`s — so a test can move
 * time between ticks without a tick being half way through.
 */
export class ManualTickClock extends FakeClock {
  override setTimeout(): number {
    return 0;
  }
}

let phoneN = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One account with a published Loan recovery flow (payment check against the
 * app's mock API), its own CallManager and a dispatcher on a FakeClock that
 * starts at `clockStart` (default: now) — results use that clock.
 */
export const campaignWorld = async (
  deps: CampaignWorldDeps,
  opts: {
    walletMicros?: number;
    clockStart?: number;
    maxConcurrentCalls?: number;
    /** Only explicit ticks run (see ManualTickClock). */
    manualTicks?: boolean;
  } = {},
): Promise<CampaignWorld> => {
  const t = await createTestAccount();
  const owner = await t.addUser('owner');
  const accountId = t.account._id.toString();
  const req = {
    auth: {
      kind: 'user',
      accountId,
      userId: owner.user._id.toString(),
      roleKey: 'owner',
      permissions: new Set<string>(),
      account: { id: accountId, status: 'active', timezone: 'Asia/Kolkata', isPlatform: false },
    },
    ip: '127.0.0.1',
  } as unknown as Request;
  const wallet = opts.walletMicros ?? 5_000_000_000;
  if (wallet > 0) await fund(t.account._id, wallet);
  await AccountModel.updateOne(
    { _id: t.account._id },
    {
      'settings.callingWindow': ALL_DAY,
      'settings.callCaps': { perDay: 10, perWeek: 50, minGapMinutes: 0 },
      ...(opts.maxConcurrentCalls ? { 'limits.maxConcurrentCalls': opts.maxConcurrentCalls } : {}),
    },
  );
  await CustomFieldModel.create({
    accountId: t.account._id,
    key: 'amount',
    label: 'Amount',
    type: 'currency',
  });
  const agent = await request(deps.app)
    .post('/api/v1/agents')
    .set(auth(owner))
    .send({ name: 'Recovery', templateKey: 'loan_recovery_hinglish' });
  const agentId = agent.body.data.id as string;
  const mockUrl = `http://127.0.0.1:${String(deps.port)}/api/v1/mock/payment-status?phone={{contact.phone}}`;
  await AiAgentModel.updateOne({ _id: agentId }, { $set: { 'functions.0.url': mockUrl } });
  const created = await request(deps.app)
    .post(FLOWS)
    .set(auth(owner))
    .send({ name: 'Loan recovery', templateKey: 'loan_recovery', agentIds: { ai: agentId } });
  const flowId = created.body.data.id as string;
  const draft = created.body.data.draft;
  draft.nodes.find((node: { id: string }) => node.id === 'check').config.url = mockUrl;
  await request(deps.app)
    .put(`${FLOWS}/${flowId}/draft`)
    .set(auth(owner))
    .send({ revision: 1, graph: draft });
  const published = await request(deps.app)
    .post(`${FLOWS}/${flowId}/publish`)
    .set(auth(owner))
    .send({ revision: 2 });
  expect(published.status, JSON.stringify(published.body)).toBe(201);

  const env = loadEnv({
    MOCK_APIS_ENABLED: 'true',
    APP_URL: `http://127.0.0.1:${String(deps.port)}`,
    VOICE_PROVIDER: 'fake',
  });
  const managers: CallManager[] = [];
  const newProcess = (clock: FakeClock) => {
    const calls = new CallManager({
      logger: deps.logger,
      registry: new CallRegistry(deps.redis, deps.prefix),
      tts: new TtsCache({ tts: new FakeTts(), storage: deps.storage }),
      storage: deps.storage,
      recordingDir: deps.recordingDir,
      scriptFor: () => Promise.reject(new Error('no web calls here')),
      dryRun: createDryRunPrograms({ env, storage: deps.storage, redis: deps.redis }),
    });
    managers.push(calls);
    const dispatcher = new CampaignDispatcher({
      calls,
      rate: new DialRate(deps.redis, `${deps.prefix}${accountId}:`),
      logger: deps.logger,
      clock,
    });
    return { calls, dispatcher };
  };
  const start = opts.clockStart ?? Date.now();
  const clock = opts.manualTicks ? new ManualTickClock(start) : new FakeClock(start);
  const main = newProcess(clock);
  let n = 0;
  const docOf = async (id: string) =>
    (await CampaignModel.findById(id).lean<CampaignDoc>()) as CampaignDoc;
  return {
    t,
    owner,
    req,
    flowId,
    agentId,
    clock,
    accountId,
    ...main,
    process: (c = clock) => newProcess(c),
    async listOf(count, over = {}) {
      const list = await ContactListModel.create({
        accountId: t.account._id,
        name: `L${String(Date.now())}${String(Math.random())}`,
        source: { type: 'manual' },
      });
      for (let i = 0; i < count; i += 1) {
        phoneN += 1;
        await ContactModel.create({
          accountId: t.account._id,
          phoneE164: `+91${deps.phonePrefix}${String(phoneN).padStart(5, '0')}`,
          name: `Hard ${String(phoneN)}`,
          source: { type: 'manual' },
          listIds: [list._id],
          variables: { amount: 1_000_000_000 },
          ...over,
        });
      }
      return list._id.toString();
    },
    async campaign(over = {}) {
      n += 1;
      const c = await createCampaign(req, {
        name: `Hardening ${String(n)}`,
        mode: 'dry_run',
        flowId,
        window: ALL_DAY,
        audience: { listIds: [], excludeActiveCampaigns: false },
        ...over,
      } as never);
      return c.id;
    },
    docOf,
    async drive(done, { rounds = 600, each, stepMs = 0 } = {}) {
      for (let i = 0; i < rounds; i += 1) {
        if (await done()) return true;
        // the fake clock never runs behind real time (snapshots use real dates)
        const lag = Date.now() - clock.now();
        clock.advance(Math.max(lag, 0) + stepMs);
        await main.dispatcher.tick(accountId);
        await each?.();
        await sleep(25);
      }
      return done();
    },
    async shutdown() {
      await main.dispatcher.stop();
      for (const m of managers) await m.shutdown();
    },
  };
};
