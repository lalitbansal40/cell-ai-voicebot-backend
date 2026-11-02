import { Types } from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';

import { CallModel } from '../../src/db/models/call.model';
import { countLiveCalls, parseWait, waitForLiveCalls } from '../../src/ops/live-calls';
import { callDoc } from '../helpers/analytics';
import { useTestDb } from '../helpers/db';

useTestDb();

// the count is platform-wide: each case starts with no calls
beforeEach(async () => {
  await CallModel.deleteMany({});
});

const insert = async (status: string, createdAt = new Date()) =>
  (await CallModel.collection.insertOne(callDoc(new Types.ObjectId(), { status, createdAt })))
    .insertedId;

describe('ops live-calls (release waits for calls)', () => {
  it('counts queued, ringing and in-progress calls, not ended or stale ones', async () => {
    await insert('in_progress');
    await insert('ringing');
    await insert('queued');
    await insert('completed');
    await insert('in_progress', new Date(Date.now() - 3 * 3_600_000));
    expect(await countLiveCalls()).toBe(3);
  });

  it('waits until the last call ends', async () => {
    const id = await insert('in_progress');
    let sleeps = 0;
    const live = await waitForLiveCalls(60, async () => {
      sleeps += 1;
      await CallModel.collection.updateOne({ _id: id }, { $set: { status: 'completed' } });
    });
    expect(live).toBe(0);
    expect(sleeps).toBe(1);
  });

  it('gives up after the wait and reports the calls still live', async () => {
    await insert('in_progress');
    expect(await waitForLiveCalls(0, () => Promise.resolve())).toBe(1);
  });

  it('reads --wait as whole seconds up to an hour', () => {
    expect(parseWait([])).toBe(0);
    expect(parseWait(['--wait', '600'])).toBe(600);
    expect(() => parseWait(['--wait', '-1'])).toThrow();
    expect(() => parseWait(['--wait', '7200'])).toThrow();
  });
});
