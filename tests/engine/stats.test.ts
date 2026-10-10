import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { mongoStatsRecorder } from '../../src/core/engine/stats';
import { FlowNodeStatsModel } from '../../src/db/models/flow-node-stats.model';
import { useTestDb } from '../helpers/db';

useTestDb();

describe('mongo stats recorder', () => {
  it('buffers events and writes $inc upserts per node and IST day', async () => {
    const key = {
      accountId: new Types.ObjectId(),
      flowId: new Types.ObjectId(),
      version: 0,
      mode: 'simulator' as const,
      timezone: 'Asia/Kolkata',
      now: () => new Date('2026-10-10T19:00:00Z'), // 11 Oct IST
    };
    const rec = mongoStatsRecorder(key);
    await rec.flush(); // nothing buffered
    rec.record({ nodeId: 'menu', event: 'enter' });
    rec.record({ nodeId: 'menu', event: 'exit', handle: 'key_k1', ms: 1200.4 });
    rec.record({ nodeId: 'menu', event: 'error' });
    rec.record({ nodeId: 'bye', event: 'enter' });
    rec.record({ nodeId: 'bye', event: 'exit', handle: 'end' });
    rec.record({ nodeId: 'bye', event: 'exit' });
    await rec.flush();
    rec.record({ nodeId: 'menu', event: 'enter' });
    rec.record({ nodeId: 'menu', event: 'exit', handle: 'key_k1', ms: -5 });
    await rec.flush();
    const menu = await FlowNodeStatsModel.findOne({ flowId: key.flowId, nodeId: 'menu' }).lean();
    expect(menu).toMatchObject({
      day: '2026-10-11',
      entered: 2,
      errorCount: 1,
      totalMs: 1200,
      exits: { key_k1: 2 },
    });
    const byeRow = await FlowNodeStatsModel.findOne({ flowId: key.flowId, nodeId: 'bye' }).lean();
    expect(byeRow).toMatchObject({ entered: 1, totalMs: 0, exits: { end: 1 } });
  });
});
