import type { Types } from 'mongoose';

import { FlowNodeStatsModel } from '../../db/models/flow-node-stats.model';
import { ymdInZone } from '../../shared/time';

import type { StatsEvent, StatsRecorder } from './types';

/** Keeps events in memory (tests, and the buffer of the Mongo recorder). */
export const memoryStatsRecorder = (): StatsRecorder & { events: StatsEvent[] } => {
  const events: StatsEvent[] = [];
  return { events, record: (e) => events.push(e) };
};

/** Buffers node events of one `advance` and writes them as atomic `$inc` upserts. */
export const mongoStatsRecorder = (key: {
  accountId: Types.ObjectId;
  flowId: Types.ObjectId;
  /** Version number, `0` = draft. */
  version: number;
  mode: 'simulator' | 'call';
  timezone: string;
  now: () => Date;
}): StatsRecorder & { flush(): Promise<void> } => {
  const buffer = memoryStatsRecorder();
  return {
    record: (e) => buffer.record(e),
    flush: async () => {
      const events = buffer.events.splice(0);
      if (!events.length) return;
      const day = ymdInZone(key.now(), key.timezone);
      const incs = new Map<string, Record<string, number>>();
      for (const e of events) {
        const inc = incs.get(e.nodeId) ?? {};
        if (e.event === 'enter') inc.entered = (inc.entered ?? 0) + 1;
        if (e.event === 'error') inc.errorCount = (inc.errorCount ?? 0) + 1;
        if (e.event === 'exit' && e.handle) {
          inc[`exits.${e.handle}`] = (inc[`exits.${e.handle}`] ?? 0) + 1;
          inc.totalMs = (inc.totalMs ?? 0) + Math.max(0, Math.round(e.ms ?? 0));
        }
        incs.set(e.nodeId, inc);
      }
      await FlowNodeStatsModel.bulkWrite(
        [...incs].map(([nodeId, inc]) => ({
          updateOne: {
            filter: {
              accountId: key.accountId,
              flowId: key.flowId,
              version: key.version,
              nodeId,
              day,
              mode: key.mode,
            },
            update: { $inc: inc },
            upsert: true,
          },
        })),
      );
    },
  };
};
