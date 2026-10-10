import type { Types } from 'mongoose';

import { AI_LIMITS } from '../../config/limits';
import { AgentPlaygroundSessionModel } from '../../db/models/agent-playground-session.model';
import { AiAgentModel } from '../../db/models/ai-agent.model';
import { isAgentInUse } from '../flows/in-use';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Deletes expired playground sessions in batches (the TTL index also does it — this counts). */
export const purgePlaygroundSessions = async (now = new Date()): Promise<{ deleted: number }> => {
  const res = await AgentPlaygroundSessionModel.deleteMany({ expiresAt: { $lte: now } });
  return { deleted: res.deletedCount };
};

/** Phase 6: an agent used by a live flow's draft or current published version is kept. */
export { isAgentInUse } from '../flows/in-use';

/** Hard-deletes agents soft-deleted more than 30 days ago (unless a flow still uses them). */
export const purgeDeletedAgents = async (now = new Date()): Promise<{ purged: number }> => {
  const cutoff = new Date(now.getTime() - AI_LIMITS.deletedAgentPurgeDays * DAY_MS);
  const old = await AiAgentModel.find({ deletedAt: { $ne: null, $lte: cutoff } })
    .setOptions({ withDeleted: true })
    .select({ _id: 1 })
    .lean<{ _id: Types.ObjectId }[]>();
  let purged = 0;
  for (const agent of old) {
    if (await isAgentInUse(agent._id.toString())) continue;
    const res = await AiAgentModel.deleteOne({ _id: agent._id }).setOptions({ withDeleted: true });
    purged += res.deletedCount;
  }
  return { purged };
};
