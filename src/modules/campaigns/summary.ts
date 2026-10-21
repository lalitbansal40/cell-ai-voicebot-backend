import type { Request } from 'express';

import { AccountModel, type AccountDoc } from '../../db/models/account.model';
import { CallModel } from '../../db/models/call.model';
import { CampaignModel, type CampaignStatus } from '../../db/models/campaign.model';
import { tenantFilter } from '../../shared/auth/tenant';

import { capBounds } from './caps';

const COUNTED = ['running', 'scheduled', 'paused'] as const satisfies readonly CampaignStatus[];

/**
 * `GET /campaigns/summary` — the dashboard card: campaigns by live status (runs
 * of a repeating campaign count on their own) and today's campaign calls in the
 * account's time zone.
 */
export const campaignSummary = async (req: Request, now = new Date()) => {
  const { accountId } = tenantFilter(req);
  const account = await AccountModel.findById(accountId, { timezone: 1 }).lean<
    Pick<AccountDoc, 'timezone'>
  >();
  const { dayStart } = capBounds(now, account?.timezone ?? 'Asia/Kolkata');
  const [byStatus, callsToday] = await Promise.all([
    CampaignModel.aggregate<{ _id: (typeof COUNTED)[number]; n: number }>([
      { $match: { accountId, deletedAt: null, status: { $in: COUNTED } } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    CallModel.countDocuments({
      accountId,
      campaignId: { $ne: null },
      createdAt: { $gte: dayStart },
    }),
  ]);
  const counts = { running: 0, scheduled: 0, paused: 0 };
  for (const row of byStatus) counts[row._id] = row.n;
  return { ...counts, callsToday };
};
