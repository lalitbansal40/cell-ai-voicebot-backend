import { CallModel, type CallDoc } from '../../../db/models/call.model';
import { CampaignModel } from '../../../db/models/campaign.model';
import { getLogger } from '../../../shared/logger';
import type { CallManager } from '../../calls/call.service';
import type { CallEndedSummary } from '../../calls/session';
import { applyResult } from '../dispatcher';

import { teamCallEnded } from './team.service';

/**
 * CM — team campaign calls are started (and owned) by the process the agent's browser talks
 * to, so their results are applied here too: the contact's outcome (idempotent with the
 * dialer's own handler) and the agent's wrap-up.
 */
export const teamCallFinished = async (summary: Pick<CallEndedSummary, 'callId'>) => {
  const call = await CallModel.findById(summary.callId).lean<CallDoc>();
  if (!call?.campaignId || !call.campaignContactId || !call.agentUserId) return;
  const campaign = await CampaignModel.findById(call.campaignId).select({ talkMode: 1 }).lean();
  if (campaign?.talkMode !== 'team') return;
  await applyResult(call, new Date());
  await teamCallEnded(call);
};

export const wireTeamCalls = (deps: {
  calls: Pick<CallManager, 'onCallEnded'>;
  whatsappCalls?: { onCallEnded: (l: (s: CallEndedSummary) => Promise<void>) => unknown } | null;
}): void => {
  const run = (summary: CallEndedSummary) =>
    teamCallFinished(summary).catch((err: unknown) =>
      getLogger().error({ err, callId: summary.callId }, 'team campaign: result failed'),
    );
  deps.calls.onCallEnded(run);
  deps.whatsappCalls?.onCallEnded(run);
};
