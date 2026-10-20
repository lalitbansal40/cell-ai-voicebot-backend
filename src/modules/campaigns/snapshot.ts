import { Types } from 'mongoose';

import { isDuplicateKeyError } from '../../db/errors';
import {
  CampaignContactModel,
  DUE_RANK,
  type CampaignContactStatus,
} from '../../db/models/campaign-contact.model';
import {
  CampaignModel,
  SKIP_REASONS,
  type CampaignDoc,
  type CampaignStats,
} from '../../db/models/campaign.model';

import {
  activeElsewhere,
  audienceBatches,
  audienceQuery,
  classifyRow,
  displayValues,
  type ClassifyContext,
  type UsedField,
} from './audience';

/** Where each campaign-contact status is counted in `campaign.stats`. */
export const STATUS_STAT: Record<CampaignContactStatus, keyof CampaignStats> = {
  pending: 'pending',
  queued: 'queued',
  calling: 'calling',
  retry_wait: 'waiting',
  callback_wait: 'waiting',
  completed: 'completed',
  failed: 'failed',
  skipped: 'skipped',
  canceled: 'canceled',
};

export interface ContactCounts {
  total: number;
  byStat: Record<
    'pending' | 'queued' | 'calling' | 'waiting' | 'completed' | 'failed' | 'skipped' | 'canceled',
    number
  >;
  skippedBy: Record<string, number>;
}

/** Campaign contacts counted from the collection (snapshot end, drift recount). */
export const contactCounts = async (campaignId: Types.ObjectId): Promise<ContactCounts> => {
  const rows = await CampaignContactModel.aggregate<{
    _id: { status: CampaignContactStatus; skipReason: string | null };
    n: number;
  }>([
    { $match: { campaignId } },
    { $group: { _id: { status: '$status', skipReason: '$skipReason' }, n: { $sum: 1 } } },
  ]);
  const counts: ContactCounts = {
    total: 0,
    byStat: {
      pending: 0,
      queued: 0,
      calling: 0,
      waiting: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      canceled: 0,
    },
    skippedBy: Object.fromEntries(SKIP_REASONS.map((r) => [r, 0])),
  };
  for (const row of rows) {
    counts.total += row.n;
    counts.byStat[STATUS_STAT[row._id.status] as keyof ContactCounts['byStat']] += row.n;
    if (row._id.status === 'skipped' && row._id.skipReason) {
      counts.skippedBy[row._id.skipReason] = (counts.skippedBy[row._id.skipReason] ?? 0) + row.n;
    }
  }
  return counts;
};

/** `$set` of the counters that come from the contacts (attempt / money counters stay). */
export const countsToStats = (counts: ContactCounts): Record<string, number> => ({
  'stats.total': counts.total,
  ...Object.fromEntries(Object.entries(counts.byStat).map(([k, v]) => [`stats.${k}`, v])),
  ...Object.fromEntries(
    Object.entries(counts.skippedBy).map(([k, v]) => [`stats.skippedBy.${k}`, v]),
  ),
});

/**
 * Copies the audience into `campaignContacts` (PHASE_8_PLAN §1f) in batches,
 * resumable from `campaign.snapshot.cursor` (a crash mid-way continues without
 * duplicates: the unique `{ campaignId, contactId }` index drops repeats).
 * Called contacts start `pending`, due `now`; the rest `skipped` with a reason.
 */
export const takeSnapshot = async (
  campaign: CampaignDoc,
  used: readonly UsedField[],
  now: Date,
): Promise<ContactCounts> => {
  const query = await audienceQuery(campaign.accountId, campaign.audience);
  if (query) {
    const resuming = campaign.snapshot.cursor !== null;
    const ctx: ClassifyContext = {
      seenPhones: new Set(
        resuming
          ? await CampaignContactModel.distinct('phoneE164', {
              campaignId: campaign._id,
              skipReason: { $nin: ['duplicate_phone', 'dnd', 'opted_out', 'invalid_phone'] },
            })
          : [],
      ),
      activeContactIds: new Set(),
      used,
      skipIfMissing: new Set(campaign.audience.skipIfMissing),
    };
    let seq = resuming
      ? await CampaignContactModel.countDocuments({ campaignId: campaign._id })
      : 0;
    const after = resuming ? new Types.ObjectId(campaign.snapshot.cursor ?? undefined) : null;
    for await (const batch of audienceBatches(query, after)) {
      ctx.activeContactIds = campaign.audience.excludeActiveCampaigns
        ? await activeElsewhere(
            campaign.accountId,
            batch.map((r) => r._id),
            campaign._id,
          )
        : new Set();
      const docs = batch.map((row) => {
        const { skip } = classifyRow(row, ctx);
        seq += 1;
        return {
          accountId: campaign.accountId,
          campaignId: campaign._id,
          contactId: row._id,
          seq,
          phoneE164: row.phoneE164,
          name: row.name ?? null,
          variables: displayValues(row, used),
          status: skip ? 'skipped' : 'pending',
          skipReason: skip,
          dueRank: DUE_RANK.fresh,
          nextAttemptAt: skip ? null : now,
        };
      });
      try {
        await CampaignContactModel.insertMany(docs, { ordered: false });
      } catch (err) {
        // a resumed batch may repeat rows already inserted before the crash
        if (!isDuplicateKeyError(err)) throw err;
      }
      const last = batch[batch.length - 1] as { _id: Types.ObjectId };
      await CampaignModel.updateOne(
        { _id: campaign._id },
        { $set: { 'snapshot.cursor': last._id.toString() } },
      );
    }
  }
  const counts = await contactCounts(campaign._id);
  await CampaignModel.updateOne(
    { _id: campaign._id },
    {
      $set: {
        ...countsToStats(counts),
        'snapshot.done': true,
        'snapshot.counts': {
          total: counts.total,
          willCall: counts.byStat.pending,
          ...counts.skippedBy,
        },
      },
    },
  );
  return counts;
};
