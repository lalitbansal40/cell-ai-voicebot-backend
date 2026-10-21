/**
 * DEV ONLY — demo campaigns for "Demo Finance" (Phase 8), idempotent by name:
 *   - "October recovery (dry run)": 30 contacts (list "Campaign demo"), run by
 *     the real dispatcher at ×50 on a clock that jumps over the waits —
 *     mixed results; customer callbacks keep their real time, so ≥ 1 waits
 *     (the campaign shows "waiting" until it is due);
 *   - "November reminder (draft)": a draft;
 *   - "Daily reminder 10:00": a recurring parent (daily 10:00), paused;
 *   - segment "Promise due today" (last disposition = promise to pay).
 * Dry runs never charge the wallet.
 */
import type { Request } from 'express';
import type { Redis } from 'ioredis';
import type { Types } from 'mongoose';

import type { Env } from '../src/config/env';
import type { StorageProvider } from '../src/core/storage';
import { FakeClock } from '../src/core/voice/clock';
import { FakeTts } from '../src/core/voice/providers';
import { TtsCache } from '../src/core/voice/tts-cache';
import { CampaignContactModel } from '../src/db/models/campaign-contact.model';
import { CampaignModel, type CampaignDoc } from '../src/db/models/campaign.model';
import { ContactListModel } from '../src/db/models/contact-list.model';
import { ContactModel } from '../src/db/models/contact.model';
import { FlowModel } from '../src/db/models/flow.model';
import { SegmentModel } from '../src/db/models/segment.model';
import { CallManager } from '../src/modules/calls/call.service';
import { createDryRunPrograms } from '../src/modules/calls/dry-run';
import { CallRegistry } from '../src/modules/calls/registry';
import {
  createCampaign,
  pauseCampaign,
  startCampaign,
} from '../src/modules/campaigns/campaigns.service';
import { CampaignDispatcher } from '../src/modules/campaigns/dispatcher';
import { DialRate } from '../src/modules/campaigns/slots';
import { buildSearchText } from '../src/modules/contacts/normalize';
import type { Logger } from '../src/shared/logger';

import { withMockApi } from './seed-calls';
import { SEED_FLOW_NAMES } from './seed-flows';

export const SEED_CAMPAIGN_NAMES = {
  done: 'October recovery (dry run)',
  draft: 'November reminder (draft)',
  recurring: 'Daily reminder 10:00',
} as const;
export const SEED_CAMPAIGN_LIST = 'Campaign demo';
export const SEED_CAMPAIGN_SEGMENT = 'Promise due today';
const CONTACTS = 30;
export const campaignDemoPhone = (i: number): string => `+9190009020${String(i).padStart(2, '0')}`;

/** Timers never fire: only the seed's explicit ticks run, between clock jumps. */
class ManualClock extends FakeClock {
  override setTimeout(): number {
    return 0;
  }
}

export interface CampaignSeedDeps {
  env: Env;
  ownerId: Types.ObjectId;
  storage: StorageProvider;
  redis: Redis;
  logger: Logger;
}

const reqOf = (accountId: Types.ObjectId, ownerId: Types.ObjectId): Request =>
  ({
    auth: {
      kind: 'user',
      accountId: accountId.toString(),
      userId: ownerId.toString(),
      roleKey: 'owner',
      permissions: new Set<string>(),
      account: {
        id: accountId.toString(),
        status: 'active',
        timezone: 'Asia/Kolkata',
        isPlatform: false,
      },
    },
    ip: '127.0.0.1',
  }) as unknown as Request;

const ensureList = async (accountId: Types.ObjectId): Promise<Types.ObjectId> => {
  await ContactListModel.updateOne(
    { accountId, name: SEED_CAMPAIGN_LIST, deletedAt: null },
    {
      $setOnInsert: {
        accountId,
        name: SEED_CAMPAIGN_LIST,
        description: 'Demo contacts of the seeded campaigns',
        source: { type: 'manual' },
      },
    },
    { upsert: true },
  );
  const list = await ContactListModel.findOne({ accountId, name: SEED_CAMPAIGN_LIST })
    .select({ _id: 1 })
    .lean<{ _id: Types.ObjectId }>();
  if (!list) throw new Error('campaign list missing');
  for (let i = 1; i <= CONTACTS; i += 1) {
    const phoneE164 = campaignDemoPhone(i);
    const name = `Campaign Borrower ${String(i).padStart(2, '0')}`;
    await ContactModel.updateOne(
      { accountId, phoneE164, deletedAt: null },
      {
        $setOnInsert: {
          accountId,
          phoneE164,
          name,
          variables: {
            loan_id: `CAMP-${String(i).padStart(4, '0')}`,
            loan_amount: (40_000 + i * 1_500) * 1_000_000,
            emi_amount: (1_500 + i * 50) * 1_000_000,
            due_date: '2026-10-05',
            days_past_due: (i * 3) % 40,
          },
          tags: [],
          source: { type: 'manual', importJobId: null },
          searchText: buildSearchText({ name, phoneE164, externalId: null }),
          callCount: 0,
          deletedAt: null,
        },
        $addToSet: { listIds: list._id },
      },
      { upsert: true },
    );
  }
  return list._id;
};

/** Runs the campaign until nothing is due any more (callbacks may wait). */
const runDryRun = async (
  accountId: Types.ObjectId,
  campaignId: string,
  deps: CampaignSeedDeps,
): Promise<void> => {
  const clock = new ManualClock(Date.now());
  const calls = new CallManager({
    logger: deps.logger,
    registry: new CallRegistry(deps.redis, 'seedcampaigns:'),
    tts: new TtsCache({ tts: new FakeTts(), storage: deps.storage }),
    storage: deps.storage,
    recordingDir: deps.env.CALL_RECORDING_TMP_DIR,
    scriptFor: () => Promise.reject(new Error('no web calls in the campaign seed')),
    dryRun: createDryRunPrograms({ env: deps.env, storage: deps.storage, redis: deps.redis }),
  });
  const dispatcher = new CampaignDispatcher({
    calls,
    rate: new DialRate(deps.redis, `seedcampaigns:${accountId.toString()}:`),
    logger: deps.logger,
    clock,
  });
  const live = () =>
    CampaignContactModel.countDocuments({ campaignId, status: { $in: ['queued', 'calling'] } });
  try {
    for (let i = 0; i < 3_000; i += 1) {
      const doc = await CampaignModel.findById(campaignId).lean<CampaignDoc>();
      if (!doc || doc.status !== 'running') return;
      const waitingRetries = await CampaignContactModel.countDocuments({
        campaignId,
        status: { $in: ['pending', 'retry_wait'] },
      });
      if ((await live()) === 0 && waitingRetries === 0) return; // only callbacks left
      // the window is closed (or retries wait for the gap): jump forward
      const next = await CampaignContactModel.findOne({
        campaignId,
        status: { $in: ['pending', 'retry_wait'] },
      })
        .sort({ nextAttemptAt: 1 })
        .select({ nextAttemptAt: 1 })
        .lean<{ nextAttemptAt: Date | null }>();
      const target = Math.max(
        doc.waitingUntil?.getTime() ?? 0,
        (await live()) === 0 ? (next?.nextAttemptAt?.getTime() ?? 0) : 0,
      );
      clock.advance(Math.max(0, Date.now() - clock.now(), target - clock.now()) + 20_000);
      await dispatcher.tick(accountId.toString());
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('the demo campaign did not finish');
  } finally {
    await dispatcher.stop();
    await calls.shutdown();
  }
};

export const seedCampaigns = async (
  accountId: Types.ObjectId,
  deps: CampaignSeedDeps,
): Promise<{ campaigns: number; calls: number; waiting: number }> => {
  const flow = await FlowModel.findOne({
    accountId,
    name: SEED_FLOW_NAMES.loan,
    deletedAt: null,
  }).lean<{ _id: Types.ObjectId; publishedVersion?: number | null }>();
  if (!flow?.publishedVersion) throw new Error('published demo flow missing — seed flows first');
  const listId = await ensureList(accountId);
  const req = reqOf(accountId, deps.ownerId);
  const base = {
    mode: 'dry_run',
    flowId: flow._id.toString(),
    audience: { listIds: [listId.toString()], excludeActiveCampaigns: false },
  };
  let campaigns = 0;

  if (!(await CampaignModel.exists({ accountId, name: SEED_CAMPAIGN_NAMES.done }))) {
    const c = await createCampaign(req, {
      ...base,
      name: SEED_CAMPAIGN_NAMES.done,
      retry: { maxAttempts: 2, intervalMinutes: 30, retryOn: ['no_answer', 'busy'] },
      dryRun: {
        speed: 50,
        mix: { answered: 7_000, no_answer: 1_500, busy: 1_000, failed: 300, invalid_number: 200 },
        // more callbacks than the default, so at least one stays waiting
        scenarios: {
          paid: 30,
          promise: 20,
          refuse: 10,
          callback: 25,
          silence: 5,
          wrong_number: 5,
          hangup_early: 3,
          wrong_keys: 2,
        },
      },
    } as never);
    await startCampaign(req, c.id);
    await withMockApi(deps.env, () => runDryRun(accountId, c.id, deps));
    campaigns += 1;
  }
  if (!(await CampaignModel.exists({ accountId, name: SEED_CAMPAIGN_NAMES.draft }))) {
    await createCampaign(req, { ...base, name: SEED_CAMPAIGN_NAMES.draft } as never);
    campaigns += 1;
  }
  if (!(await CampaignModel.exists({ accountId, name: SEED_CAMPAIGN_NAMES.recurring }))) {
    const c = await createCampaign(req, {
      ...base,
      name: SEED_CAMPAIGN_NAMES.recurring,
      schedule: { recurrence: { freq: 'daily', days: [], time: '10:00', until: null } },
    } as never);
    await startCampaign(req, c.id);
    await pauseCampaign(req, c.id);
    campaigns += 1;
  }
  await SegmentModel.updateOne(
    { accountId, name: SEED_CAMPAIGN_SEGMENT },
    {
      $setOnInsert: {
        accountId,
        name: SEED_CAMPAIGN_SEGMENT,
        filter: { conditions: [{ key: 'lastDisposition', op: 'eq', value: 'promise_to_pay' }] },
        createdBy: deps.ownerId,
      },
    },
    { upsert: true },
  );
  const done = await CampaignModel.findOne({ accountId, name: SEED_CAMPAIGN_NAMES.done })
    .select({ stats: 1 })
    .lean<{ stats: CampaignDoc['stats'] }>();
  return {
    campaigns,
    calls: done?.stats.attempts ?? 0,
    waiting: done?.stats.waiting ?? 0,
  };
};
