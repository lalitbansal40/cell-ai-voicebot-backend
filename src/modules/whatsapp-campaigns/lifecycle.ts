import { Types } from 'mongoose';

import { notifyAccount } from '../../core/realtime/notify';
import { WhatsAppCampaignRecipientModel } from '../../db/models/whatsapp-campaign-recipient.model';
import {
  WhatsAppCampaignModel,
  type WhatsAppCampaignDoc,
  type WaCampaignPauseReason,
} from '../../db/models/whatsapp-campaign.model';
import { getLogger } from '../../shared/logger';
import { recordAudit } from '../audit/audit.service';
import { notify, usersWithPermission } from '../notifications/notifications.service';
import { publishWhatsAppCampaignEvent } from '../webhooks/publish';

export const bellCreator = async (
  campaign: WhatsAppCampaignDoc,
  type: 'whatsapp_campaign.completed' | 'whatsapp_campaign.paused',
  body: string,
) => {
  try {
    const ids = new Set([campaign.createdBy.toString()]);
    if (type === 'whatsapp_campaign.paused') {
      for (const u of await usersWithPermission(campaign.accountId, 'account.update'))
        ids.add(u.userId.toString());
    }
    await notify({
      accountId: campaign.accountId,
      userIds: [...ids].map((id) => new Types.ObjectId(id)),
      type,
      title:
        type === 'whatsapp_campaign.completed'
          ? 'WhatsApp campaign finished'
          : 'WhatsApp campaign paused',
      body,
      link: `/campaigns/whatsapp/${campaign._id.toString()}`,
    });
  } catch (err) {
    getLogger().error({ err }, 'whatsapp campaign: bell failed');
  }
};

export const systemAudit = (
  campaign: WhatsAppCampaignDoc,
  action: 'whatsapp_campaign.paused' | 'whatsapp_campaign.completed',
  meta: Record<string, unknown>,
) =>
  recordAudit({
    accountId: campaign.accountId,
    actor: { type: 'system' },
    action,
    target: { type: 'whatsapp_campaign', id: campaign._id.toString() },
    meta,
  });

/**
 * Marks the campaign completed once dispatch is done — nothing left to claim. A `sending`
 * recipient that already has a message is in flight (Meta / the status webhook will move it
 * on), so it does not keep the campaign open; a `sending` without a message is a crash
 * mid-claim, and the sweep re-claims it, so that one keeps it open.
 */
export const maybeComplete = async (campaign: WhatsAppCampaignDoc, now: Date) => {
  const [pending, stuck] = await Promise.all([
    WhatsAppCampaignRecipientModel.exists({ campaignId: campaign._id, status: 'pending' }),
    WhatsAppCampaignRecipientModel.exists({
      campaignId: campaign._id,
      status: 'sending',
    }),
  ]);
  if (pending || stuck) return false;
  const done = await WhatsAppCampaignModel.findOneAndUpdate(
    { _id: campaign._id, status: { $in: ['running', 'waiting_for_limit'] } },
    { $set: { status: 'completed', finishedAt: now, nextBatchAt: null } },
    { returnDocument: 'after' },
  ).lean<WhatsAppCampaignDoc>();
  if (done) {
    await systemAudit(done, 'whatsapp_campaign.completed', {
      sent: done.counters.sent,
      failed: done.counters.failedTotal,
      chargedMicros: done.cost.chargedMicros,
    });
    await publishWhatsAppCampaignEvent('whatsapp_campaign.completed', done);
    await bellCreator(
      done,
      'whatsapp_campaign.completed',
      `${done.name}: ${String(done.counters.sent)} sent, ${String(done.counters.skippedTotal)} skipped, ${String(done.counters.failedTotal)} failed.`,
    );
  }
  return true;
};

/** Moves a running campaign to paused with a reason (bell + audit). */
export const autoPause = async (campaign: WhatsAppCampaignDoc, reason: WaCampaignPauseReason) => {
  const done = await WhatsAppCampaignModel.updateOne(
    { _id: campaign._id, status: { $in: ['running', 'waiting_for_limit'] } },
    { $set: { status: 'paused', pauseReason: reason } },
  );
  if (!done.modifiedCount) return;
  await systemAudit(campaign, 'whatsapp_campaign.paused', { reason });
  const text: Record<WaCampaignPauseReason, string> = {
    user: 'Paused.',
    wallet_empty: 'The wallet ran out. Add credit, then resume.',
    template_paused: 'WhatsApp paused or disabled the template.',
    quality_red: "The number's quality is low (red). Wait for it to recover, then resume.",
    channel_down: 'The WhatsApp number is not connected.',
  };
  await bellCreator(campaign, 'whatsapp_campaign.paused', `${campaign.name}: ${text[reason]}`);
  const latest = await WhatsAppCampaignModel.findById(campaign._id).lean<WhatsAppCampaignDoc>();
  if (latest) await publishWhatsAppCampaignEvent('whatsapp_campaign.paused', latest);
  if (latest)
    notifyAccount(latest.accountId.toString(), 'whatsapp_campaign.progress', {
      campaignId: latest._id.toString(),
      status: latest.status,
      counters: latest.counters,
    });
};
