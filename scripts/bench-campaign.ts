/**
 * DEV ONLY — Phase 8 campaign dispatcher load check (PHASE_8_PROMPT T8.8 §5).
 *   npm run bench:campaign                    (1,000 contacts × ×50 × 20 at once)
 *   npm run bench:campaign -- 300 20 10
 * One dry-run campaign on a throw-away `bench-campaign-*` account, in this
 * process: real CallManager sessions on the dry-run line (fake voice, fake AI),
 * the real dispatcher on the system clock, retries 3 × 15 min (÷ speed), customer
 * callbacks off (they are at real times, so the run would wait until then).
 * Reports dispatcher tick p50 / p95, dials / s, event-loop lag p99 / max, Mongo
 * operations per call, RSS start / peak / end and the completion time. Deletes
 * everything it made at the end (audit entries stay — they are immutable). Needs
 * `npm run infra:up`. Refuses production.
 * No phones, names or texts are printed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import mongoose, { type Types } from 'mongoose';

import { createApp } from '../src/app';
import { getEnv } from '../src/config/env';
import { CALL_LIMITS } from '../src/config/limits';
import { credit } from '../src/core/billing/engine';
import { createWallet } from '../src/core/billing/wallets';
import { closeAllRedis, getAppRedis } from '../src/core/queues/redis';
import { createStorage } from '../src/core/storage';
import { FakeTts } from '../src/core/voice/providers';
import { TtsCache } from '../src/core/voice/tts-cache';
import { AccountModel } from '../src/db/models/account.model';
import { AiAgentModel } from '../src/db/models/ai-agent.model';
import { CallEventModel } from '../src/db/models/call-event.model';
import { CallModel } from '../src/db/models/call.model';
import { CampaignContactModel } from '../src/db/models/campaign-contact.model';
import { CampaignModel, type CampaignDoc } from '../src/db/models/campaign.model';
import { ContactListModel } from '../src/db/models/contact-list.model';
import { ContactModel } from '../src/db/models/contact.model';
import { CustomFieldModel } from '../src/db/models/custom-field.model';
import { FlowRunModel } from '../src/db/models/flow-run.model';
import { FlowVersionModel } from '../src/db/models/flow-version.model';
import { FlowModel } from '../src/db/models/flow.model';
import { LedgerEntryModel } from '../src/db/models/ledger-entry.model';
import { NotificationModel } from '../src/db/models/notification.model';
import { RoleModel } from '../src/db/models/role.model';
import { TranscriptTurnModel } from '../src/db/models/transcript-turn.model';
import { UserModel } from '../src/db/models/user.model';
import { WalletModel } from '../src/db/models/wallet.model';
import { connectMongo, disconnectMongo } from '../src/db/mongo';
import { signAccessToken } from '../src/modules/auth/tokens';
import { CallManager } from '../src/modules/calls/call.service';
import { createDryRunPrograms } from '../src/modules/calls/dry-run';
import { CallRegistry } from '../src/modules/calls/registry';
import { createCampaign, startCampaign } from '../src/modules/campaigns/campaigns.service';
import { CampaignDispatcher } from '../src/modules/campaigns/dispatcher';
import { wireCampaigns } from '../src/modules/campaigns/jobs';
import { DialRate } from '../src/modules/campaigns/slots';
import { syncSystemRoles } from '../src/modules/rbac/roles.service';
import { createLogger } from '../src/shared/logger';

const BENCH_PREFIX = 'bench-campaign-';
const RUPEE = 1_000_000;
const ALL_DAY = { start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] };

const pct = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
};
const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

const main = async (): Promise<void> => {
  const env = getEnv();
  if (env.NODE_ENV === 'production') throw new Error('bench:campaign is disabled in production');
  const contacts = Number(process.argv[2] ?? 1_000);
  const speed = Number(process.argv[3] ?? 50);
  const concurrency = Number(process.argv[4] ?? 20);
  if (
    !Number.isSafeInteger(contacts) ||
    contacts < 10 ||
    contacts > 10_000 ||
    !Number.isSafeInteger(speed) ||
    speed < 1 ||
    speed > env.DRY_RUN_MAX_SPEED ||
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > CALL_LIMITS.concurrentPerProcess
  ) {
    throw new Error(
      `Usage: npm run bench:campaign -- [contacts 10–10000] [speed ≤ ${String(env.DRY_RUN_MAX_SPEED)}] [concurrency ≤ ${String(CALL_LIMITS.concurrentPerProcess)}]`,
    );
  }
  const logger = createLogger({ ...env, LOG_LEVEL: 'warn' });
  await connectMongo(env, logger);
  const redis = getAppRedis(env.REDIS_URL, logger);
  const storage = createStorage(env, logger);
  const recordingDir = mkdtempSync(path.join(tmpdir(), 'cav-bench-campaign-'));
  const stamp = Date.now().toString(36);
  const prefix = `benchcampaign:${stamp}:`;
  let accountId: Types.ObjectId | null = null;
  const server = createServer();
  let unwire = () => undefined as void;
  let dispatcher: CampaignDispatcher | null = null;
  let manager: CallManager | null = null;
  try {
    // ── account, wallet, flow (through the API, so the graph is the real template) ──
    const account = await AccountModel.create({
      name: 'Campaign bench',
      slug: `${BENCH_PREFIX}${stamp}`,
      settings: {
        callingWindow: ALL_DAY,
        callCaps: { perDay: 10, perWeek: 50, minGapMinutes: 0 },
      },
      limits: { maxConcurrentCalls: concurrency, dialsPerMinute: 600 },
    });
    accountId = account._id;
    const roles = await syncSystemRoles(account._id);
    const user = await UserModel.create({
      accountId: account._id,
      roleId: roles.owner,
      name: 'Bench',
      email: `${BENCH_PREFIX}${stamp}@example.com`,
      passwordHash: 'x',
      status: 'active',
      emailVerifiedAt: new Date(),
    });
    await AccountModel.updateOne({ _id: account._id }, { ownerId: user._id });
    await createWallet(account._id);
    await credit({
      accountId: account._id,
      type: 'adjustment',
      amountMicros: 100_000 * RUPEE,
      ref: { type: 'manual', id: 'bench' },
      idempotencyKey: `bench-campaign:${stamp}`,
      note: 'Bench opening credit (virtual money of the dry run)',
    });
    await CustomFieldModel.create({
      accountId: account._id,
      key: 'amount',
      label: 'Amount',
      type: 'currency',
    });

    const registry = new CallRegistry(redis, prefix);
    manager = new CallManager({
      logger,
      registry,
      tts: new TtsCache({ tts: new FakeTts(), storage }),
      storage,
      recordingDir,
      scriptFor: () => Promise.reject(new Error('no web calls here')),
      dryRun: createDryRunPrograms({ env, storage, redis }),
    });
    server.on('request', createApp({ env, logger, storage }));
    // on APP_URL's port when free: the flow's payment check calls APP_URL/api/v1/mock
    // (a running dev server answers it otherwise)
    const appPort = Number(new URL(env.APP_URL).port || 80);
    await new Promise<void>((resolve) => {
      server.once('error', () => server.listen(0, resolve));
      server.listen(appPort, resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const { token } = await signAccessToken(
      {
        sub: user._id.toString(),
        acc: account._id.toString(),
        rid: roles.owner.toString(),
        tv: user.tokenVersion,
        sid: `bench_${stamp}`,
      },
      '30m',
    );
    const api = async (method: string, url: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${String(port)}/api/v1${url}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const json = (await res.json()) as { data?: Record<string, unknown>; error?: unknown };
      if (!res.ok) throw new Error(`${method} ${url} → ${String(res.status)}`);
      return json.data as Record<string, unknown>;
    };
    const mockUrl = `${env.APP_URL.replace(/\/+$/, '')}/api/v1/mock/payment-status?phone={{contact.phone}}`;
    const agent = await api('POST', '/agents', {
      name: 'Recovery',
      templateKey: 'loan_recovery_hinglish',
    });
    await AiAgentModel.updateOne(
      { _id: String(agent.id) },
      { $set: { 'functions.0.url': mockUrl } },
    );
    const flow = await api('POST', '/flows', {
      name: 'Loan recovery',
      templateKey: 'loan_recovery',
      agentIds: { ai: agent.id },
    });
    const draft = flow.draft as { nodes: { id: string; config: Record<string, unknown> }[] };
    const check = draft.nodes.find((n) => n.id === 'check');
    if (check) check.config.url = mockUrl;
    await api('PUT', `/flows/${String(flow.id)}/draft`, { revision: 1, graph: draft });
    await api('POST', `/flows/${String(flow.id)}/publish`, { revision: 2 });

    // ── contacts ──
    const list = await ContactListModel.create({
      accountId: account._id,
      name: 'Bench list',
      source: { type: 'manual' },
    });
    const rows = Array.from({ length: contacts }, (_, i) => ({
      accountId: account._id,
      phoneE164: `+91900${String(9_000_000 + i).padStart(7, '0')}`,
      name: `Bench ${String(i)}`,
      source: { type: 'manual' as const },
      searchText: '',
      listIds: [list._id],
      variables: { amount: (1_000 + (i % 19_000)) * RUPEE },
    }));
    for (let i = 0; i < rows.length; i += 1_000) {
      await ContactModel.insertMany(rows.slice(i, i + 1_000));
    }

    // ── dispatcher + measurements ──
    dispatcher = new CampaignDispatcher({
      calls: manager,
      rate: new DialRate(redis, `${prefix}${account._id.toString()}:`),
      logger,
    });
    unwire = wireCampaigns({
      jobs: {
        schedule: () => Promise.resolve(),
        scheduleEnd: () => Promise.resolve(),
        drop: () => Promise.resolve(),
      },
      dispatcher,
      calls: manager,
      logger,
    });
    const tickMs: number[] = [];
    const tick = dispatcher.tick.bind(dispatcher);
    dispatcher.tick = async (id: string) => {
      const t0 = performance.now();
      await tick(id);
      tickMs.push(performance.now() - t0);
    };
    let mongoOps = 0;
    mongoose.set('debug', () => {
      mongoOps += 1;
    });
    const lag = monitorEventLoopDelay({ resolution: 10 });
    const rssStart = process.memoryUsage().rss;
    let rssPeak = rssStart;
    const sampler = setInterval(() => {
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    }, 500);

    const req = {
      auth: {
        kind: 'user',
        accountId: account._id.toString(),
        userId: user._id.toString(),
        roleKey: 'owner',
        permissions: new Set<string>(),
        account: {
          id: account._id.toString(),
          status: 'active',
          timezone: 'Asia/Kolkata',
          isPlatform: false,
        },
      },
      ip: '127.0.0.1',
    } as never;
    const created = await createCampaign(req, {
      name: `Bench ${stamp}`,
      mode: 'dry_run',
      flowId: String(flow.id),
      audience: { listIds: [list._id.toString()], excludeActiveCampaigns: false },
      window: ALL_DAY,
      retry: { maxAttempts: 3, intervalMinutes: 15, retryOn: ['no_answer', 'busy', 'failed'] },
      pacing: { concurrency, dialsPerMinute: 120 },
      // customer callbacks are at real times (tomorrow 17:00 …) — off, so the run ends
      followUps: { callbacks: false, promiseCheck: { enabled: false, daysAfter: 1 } },
      dryRun: { speed },
    } as never);
    console.info(
      `Campaign benchmark — ${String(contacts)} contacts × ×${String(speed)} × ${String(concurrency)} at once (dry run, one process)`,
    );
    lag.enable();
    const started = Date.now();
    await startCampaign(req, created.id);
    let doc: CampaignDoc | null = null;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1_000));
      doc = await CampaignModel.findById(created.id).lean<CampaignDoc>();
      if (!doc || doc.status !== 'running') break;
      const elapsed = Math.round((Date.now() - started) / 1_000);
      if (elapsed % 10 === 0) {
        const s = doc.stats;
        console.info(
          `  ${String(elapsed)} s — pending ${String(s.pending)}, calling ${String(s.calling)}, waiting ${String(s.waiting)}, done ${String(s.completed + s.failed + s.skipped)}, calls ${String(s.attempts)}`,
        );
      }
      if (Date.now() - started > 30 * 60_000) throw new Error('not done after 30 min');
    }
    const seconds = (Date.now() - started) / 1_000;
    lag.disable();
    clearInterval(sampler);
    mongoose.set('debug', false);
    const calls = await CallModel.countDocuments({ campaignId: created.id });
    const result = {
      status: doc?.status,
      seconds: Math.round(seconds),
      calls,
      dialsPerSecond: Number((calls / seconds).toFixed(1)),
      completed: doc?.stats.completed,
      failed: doc?.stats.failed,
      skipped: doc?.stats.skipped,
      tickMs: {
        count: tickMs.length,
        p50: Number(pct(tickMs, 50).toFixed(1)),
        p95: Number(pct(tickMs, 95).toFixed(1)),
      },
      eventLoopLagMs: {
        p99: Number((lag.percentile(99) / 1e6).toFixed(1)),
        max: Number((lag.max / 1e6).toFixed(1)),
      },
      mongoOpsPerCall: Number((mongoOps / Math.max(calls, 1)).toFixed(1)),
      rssMb: { start: mb(rssStart), peak: mb(rssPeak), end: mb(process.memoryUsage().rss) },
    };
    console.info(JSON.stringify(result, null, 2));
  } finally {
    await dispatcher?.stop();
    unwire();
    await manager?.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (accountId) {
      const account = await AccountModel.findById(accountId).lean();
      if (account?.slug.startsWith(BENCH_PREFIX)) {
        const scoped = { accountId };
        await CampaignContactModel.deleteMany(scoped);
        await CampaignModel.collection.deleteMany(scoped);
        await CallEventModel.deleteMany(scoped);
        await TranscriptTurnModel.deleteMany(scoped);
        await CallModel.deleteMany(scoped);
        await FlowRunModel.deleteMany(scoped);
        await FlowVersionModel.deleteMany(scoped);
        await FlowModel.collection.deleteMany(scoped);
        await AiAgentModel.collection.deleteMany(scoped);
        await ContactModel.collection.deleteMany(scoped);
        await ContactListModel.collection.deleteMany(scoped);
        await CustomFieldModel.deleteMany(scoped);
        await NotificationModel.deleteMany(scoped);
        await LedgerEntryModel.deleteMany(scoped).setOptions({ allowLedgerDelete: true });
        await WalletModel.deleteOne(scoped);
        await UserModel.deleteMany(scoped);
        await RoleModel.deleteMany(scoped);
        await AccountModel.deleteOne({ _id: accountId });
      } else {
        console.error('refusing to delete a non-bench account');
      }
    }
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    rmSync(recordingDir, { recursive: true, force: true });
    await disconnectMongo();
    await closeAllRedis();
  }
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
