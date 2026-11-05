import { CampaignContactModel } from '../../db/models/campaign-contact.model';
import { CampaignModel } from '../../db/models/campaign.model';
import type { WhatsAppCallPermissionDoc } from '../../db/models/whatsapp-call-permission.model';

/** Wake only existing audience rows on an active ask-first campaign for this sender. */
export const onCampaignCallPermission = async (
  permission: WhatsAppCallPermissionDoc,
  now = new Date(),
) => {
  if (
    permission.status !== 'permanent' &&
    !(permission.status === 'temporary' && permission.expiresAt && permission.expiresAt > now)
  )
    return;
  const campaigns = await CampaignModel.find({
    accountId: permission.accountId,
    channelId: permission.channelId,
    line: 'whatsapp',
    status: 'running',
    askPermissionFirst: { $ne: null },
    $or: [{ 'schedule.endAt': null }, { 'schedule.endAt': { $gt: now } }],
  })
    .select({ _id: 1 })
    .lean();
  if (!campaigns.length) return;
  await CampaignContactModel.updateMany(
    {
      accountId: permission.accountId,
      campaignId: { $in: campaigns.map((c) => c._id) },
      contactId: permission.contactId,
      status: { $in: ['pending', 'retry_wait'] },
    },
    { $set: { nextAttemptAt: now, waitReason: null } },
  );
};
