/**
 * DEV ONLY — one dry-run campaign end to end on the dev database / Redis
 * (`npm run dev:campaign [-- --contacts 30 --speed 20]`): finds an account
 * with money and a published flow that allows campaigns, makes sure a list of
 * N demo contacts exists, starts a dry-run campaign through the campaign
 * service (no HTTP yet) and runs the dispatcher in this process until the
 * campaign stops, then prints the counts. The flow's payment check calls
 * APP_URL/api/v1/mock, so the mock API is served on that port while it runs
 * (a running dev server answers it otherwise). Refuses production. Prints ids
 * and numbers only — never phones, names or texts.
 */
import { createServer } from 'node:http';

import type { Request } from 'express';
import type { Types } from 'mongoose';

import { createApp } from '../src/app';
import { loadEnv } from '../src/config/env';
import { closeAllRedis, getAppRedis } from '../src/core/queues/redis';
import { createStorage } from '../src/core/storage';
import { createVoiceProviders } from '../src/core/voice/providers';
import { TtsCache } from '../src/core/voice/tts-cache';
import { CampaignContactModel } from '../src/db/models/campaign-contact.model';
import { CampaignModel, type CampaignDoc } from '../src/db/models/campaign.model';
import { ContactListModel } from '../src/db/models/contact-list.model';
import { ContactModel } from '../src/db/models/contact.model';
import { FlowModel } from '../src/db/models/flow.model';
import { UserModel } from '../src/db/models/user.model';
import { WalletModel } from '../src/db/models/wallet.model';
import { connectMongo, disconnectMongo } from '../src/db/mongo';
import { CallManager } from '../src/modules/calls/call.service';
import { createDryRunPrograms } from '../src/modules/calls/dry-run';
import { CallRegistry } from '../src/modules/calls/registry';
import {
  createCampaign,
  loadFlowVersion,
  startCampaign,
} from '../src/modules/campaigns/campaigns.service';
import { CampaignDispatcher } from '../src/modules/campaigns/dispatcher';
import { wireCampaigns } from '../src/modules/campaigns/jobs';
import { DialRate } from '../src/modules/campaigns/slots';
import { createLogger } from '../src/shared/logger';

const env = loadEnv();
if (env.NODE_ENV === 'production') {
  console.error('dev:campaign refuses to run in production');
  process.exit(1);
}
const arg = (name: string, fallback: number) => {
  const at = process.argv.indexOf(`--${name}`);
  const value = at >= 0 ? Number(process.argv[at + 1]) : fallback;
  return Number.isInteger(value) && value > 0 ? value : fallback;
};
const contacts = Math.min(arg('contacts', 30), 1_000);
const speed = Math.min(arg('speed', 20), env.DRY_RUN_MAX_SPEED);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  const logger = createLogger({ ...env, LOG_LEVEL: 'warn' });
  const step = (msg: string) => console.error(`dev:campaign — ${msg}`);
  await connectMongo(env, logger);
  const redis = getAppRedis(env.REDIS_URL, logger);

  const wallets = await WalletModel.find({ balanceMicros: { $gt: 50_000_000 } }).lean();
  let found: { accountId: Types.ObjectId; flowId: Types.ObjectId } | null = null;
  for (const w of wallets) {
    const flows = await FlowModel.find({ accountId: w.accountId, publishedVersion: { $gt: 0 } })
      .select({ _id: 1 })
      .lean<{ _id: Types.ObjectId }[]>();
    for (const f of flows) {
      const ok = await loadFlowVersion(w.accountId, f._id, null).then(
        () => true,
        () => false,
      );
      if (ok) {
        found = { accountId: w.accountId, flowId: f._id };
        break;
      }
    }
    if (found) break;
  }
  if (!found) {
    throw new Error('No account with ₹50+ and a published campaign flow — run npm run db:seed');
  }
  const { accountId, flowId } = found;
  const owner = await UserModel.findOne({ accountId, status: 'active' }).lean();
  if (!owner) throw new Error('No active user in that account');

  // the demo list: N contacts with unique dev phones (+91 90009 xxxxx)
  const list =
    (await ContactListModel.findOne({ accountId, name: 'Dev campaign' }).lean()) ??
    (await ContactListModel.create({
      accountId,
      name: 'Dev campaign',
      source: { type: 'manual' },
    }));
  for (let i = 1; i <= contacts; i += 1) {
    const phoneE164 = `+9190009${String(i).padStart(5, '0')}`;
    await ContactModel.updateOne(
      { accountId, phoneE164 },
      {
        $setOnInsert: {
          accountId,
          phoneE164,
          name: `Dev customer ${String(i)}`,
          source: { type: 'manual' },
          searchText: '',
          variables: { amount: 1_000_000_000 + i * 1_000_000, due_date: '2026-10-10' },
        },
        $addToSet: { listIds: list._id },
      },
      { upsert: true },
    );
  }
  step(`list ${list._id.toString()} with ${String(contacts)} contacts`);

  // the mock payment API on APP_URL's port (the flow's API step calls it)
  const storage = createStorage(env, logger);
  const mockApp = createApp({ env, logger, storage });
  const mock = createServer(mockApp);
  const appPort = Number(new URL(env.APP_URL).port || 80);
  await new Promise<void>((resolve) => {
    mock.once('error', () => resolve()); // a dev server already answers it
    mock.listen(appPort, resolve);
  });

  const registry = new CallRegistry(redis);
  const calls = new CallManager({
    logger,
    registry,
    tts: new TtsCache({ tts: createVoiceProviders(env).tts, storage }),
    storage,
    recordingDir: env.CALL_RECORDING_TMP_DIR,
    scriptFor: () => Promise.reject(new Error('no web calls here')),
    dryRun: createDryRunPrograms({ env, storage, redis }),
  });
  const dispatcher = new CampaignDispatcher({ calls, rate: new DialRate(redis), logger });
  const unwire = wireCampaigns({
    jobs: {
      schedule: () => Promise.resolve(),
      scheduleEnd: () => Promise.resolve(),
      drop: () => Promise.resolve(),
    },
    dispatcher,
    calls,
    logger,
  });
  const req = {
    auth: {
      kind: 'user',
      accountId: accountId.toString(),
      userId: owner._id.toString(),
      permissions: new Set<string>(),
      account: {
        id: accountId.toString(),
        status: 'active',
        timezone: 'Asia/Kolkata',
        isPlatform: false,
      },
    },
    ip: '127.0.0.1',
  } as unknown as Request;
  const all = { start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] };
  const created = await createCampaign(req, {
    name: `Dev dry run ${new Date().toISOString().slice(0, 19)}`,
    mode: 'dry_run',
    flowId: flowId.toString(),
    audience: { listIds: [list._id.toString()], excludeActiveCampaigns: false },
    window: all,
    retry: { maxAttempts: 2, intervalMinutes: 15, retryOn: ['no_answer', 'busy'] },
    pacing: { concurrency: 5 },
    dryRun: { speed },
  } as never);
  step(`campaign ${created.id} (×${String(speed)})`);
  await startCampaign(req, created.id).catch((err: unknown) => {
    // the account window may be narrower than "all day": the campaign waits then
    console.error('dev:campaign — start refused:', (err as Error).message);
    throw err;
  });
  const started = Date.now();
  let doc: CampaignDoc | null = null;
  for (;;) {
    await dispatcher.tick(accountId.toString());
    doc = await CampaignModel.findById(created.id).lean<CampaignDoc>();
    if (!doc || !['running', 'scheduled'].includes(doc.status)) break;
    // only retries / callbacks due later in real time (min gap, callback times) left
    const soon = new Date(Date.now() + 2 * 60_000);
    const live = await CampaignContactModel.countDocuments({
      campaignId: doc._id,
      status: { $in: ['queued', 'calling'] },
    });
    const dueSoon = await CampaignContactModel.countDocuments({
      campaignId: doc._id,
      status: { $in: ['pending', 'retry_wait', 'callback_wait'] },
      $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: soon } }],
    });
    if (doc.snapshot.done && live === 0 && dueSoon === 0) {
      const next = await CampaignContactModel.findOne({
        campaignId: doc._id,
        status: { $in: ['pending', 'retry_wait', 'callback_wait'] },
      })
        .sort({ nextAttemptAt: 1 })
        .select({ nextAttemptAt: 1 })
        .lean<{ nextAttemptAt: Date | null }>();
      step(
        `nothing due in the next 2 min — the rest waits (next at ${next?.nextAttemptAt?.toISOString() ?? '—'}); the campaign stays running`,
      );
      break;
    }
    if (Date.now() - started > 15 * 60_000) {
      step('still running after 15 min — stopping the script (the campaign stays running)');
      break;
    }
    await sleep(500);
  }
  const s = doc?.stats;
  console.log(
    JSON.stringify(
      {
        campaignId: created.id,
        status: doc?.status,
        pauseReason: doc?.pauseReason ?? null,
        waitingUntil: doc?.waitingUntil ?? null,
        seconds: Math.round((Date.now() - started) / 1000),
        total: s?.total,
        completed: s?.completed,
        failed: s?.failed,
        skipped: s?.skipped,
        answered: s?.answered,
        attempts: s?.attempts,
        waiting: s?.waiting,
        retried: s ? s.attempts - (s.completed + s.failed) : null,
        dispositions: Object.fromEntries(
          Object.entries(s?.dispositions ?? {}).filter(([, n]) => n > 0),
        ),
        virtualCostMicros: s?.virtualCostMicros,
      },
      null,
      2,
    ),
  );
  await dispatcher.stop();
  unwire();
  await calls.shutdown();
  await new Promise((r) => mock.close(() => r(null)));
  await closeAllRedis();
  await disconnectMongo();
};

main().catch(async (err: unknown) => {
  console.error('dev:campaign failed:', err instanceof Error ? err.message : err);
  await closeAllRedis().catch(() => undefined);
  await disconnectMongo().catch(() => undefined);
  process.exit(1);
});
