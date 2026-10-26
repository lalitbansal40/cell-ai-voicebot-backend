import type { Redis } from 'ioredis';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  ANALYTICS_RECONCILE_JOB,
  ANALYTICS_SWEEP_JOB,
  processMaintenanceJob,
} from '../../src/core/queues/workers/maintenance.worker';
import { AccountModel } from '../../src/db/models/account.model';
import { AnalyticsMarkModel } from '../../src/db/models/analytics-mark.model';
import { CallModel } from '../../src/db/models/call.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { MessageModel } from '../../src/db/models/message.model';
import { StatsDailyModel, type StatsDailyDoc } from '../../src/db/models/stats-daily.model';
import { rawFloor, rebuildAccount } from '../../src/modules/analytics/rebuild';
import { reconcileAnalytics, rollupCutoff } from '../../src/modules/analytics/reconcile';
import {
  sweepAnalytics,
  withAnalyticsLock,
  type AnalyticsDeps,
} from '../../src/modules/analytics/sweep';
import { purgeCalls } from '../../src/modules/calls/maintenance';
import { createLogger } from '../../src/shared/logger';
import {
  callDoc,
  countFromRaw,
  ledgerDoc,
  messageDoc,
  randomWorld,
  storedTotals,
} from '../helpers/analytics';
import { useTestDb } from '../helpers/db';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';

useTestDb();

let redis: Redis;
const prefix = uniquePrefix('analytics');
const NOW = new Date('2026-10-27T12:00:00.000Z');
const deps = (now = NOW): AnalyticsDeps => ({ redis, prefix: `${prefix}:`, now: () => now });

beforeAll(async () => {
  redis = (await requireRedis()).client;
});
afterAll(async () => {
  await flushPrefix(redis, prefix);
  redis.disconnect();
});

const account = async (timezone: string) => {
  const _id = new Types.ObjectId();
  await AccountModel.collection.insertOne({ _id, timezone, name: 'A', slug: _id.toString() });
  return _id;
};

const row = async (
  accountId: Types.ObjectId,
  q: Partial<Pick<StatsDailyDoc, 'day' | 'kind' | 'channel'>> = {},
) => StatsDailyModel.find({ accountId, ...q }).lean<StatsDailyDoc[]>();

describe('analytics rollups', () => {
  it.each(['Asia/Kolkata', 'UTC', 'America/New_York'])(
    'sweep = count from raw = rebuild, in %s, around local midnights',
    async (tz) => {
      await flushPrefix(redis, prefix);
      const a = await account(tz);
      await randomWorld(a, {
        seed: tz.length * 7919,
        end: NOW,
        days: 6,
        calls: 160,
        messages: 220,
        ledger: 90,
      });
      const first = await sweepAnalytics(deps());
      expect(first.callSeen).toBeGreaterThanOrEqual(160);
      const raw = await countFromRaw(a, tz);
      expect(raw.size).toBeGreaterThan(10);
      expect(await storedTotals(a, raw)).toEqual(raw);
      // nothing changed → nothing written
      const again = await sweepAnalytics(deps());
      expect([again.callChanged, again.messageChanged, again.ledgerChanged]).toEqual([0, 0, 0]);
      // the recount agrees with the sweep (the whole period)
      const check = await rebuildAccount({
        accountId: a,
        from: '2026-10-01',
        to: '2026-10-28',
        dryRun: true,
      });
      expect(check).toMatchObject({ differences: 0, written: false });
      expect(check.rows).toBeGreaterThan(0);
    },
  );

  it('late changes (status, Meta duration, disposition, message status) apply only the difference', async () => {
    await flushPrefix(redis, prefix);
    const tz = 'Asia/Kolkata';
    const a = await account(tz);
    const campaignId = new Types.ObjectId();
    const live = callDoc(a, {
      createdAt: NOW,
      status: 'in_progress',
      campaignId,
      timestamps: { queuedAt: NOW, ringingAt: NOW, answeredAt: NOW, endedAt: null },
    });
    const sent = messageDoc(a, { at: NOW, status: 'sent' });
    await CallModel.collection.insertOne(live);
    await MessageModel.collection.insertOne(sent);
    await sweepAnalytics(deps());
    expect(await row(a, { channel: 'voice' })).toEqual([]);
    expect((await row(a, { channel: 'whatsapp', kind: 'all' }))[0]?.counters).toEqual({
      msg_sent: 1,
    });

    const later = new Date(NOW.getTime() + 60_000);
    await CallModel.collection.updateOne(
      { _id: live._id },
      { $set: { status: 'completed', durationSec: 42, updatedAt: later } },
    );
    await MessageModel.collection.updateOne(
      { _id: sent._id },
      { $set: { status: 'read', updatedAt: later } },
    );
    await sweepAnalytics(deps(later));
    const campaignRow = (await row(a, { kind: 'campaign' }))[0];
    expect(campaignRow?.refId).toEqual(campaignId);
    expect(campaignRow?.counters).toMatchObject({
      calls_attempted: 1,
      calls_answered: 1,
      calls_talk_sec: 42,
    });
    expect((await row(a, { channel: 'whatsapp', kind: 'all' }))[0]?.counters).toEqual({
      msg_sent: 1,
      msg_delivered: 1,
      msg_read: 1,
    });

    // Meta's final duration arrives later; a person sets the outcome
    const later2 = new Date(later.getTime() + 60_000);
    await CallModel.collection.updateOne(
      { _id: live._id },
      { $set: { durationSec: 45, disposition: 'callback', updatedAt: later2 } },
    );
    await sweepAnalytics(deps(later2));
    const all = (await row(a, { channel: 'voice', kind: 'all' }))[0]?.counters;
    expect(all).toMatchObject({
      calls_attempted: 1,
      calls_talk_sec: 45,
      outcome_callback: 1,
      calls_no_outcome: 0,
    });
    expect(
      await rebuildAccount({ accountId: a, from: '2026-10-27', to: '2026-10-27', dryRun: true }),
    ).toMatchObject({
      differences: 0,
    });
  });

  it('replies to templates and first-response times come from the conversation', async () => {
    await flushPrefix(redis, prefix);
    const a = await account('Asia/Kolkata');
    const conversationId = new Types.ObjectId();
    const channelId = new Types.ObjectId();
    const templateId = new Types.ObjectId();
    const userId = new Types.ObjectId();
    const t0 = new Date('2026-10-27T05:00:00.000Z');
    const at = (min: number) => new Date(t0.getTime() + min * 60_000);
    const base = { conversationId, channelId, updatedAt: NOW };
    await MessageModel.collection.insertMany([
      messageDoc(a, {
        ...base,
        at: at(0),
        type: 'template',
        origin: 'api',
        status: 'read',
        template: { templateId, name: 't', language: 'en', category: 'utility', parameters: [] },
      }),
      messageDoc(a, {
        ...base,
        at: at(60),
        direction: 'in',
        origin: 'customer',
        status: 'received',
      }),
      messageDoc(a, {
        ...base,
        at: at(62),
        direction: 'in',
        origin: 'customer',
        status: 'received',
      }),
      messageDoc(a, { ...base, at: at(65), origin: 'agent', sentBy: userId, status: 'delivered' }),
      messageDoc(a, { ...base, at: at(66), origin: 'agent', sentBy: userId, status: 'delivered' }),
      messageDoc(a, {
        ...base,
        at: at(120),
        direction: 'in',
        origin: 'customer',
        status: 'received',
      }),
      messageDoc(a, {
        ...base,
        at: at(121),
        type: 'note',
        origin: 'agent',
        sentBy: userId,
        status: 'sent',
      }),
      messageDoc(a, { ...base, at: at(130), origin: 'agent', sentBy: userId, status: 'read' }),
    ]);
    await sweepAnalytics(deps());
    const template = (await row(a, { kind: 'template' }))[0]?.counters;
    expect(template).toEqual({
      msg_sent: 1,
      msg_delivered: 1,
      msg_read: 1,
      msg_tpl_sent: 1,
      msg_replied: 1,
    });
    const user = (await row(a, { kind: 'user' }))[0];
    expect(user?.refId).toEqual(userId);
    // waits: 60 → 65 min (300 s) and 120 → 130 min (600 s); the 66-min reply is not a first reply
    expect(user?.counters).toMatchObject({ resp_count: 2, resp_sec: 900, resp_b2: 2, msg_sent: 3 });
    expect((await row(a, { kind: 'all', channel: 'whatsapp' }))[0]?.counters).toMatchObject({
      msg_inbound: 3,
    });
  });

  it('spend counts on the call’s campaign; topups and holds never count', async () => {
    await flushPrefix(redis, prefix);
    const a = await account('Asia/Kolkata');
    const campaignId = new Types.ObjectId();
    const c = callDoc(a, { createdAt: NOW, campaignId });
    const messageId = new Types.ObjectId();
    const templateId = new Types.ObjectId();
    await CallModel.collection.insertOne(c);
    await MessageModel.collection.insertOne(
      messageDoc(a, {
        _id: messageId,
        at: NOW,
        type: 'template',
        template: { templateId, name: 't', language: 'en', category: 'utility', parameters: [] },
      }),
    );
    await LedgerEntryModel.collection.insertMany([
      ledgerDoc(a, {
        createdAt: NOW,
        amountMicros: 2_000_000,
        ref: { type: 'call', id: c._id.toString() },
      }),
      ledgerDoc(a, {
        createdAt: NOW,
        type: 'whatsapp_charge',
        amountMicros: 700_000,
        ref: { type: 'whatsapp_message', id: messageId.toString() },
      }),
      ledgerDoc(a, { createdAt: NOW, type: 'topup', direction: 'credit', amountMicros: 9_000_000 }),
      ledgerDoc(a, { createdAt: NOW, status: 'held', amountMicros: 5_000_000 }),
    ]);
    await sweepAnalytics(deps());
    const money = await row(a, { channel: 'money' });
    const of = (kind: string) => money.find((m) => m.kind === kind)?.counters;
    expect(of('all')).toEqual({
      spend_total: 2_700_000,
      spend_call_charge: 2_000_000,
      spend_whatsapp_charge: 700_000,
    });
    expect(of('campaign')).toEqual({ spend_total: 2_000_000, spend_call_charge: 2_000_000 });
    expect(of('template')).toEqual({ spend_total: 700_000, spend_whatsapp_charge: 700_000 });
  });

  it('a corrupted rollup is found by the dry run and fixed by the rebuild', async () => {
    await flushPrefix(redis, prefix);
    const a = await account('UTC');
    await randomWorld(a, { seed: 42, end: NOW, days: 2, calls: 30, messages: 30, ledger: 10 });
    await sweepAnalytics(deps());
    const before = await storedTotals(a, await countFromRaw(a, 'UTC'));
    await StatsDailyModel.updateOne(
      { accountId: a, kind: 'all', channel: 'voice', test: false },
      { $inc: { 'counters.calls_attempted': 5 } },
    );
    const dry = await rebuildAccount({
      accountId: a,
      from: '2026-10-20',
      to: '2026-10-27',
      dryRun: true,
    });
    expect(dry).toMatchObject({ differences: 1, written: false });
    const fixed = await rebuildAccount({ accountId: a, from: '2026-10-20', to: '2026-10-27' });
    expect(fixed).toMatchObject({ differences: 1, written: true });
    expect(await storedTotals(a, await countFromRaw(a, 'UTC'))).toEqual(before);
    // marks were reset with the recount: the next sweep changes nothing
    const again = await sweepAnalytics(deps());
    expect([again.callChanged, again.messageChanged, again.ledgerChanged]).toEqual([0, 0, 0]);
    // an empty range (floor after the end) does nothing
    expect(
      await rebuildAccount({
        accountId: a,
        from: '2026-10-01',
        to: '2026-10-02',
        floor: '2026-10-05',
      }),
    ).toEqual({
      from: '2026-10-05',
      to: '2026-10-02',
      rows: 0,
      differences: 0,
      written: false,
    });
  });

  it('purging raw calls keeps their counts; rebuilds never reach past the raw floor', async () => {
    await flushPrefix(redis, prefix);
    const a = await account('Asia/Kolkata');
    const old = new Date('2026-04-01T06:00:00.000Z');
    await CallModel.collection.insertOne(
      callDoc(a, { createdAt: old, updatedAt: NOW, durationSec: 10 }),
    );
    await sweepAnalytics(deps());
    expect((await row(a, { day: '2026-04-01', kind: 'all' }))[0]?.counters).toMatchObject({
      calls_answered: 1,
    });
    expect(await AnalyticsMarkModel.countDocuments({ accountId: a })).toBe(1);
    await purgeCalls(undefined, 180, NOW);
    expect(await CallModel.countDocuments({ accountId: a })).toBe(0);
    expect(await AnalyticsMarkModel.countDocuments({ accountId: a })).toBe(0);
    const floor = rawFloor(NOW, 'Asia/Kolkata', { callsDays: 180, inboxDays: 90 });
    expect(floor).toBe('2026-07-30');
    expect(rawFloor(NOW, 'Asia/Kolkata', { callsDays: 180, inboxDays: 0 })).toBe('2026-05-01');
    await rebuildAccount({ accountId: a, from: '2026-03-01', to: '2026-10-27', floor });
    expect((await row(a, { day: '2026-04-01', kind: 'all' }))[0]?.counters).toMatchObject({
      calls_answered: 1,
    });
  });

  it('one writer at a time', async () => {
    const inner = await withAnalyticsLock(deps(), () => sweepAnalytics(deps()));
    expect(inner).toEqual({ skipped: 1 });
    expect(await withAnalyticsLock(deps(), () => Promise.resolve('free again'))).toBe('free again');
  });

  it('the nightly reconcile fixes differences, tells the superadmins and drops expired rollups', async () => {
    await flushPrefix(redis, prefix);
    const a = await account('Asia/Kolkata');
    await CallModel.collection.insertOne(callDoc(a, { createdAt: NOW, updatedAt: NOW }));
    await sweepAnalytics(deps());
    await StatsDailyModel.updateOne(
      { accountId: a, kind: 'all', channel: 'voice' },
      { $set: { 'counters.calls_attempted': 9 } },
    );
    await StatsDailyModel.create({
      accountId: a,
      day: '2024-01-01',
      channel: 'voice',
      kind: 'all',
      counters: { calls_attempted: 1 },
    });
    const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    const warn = vi.spyOn(logger, 'warn');
    const result = await reconcileAnalytics({
      ...deps(),
      logger,
      retention: { callsDays: 180, inboxDays: 90 },
    });
    expect(result).toMatchObject({ fixedAccounts: 1, fixedRows: 1, expiredRows: 1 });
    expect(warn).toHaveBeenCalledWith({ accounts: 1, rows: 1 }, 'analytics: recount fixed rollups');
    expect((await row(a, { kind: 'all', channel: 'voice' }))[0]?.counters).toMatchObject({
      calls_attempted: 1,
    });
    expect(rollupCutoff(NOW)).toBe('2024-09-27');
    const quiet = await reconcileAnalytics({
      ...deps(),
      logger,
      retention: { callsDays: 180, inboxDays: 90 },
    });
    expect(quiet).toMatchObject({ fixedRows: 0, expiredRows: 0 });
    // locked → skipped
    expect(
      await withAnalyticsLock(deps(), () =>
        reconcileAnalytics({ ...deps(), logger, retention: { callsDays: 180, inboxDays: 90 } }),
      ),
    ).toEqual({ skipped: 1 });
  });
});

describe('maintenance worker — analytics jobs', () => {
  it('runs the sweep (logs only when it counted something) and the reconcile', async () => {
    await flushPrefix(redis, prefix);
    const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    const info = vi.spyOn(logger, 'info');
    const run = processMaintenanceJob({ logger, analytics: { redis, prefix: `${prefix}:` } });
    const a = await account('UTC');
    await CallModel.collection.insertOne(
      callDoc(a, { createdAt: new Date(), updatedAt: new Date() }),
    );
    const first = await run({ name: ANALYTICS_SWEEP_JOB } as never);
    expect(first.callChanged).toBe(1);
    expect(info).toHaveBeenCalledTimes(1);
    const second = await run({ name: ANALYTICS_SWEEP_JOB } as never);
    expect(second.callChanged).toBe(0);
    expect(info).toHaveBeenCalledTimes(1);
    const reconciled = await run({ name: ANALYTICS_RECONCILE_JOB } as never);
    expect(reconciled.fixedRows).toBe(0);
    expect(info).toHaveBeenCalledTimes(2);
  });
});
