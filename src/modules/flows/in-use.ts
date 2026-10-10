import { Types } from 'mongoose';

import { FlowVersionModel } from '../../db/models/flow-version.model';
import { FlowModel, type FlowDoc } from '../../db/models/flow.model';

export interface FlowUser {
  id: string;
  name: string;
  status: FlowDoc['status'];
}

const asId = (id: string | Types.ObjectId): Types.ObjectId | null =>
  id instanceof Types.ObjectId ? id : Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null;

/**
 * Live flows whose **draft** or **current published version** uses an agent /
 * audio (`stats.<field>` on the flow, `<versionField>` on the version).
 */
const flowsUsing = async (
  id: string | Types.ObjectId,
  draftField: 'stats.agents' | 'stats.audios',
  versionField: 'agentIds' | 'audioIds',
): Promise<FlowUser[]> => {
  const _id = asId(id);
  if (!_id) return [];
  const versions = await FlowVersionModel.find({ [versionField]: _id })
    .select({ _id: 1 })
    .lean<{ _id: Types.ObjectId }[]>();
  const flows = await FlowModel.find({
    $or: [{ [draftField]: _id }, { publishedVersionId: { $in: versions.map((v) => v._id) } }],
  })
    .sort({ name: 1 })
    .select({ name: 1, status: 1 })
    .lean<Pick<FlowDoc, '_id' | 'name' | 'status'>[]>();
  return flows.map((f) => ({ id: f._id.toString(), name: f.name, status: f.status }));
};

/** Flows that use an AI agent (Phase 5 delete / purge guards). */
export const flowsUsingAgent = (agentId: string | Types.ObjectId) =>
  flowsUsing(agentId, 'stats.agents', 'agentIds');

/** Flows that use an audio file (audio delete guard). */
export const flowsUsingAudio = (audioId: string | Types.ObjectId) =>
  flowsUsing(audioId, 'stats.audios', 'audioIds');

export const isAgentInUse = async (agentId: string | Types.ObjectId): Promise<boolean> =>
  (await flowsUsingAgent(agentId)).length > 0;

export const isAudioInUse = async (audioId: string | Types.ObjectId): Promise<boolean> =>
  (await flowsUsingAudio(audioId)).length > 0;

/**
 * Whether a flow may not be deleted — Phase 8 campaigns / Phase 14 inbound
 * numbers will answer here. Phase 6: nothing uses flows yet.
 */
export const isFlowInUse = (_flowId: string | Types.ObjectId): Promise<boolean> =>
  Promise.resolve(false);
