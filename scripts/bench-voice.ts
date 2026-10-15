/**
 * DEV ONLY — Phase 7 voice runtime load check (PHASE_7_PLAN §1i).
 *   npm run bench:voice                (default 20 calls × 120 s)
 *   npm run bench:voice -- 10 60
 * Runs N concurrent web calls on one process in real time: real sessions,
 * pacing, recording, wallet extension and settle; fake TTS speaking lines in a
 * loop; a fake browser leg per call sending 20 ms customer frames. Reports CPU
 * per call, event-loop lag p99, late pacer ticks %, stalled frames and RSS per
 * call. Each call gets a throw-away `bench-voice-*` account (the per-account
 * limit is 3); everything it made is deleted at the end. Needs
 * `npm run infra:up`. Refuses NODE_ENV=production.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import type { Types } from 'mongoose';

import { getEnv } from '../src/config/env';
import { CALL_LIMITS } from '../src/config/limits';
import { credit } from '../src/core/billing/engine';
import { createWallet } from '../src/core/billing/wallets';
import { closeAllRedis, getAppRedis } from '../src/core/queues/redis';
import { createStorage } from '../src/core/storage';
import { WebCallLeg } from '../src/core/telephony/webcall';
import { systemClock } from '../src/core/voice/clock';
import { FakeTts } from '../src/core/voice/providers';
import { TtsCache } from '../src/core/voice/tts-cache';
import { AccountModel } from '../src/db/models/account.model';
import { CallEventModel } from '../src/db/models/call-event.model';
import { CallModel } from '../src/db/models/call.model';
import { LedgerEntryModel } from '../src/db/models/ledger-entry.model';
import { NotificationModel } from '../src/db/models/notification.model';
import { RoleModel } from '../src/db/models/role.model';
import { TranscriptTurnModel } from '../src/db/models/transcript-turn.model';
import { UserModel } from '../src/db/models/user.model';
import { WalletModel } from '../src/db/models/wallet.model';
import { connectMongo, disconnectMongo } from '../src/db/mongo';
import { CallManager } from '../src/modules/calls/call.service';
import { CallRegistry } from '../src/modules/calls/registry';
import type { CallIO } from '../src/modules/calls/session';
import { syncSystemRoles } from '../src/modules/rbac/roles.service';
import { createLogger } from '../src/shared/logger';

const BENCH_PREFIX = 'bench-voice-';
const RUPEE = 1_000_000;
const LINES = [
  'Namaste, main Demo Finance ki taraf se bol rahi hoon.',
  'Aapki EMI ki tareekh nikal chuki hai, kripya jald bhugtan karein.',
  'Payment link aapke number par bhej diya gaya hai. Dhanyavaad!',
];

const main = async (): Promise<void> => {
  const env = getEnv();
  if (env.NODE_ENV === 'production') throw new Error('bench:voice is disabled in production');
  const calls = Number(process.argv[2] ?? 20);
  const seconds = Number(process.argv[3] ?? 120);
  if (!Number.isSafeInteger(calls) || calls < 1 || calls > CALL_LIMITS.concurrentPerProcess) {
    throw new Error(
      `Usage: npm run bench:voice -- [calls ≤ ${String(CALL_LIMITS.concurrentPerProcess)}] [seconds]`,
    );
  }
  if (!Number.isSafeInteger(seconds) || seconds < 5) throw new Error('seconds must be ≥ 5');
  const logger = createLogger({ ...env, LOG_LEVEL: 'warn' });
  await connectMongo(env, logger);
  const redis = getAppRedis(env.REDIS_URL, logger);
  const storage = createStorage(env, logger);
  const recordingDir = mkdtempSync(path.join(tmpdir(), 'cav-bench-voice-'));
  const stamp = Date.now().toString(36);
  const accounts: Types.ObjectId[] = [];
  const legs: WebCallLeg[] = [];
  const callIds: string[] = [];
  try {
    const manager = new CallManager({
      logger,
      registry: new CallRegistry(redis, `benchvoice:${stamp}:`),
      tts: new TtsCache({ tts: new FakeTts(), storage }),
      storage,
      recordingDir,
      tickets: { issue: () => Promise.resolve({ ticket: 'wst_bench', expiresAt: '' }) },
      clock: systemClock,
      scriptFor: () =>
        Promise.resolve({
          voice: 'coral',
          language: 'hinglish',
          maxDurationSec: seconds + 30,
          script: {
            run: async (io: CallIO) => {
              for (let i = 0; io.elapsedMs() < seconds * 1000 && !io.ended; i += 1) {
                await io.say(LINES[i % LINES.length] ?? '');
              }
              return 'hangup_node' as const;
            },
            stop: () => Promise.resolve(),
            result: () => ({
              outcome: {},
              disposition: null,
              variables: {},
              flowRunId: null,
              aiSeconds: 0,
              languageDetected: null,
            }),
          },
        }),
    });

    console.info(
      `Voice benchmark — ${String(calls)} concurrent web calls × ${String(seconds)} s (fake TTS, real time)`,
    );
    for (let i = 0; i < calls; i += 1) {
      const account = await AccountModel.create({
        name: `Voice bench ${String(i)}`,
        slug: `${BENCH_PREFIX}${stamp}-${String(i)}`,
      });
      accounts.push(account._id);
      const roles = await syncSystemRoles(account._id);
      const user = await UserModel.create({
        accountId: account._id,
        roleId: roles.owner,
        name: 'Bench',
        email: `${BENCH_PREFIX}${stamp}-${String(i)}@example.com`,
        passwordHash: 'x',
        status: 'active',
      });
      await createWallet(account._id);
      await credit({
        accountId: account._id,
        type: 'adjustment',
        amountMicros: 2_000 * RUPEE,
        ref: { type: 'manual', id: 'bench' },
        idempotencyKey: `bench-voice:${stamp}:${String(i)}`,
        note: 'Bench opening credit',
      });
      const created = await manager.createWebCall({
        accountId: account._id.toString(),
        userId: user._id.toString(),
        source: { kind: 'agent' },
        contactId: null,
        variables: {},
      });
      callIds.push(created.callId);
      const leg = new WebCallLeg(
        {
          sendJson: () => undefined,
          sendBinary: () => undefined,
          bufferedAmount: () => 0,
          close: () => undefined,
        },
        systemClock,
      );
      legs.push(leg);
      await manager.attach(
        { callId: created.callId, accountId: account._id.toString(), userId: user._id.toString() },
        leg,
      );
    }

    const lag = monitorEventLoopDelay({ resolution: 10 });
    lag.enable();
    const rssBefore = process.memoryUsage().rss;
    const cpuBefore = process.cpuUsage();
    const started = performance.now();
    for (const leg of legs)
      leg.receiveControl({ type: 'call.ready', sampleRate: CALL_LIMITS.webSampleRate });
    const frame = new Int16Array(480).fill(3);
    const feeder = setInterval(() => {
      for (const leg of legs) leg.receiveAudio(frame);
    }, CALL_LIMITS.frameMs);
    let rssPeak = rssBefore;
    const sampler = setInterval(() => {
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    }, 1000);
    // every call ends itself after `seconds`; wait for all of them to be settled
    for (;;) {
      const open = await CallModel.countDocuments({
        _id: { $in: callIds },
        status: { $nin: ['completed', 'failed', 'canceled'] },
      });
      if (open === 0) break;
      if (performance.now() - started > (seconds + 90) * 1000) throw new Error('calls did not end');
      await new Promise((r) => setTimeout(r, 1000));
    }
    clearInterval(feeder);
    clearInterval(sampler);
    lag.disable();
    const wall = (performance.now() - started) / 1000;
    const cpu = process.cpuUsage(cpuBefore);
    const cpuPct = ((cpu.user + cpu.system) / 1e6 / wall) * 100;
    const docs = await CallModel.find({ _id: { $in: callIds } }).lean();
    const framesOut = docs.reduce((n, c) => n + c.metrics.framesOut, 0);
    const late = legs.reduce((n, l) => n + l.pacerStats.lateTicks, 0);
    const stalled = legs.reduce((n, l) => n + l.pacerStats.stalledFrames, 0);
    const result = {
      calls,
      seconds,
      completed: docs.filter((c) => c.status === 'completed').length,
      cpuPercentTotal: Number(cpuPct.toFixed(1)),
      cpuPercentPerCall: Number((cpuPct / calls).toFixed(2)),
      eventLoopLagP99Ms: Number((lag.percentile(99) / 1e6).toFixed(1)),
      eventLoopLagMaxMs: Number((lag.max / 1e6).toFixed(1)),
      framesOut,
      lateTicksPercent: framesOut ? Number(((late / framesOut) * 100).toFixed(2)) : 0,
      stalledFrames: stalled,
      rssPerCallMb: Number(((rssPeak - rssBefore) / calls / 1024 / 1024).toFixed(2)),
      recordingsSaved: docs.filter((c) => c.recording).length,
    };
    console.info(JSON.stringify(result, null, 2));
  } finally {
    for (const c of await CallModel.find({ _id: { $in: callIds } }).lean()) {
      if (c.recording) await storage.delete(c.recording.fileKey).catch(() => undefined);
    }
    for (const accountId of accounts) {
      const account = await AccountModel.findById(accountId).lean();
      if (!account?.slug.startsWith(BENCH_PREFIX)) {
        console.error('refusing to delete a non-bench account');
        continue;
      }
      await CallEventModel.deleteMany({ accountId });
      await TranscriptTurnModel.deleteMany({ accountId });
      await CallModel.deleteMany({ accountId });
      await LedgerEntryModel.deleteMany({ accountId }).setOptions({ allowLedgerDelete: true });
      await WalletModel.deleteOne({ accountId });
      await NotificationModel.deleteMany({ accountId });
      await UserModel.deleteMany({ accountId });
      await RoleModel.deleteMany({ accountId });
      await AccountModel.deleteOne({ _id: accountId });
    }
    rmSync(recordingDir, { recursive: true, force: true });
    await disconnectMongo();
    await closeAllRedis();
  }
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
