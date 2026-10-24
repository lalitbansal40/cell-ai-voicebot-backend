import type { Types } from 'mongoose';

import { AiAgentModel } from '../../db/models/ai-agent.model';
import { FlowModel } from '../../db/models/flow.model';
import type { ErrorDetail } from '../../shared/errors/app-error';

export interface CallProgram {
  kind: 'flow' | 'agent';
  id: Types.ObjectId | string;
}

/**
 * Why an AI program can't answer / place a WhatsApp call (empty = runnable): a flow
 * needs a published version, an agent must exist and be on — both in the account.
 */
export const programProblems = async (
  accountId: Types.ObjectId,
  program: CallProgram | null,
  path = 'program',
): Promise<ErrorDetail[]> => {
  if (!program) return [{ path, message: 'Choose a flow or an AI agent' }];
  if (program.kind === 'flow') {
    const flow = await FlowModel.findOne({ _id: program.id, accountId })
      .select({ publishedVersionId: 1 })
      .lean<{ publishedVersionId: Types.ObjectId | null }>();
    if (!flow) return [{ path, message: 'Flow not found' }];
    if (!flow.publishedVersionId) return [{ path, message: 'Publish the flow first' }];
    return [];
  }
  const agent = await AiAgentModel.findOne({ _id: program.id, accountId })
    .select({ isActive: 1 })
    .lean<{ isActive: boolean }>();
  if (!agent) return [{ path, message: 'AI agent not found' }];
  if (!agent.isActive) return [{ path, message: 'This AI agent is turned off' }];
  return [];
};
