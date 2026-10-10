import type { Types } from 'mongoose';

import { FLOW_LIMITS } from '../../config/limits';
import { FlowNodeStatsModel } from '../../db/models/flow-node-stats.model';
import { FlowRunModel } from '../../db/models/flow-run.model';
import { FlowVersionModel } from '../../db/models/flow-version.model';
import { FlowModel } from '../../db/models/flow.model';

import { isFlowInUse } from './in-use';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Hard-deletes flows soft-deleted more than 30 days ago with their versions,
 * runs and node stats — unless something still uses them (`isFlowInUse`).
 */
export const purgeDeletedFlows = async (now = new Date()): Promise<{ purged: number }> => {
  const cutoff = new Date(now.getTime() - FLOW_LIMITS.deletedFlowPurgeDays * DAY_MS);
  const old = await FlowModel.find({ deletedAt: { $ne: null, $lte: cutoff } })
    .setOptions({ withDeleted: true })
    .select({ _id: 1 })
    .lean<{ _id: Types.ObjectId }[]>();
  let purged = 0;
  for (const flow of old) {
    if (await isFlowInUse(flow._id)) continue;
    await FlowVersionModel.deleteMany({ flowId: flow._id });
    await FlowRunModel.deleteMany({ flowId: flow._id });
    await FlowNodeStatsModel.deleteMany({ flowId: flow._id });
    const res = await FlowModel.deleteOne({ _id: flow._id }).setOptions({ withDeleted: true });
    purged += res.deletedCount;
  }
  return { purged };
};
