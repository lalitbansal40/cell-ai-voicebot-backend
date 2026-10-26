import mongoose, { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../src/db/migrations';
import {
  ANALYTICS_REBUILD_INDEX,
  ANALYTICS_SWEEP_INDEX,
} from '../../src/db/migrations/0015-analytics';
import { INSIGHTS_DUE_INDEX } from '../../src/db/migrations/0016-insights';
import { AccountModel } from '../../src/db/models/account.model';
import { CallModel } from '../../src/db/models/call.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { MessageModel } from '../../src/db/models/message.model';
import { callDoc, ledgerDoc, messageDoc } from '../helpers/analytics';
import { useTestDb } from '../helpers/db';

useTestDb();

const db = () => {
  const handle = mongoose.connection.db;
  if (!handle) throw new Error('no db');
  return handle;
};
const migration = () => {
  const found = MIGRATIONS.find((m) => m.name === '0015-analytics');
  if (!found) throw new Error('0015 missing');
  return found;
};

describe('0015-analytics', () => {
  it('is registered right after 0014', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(names.indexOf('0015-analytics')).toBe(names.indexOf('0014-meta-2026') + 1);
  });

  it('up builds the sweep indexes and backfills every account from its first row; down removes them', async () => {
    const a = new Types.ObjectId();
    const empty = new Types.ObjectId();
    await AccountModel.collection.insertMany([
      { _id: a, name: 'A', slug: 'a-15', timezone: 'Asia/Kolkata' },
      { _id: empty, name: 'B', slug: 'b-15' },
    ]);
    const old = new Date('2026-01-10T05:00:00.000Z');
    await CallModel.collection.insertOne(callDoc(a, { createdAt: old }));
    await MessageModel.collection.insertOne(messageDoc(a, { at: new Date(), status: 'read' }));
    await LedgerEntryModel.collection.insertOne(ledgerDoc(a, { createdAt: new Date() }));

    await migration().up(db());
    await migration().up(db()); // a rerun recounts the same days
    const stats = db().collection('statsDaily');
    const jan = await stats.findOne({ accountId: a, day: '2026-01-10', kind: 'all' });
    expect(jan?.counters).toMatchObject({ calls_attempted: 1, calls_answered: 1 });
    expect(await stats.countDocuments({ accountId: a, channel: 'whatsapp', kind: 'all' })).toBe(1);
    expect(await stats.countDocuments({ accountId: a, channel: 'money' })).toBe(1);
    expect(await stats.countDocuments({ accountId: empty })).toBe(0);
    expect(await db().collection('analyticsMarks').countDocuments({ accountId: a })).toBe(3);
    expect(await db().collection('calls').indexExists(ANALYTICS_SWEEP_INDEX)).toBe(true);
    expect(await db().collection('messages').indexExists(ANALYTICS_REBUILD_INDEX)).toBe(true);

    await migration().down(db());
    const names = (await db().listCollections().toArray()).map((c) => c.name);
    expect(names).not.toContain('statsDaily');
    expect(names).not.toContain('analyticsMarks');
    expect(await db().collection('calls').indexExists(ANALYTICS_SWEEP_INDEX)).toBe(false);
    expect(await db().collection('messages').indexExists(ANALYTICS_REBUILD_INDEX)).toBe(false);
    expect(await db().collection('ledgerEntries').indexExists(ANALYTICS_SWEEP_INDEX)).toBe(false);
    await migration().down(db()); // safe twice
  });
});

describe('0016-insights', () => {
  const m = () => {
    const found = MIGRATIONS.find((x) => x.name === '0016-insights');
    if (!found) throw new Error('0016 missing');
    return found;
  };

  it('is registered right after 0015', () => {
    const names = MIGRATIONS.map((x) => x.name);
    expect(names.indexOf('0016-insights')).toBe(names.indexOf('0015-analytics') + 1);
  });

  it('settings + default outcomes per account; ended calls skipped "before_insights"; sources backfilled; down undoes it', async () => {
    const accounts = db().collection('accounts');
    const calls = db().collection('calls');
    const a = new Types.ObjectId();
    const kept = new Types.ObjectId();
    await accounts.insertMany([
      { _id: a, name: 'M', slug: 'm-16', settings: {} },
      {
        _id: kept,
        name: 'K',
        slug: 'k-16',
        settings: {
          insights: { enabled: false, chatSummaryOnClose: true },
          dispositions: [{ key: 'x', label: 'X', active: true }],
        },
      },
    ]);
    const ended = callDoc(a, { disposition: 'callback', source: { kind: 'agent' } });
    const flow = callDoc(a, { disposition: 'paid' });
    const live = callDoc(a, {
      status: 'in_progress',
      timestamps: { queuedAt: new Date(), ringingAt: null, answeredAt: null, endedAt: null },
    });
    await calls.insertMany([ended, flow, live]);
    await m().up(db());
    await m().up(db());
    const acc = await accounts.findOne({ _id: a });
    expect(acc?.settings).toMatchObject({ insights: { enabled: true, chatSummaryOnClose: false } });
    expect((acc?.settings as { dispositions: unknown[] }).dispositions).toHaveLength(8);
    expect((await accounts.findOne({ _id: kept }))?.settings).toMatchObject({
      insights: { enabled: false },
      dispositions: [{ key: 'x' }],
    });
    expect(await calls.findOne({ _id: ended._id })).toMatchObject({
      insights: { status: 'skipped', reason: 'before_insights', version: 0 },
      dispositionSource: 'agent',
    });
    expect((await calls.findOne({ _id: flow._id }))?.dispositionSource).toBe('flow');
    expect(await calls.findOne({ _id: live._id })).toMatchObject({
      insights: null,
      dispositionSource: null,
    });
    expect(await calls.indexExists(INSIGHTS_DUE_INDEX)).toBe(true);
    await m().down(db());
    expect(await calls.indexExists(INSIGHTS_DUE_INDEX)).toBe(false);
    expect('insights' in ((await calls.findOne({ _id: ended._id })) ?? {})).toBe(false);
    expect('insights' in ((await accounts.findOne({ _id: a }))?.settings ?? {})).toBe(false);
    await m().down(db());
  });
});
