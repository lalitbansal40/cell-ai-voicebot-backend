import {
  WhatsAppCampaignModel,
  emptyCounters,
  type WhatsAppCampaignDoc,
} from '../../db/models/whatsapp-campaign.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { nextOccurrence } from '../campaigns/recurrence';

import { snapshotAudience } from './audience';
import { estimateCampaignDoc } from './estimate';
import { loadVariants } from './variants';

/** Completed runs form a series; unique root + occurrence prevents duplicate scheduler runs. */
export const scheduleRecurringRuns = async (now: Date) => {
  const completed = await WhatsAppCampaignModel.find({
    status: 'completed',
    'schedule.kind': 'recurring',
    recurrenceEnabled: { $ne: false },
  }).lean<WhatsAppCampaignDoc[]>();
  for (const previous of completed) {
    const rootId = previous.parentCampaignId ?? previous._id;
    const root = await WhatsAppCampaignModel.findById(rootId).lean<WhatsAppCampaignDoc>();
    if (
      !root ||
      root.recurrenceEnabled === false ||
      ['stopped', 'paused'].includes(root.status) ||
      !previous.schedule.recurrence
    )
      continue;
    const next = nextOccurrence(
      previous.schedule.recurrence,
      previous.schedule.timezone ?? 'Asia/Kolkata',
      new Date(
        Math.max(
          previous.schedule.at?.getTime() ?? 0,
          previous.startedAt?.getTime() ?? 0,
          previous.createdAt.getTime(),
        ),
      ),
    );
    if (!next) continue;
    const { _id: _previousId, createdAt: _created, updatedAt: _updated, ...settings } = previous;
    await WhatsAppCampaignModel.updateOne(
      { parentCampaignId: rootId, 'schedule.at': next },
      {
        $setOnInsert: {
          ...settings,
          parentCampaignId: rootId,
          status: 'scheduled',
          pauseReason: null,
          schedule: { ...previous.schedule, at: next },
          counters: emptyCounters(),
          cost: { estimateMicros: 0, chargedMicros: 0 },
          startedAt: null,
          finishedAt: null,
          nextBatchAt: null,
        },
      },
      { upsert: true },
    ).catch((err: { code?: number }) => {
      if (err.code !== 11000) throw err;
    });
    // A simultaneous stop must not leave a runnable child behind.
    if (
      await WhatsAppCampaignModel.exists({
        _id: rootId,
        $or: [{ status: 'stopped' }, { recurrenceEnabled: false }],
      })
    )
      await WhatsAppCampaignModel.updateMany(
        { parentCampaignId: rootId, status: 'scheduled' },
        { $set: { status: 'stopped', finishedAt: now } },
      );
  }
};

/** A new occurrence snapshots fresh contacts and prices at execution time. */
export const prepareRecurringRun = async (
  campaign: WhatsAppCampaignDoc,
  now: Date,
): Promise<boolean> => {
  if (!campaign.parentCampaignId || campaign.counters.total > 0) return true;
  const root = await WhatsAppCampaignModel.findById(
    campaign.parentCampaignId,
  ).lean<WhatsAppCampaignDoc>();
  if (!root || root.recurrenceEnabled === false || ['paused', 'stopped'].includes(root.status))
    return false;
  const channel = await WhatsAppChannelModel.findOne({
    _id: campaign.channelId,
    accountId: campaign.accountId,
  }).lean<WhatsAppChannelDoc>();
  if (!channel || channel.status !== 'connected') return false;
  const variants = await loadVariants(campaign, channel.wabaId);
  if (variants.some((v) => v.status !== 'APPROVED')) return false;
  const estimate = await estimateCampaignDoc(campaign);
  if (!estimate.enough || !estimate.recipients) {
    await WhatsAppCampaignModel.updateOne(
      { _id: campaign._id, status: 'scheduled' },
      {
        $set: {
          status: estimate.recipients ? 'paused' : 'failed',
          pauseReason: estimate.recipients ? 'wallet_empty' : null,
        },
      },
    );
    return false;
  }
  const snap = await snapshotAudience(campaign, variants, now);
  await WhatsAppCampaignModel.updateOne(
    { _id: campaign._id, status: 'scheduled' },
    {
      $set: {
        'counters.total': snap.total,
        'counters.skipped': snap.skipped,
        'counters.skippedTotal': Object.values(snap.skipped).reduce((sum, n) => sum + (n ?? 0), 0),
      },
    },
  );
  return true;
};
