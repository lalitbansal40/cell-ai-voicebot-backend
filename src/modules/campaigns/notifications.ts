import type { Types } from 'mongoose';

import { getEnv } from '../../config/env';
import { getEmail } from '../../core/email';
import { AccountModel } from '../../db/models/account.model';
import type { CampaignDoc, PauseReason } from '../../db/models/campaign.model';
import { RoleModel } from '../../db/models/role.model';
import { UserModel } from '../../db/models/user.model';
import { getLogger } from '../../shared/logger';
import { notify, type Recipient } from '../notifications/notifications.service';

/** Shown after "paused:" (PHASE_8_PROMPT §1 "Notifications"). */
export const PAUSE_REASON_LABELS: Record<PauseReason, string> = {
  manual: 'paused by a team member',
  wallet_empty: 'the wallet balance ran out',
  budget_reached: 'the campaign budget was reached',
  account_suspended: 'the account was suspended',
  too_many_failures: 'too many calls failed in a row',
  admin: 'paused by the platform team',
  flow_not_runnable: 'its flow can no longer run (an AI agent is switched off or audio is missing)',
};

const link = (campaignId: Types.ObjectId) => `/campaigns/${campaignId.toString()}`;

/** Starter + owners + admins of the account (active users, deduped). */
export const campaignRecipients = async (campaign: CampaignDoc): Promise<Recipient[]> => {
  const roles = await RoleModel.find({
    accountId: campaign.accountId,
    key: { $in: ['owner', 'admin'] },
  })
    .select({ _id: 1 })
    .lean<{ _id: Types.ObjectId }[]>();
  const users = await UserModel.find({
    accountId: campaign.accountId,
    status: 'active',
    $or: [
      { roleId: { $in: roles.map((r) => r._id) } },
      ...(campaign.startedBy ? [{ _id: campaign.startedBy }] : []),
    ],
  })
    .select({ email: 1, name: 1 })
    .lean<{ _id: Types.ObjectId; email: string; name: string }[]>();
  return users.map((u) => ({ userId: u._id, email: u.email, name: u.name }));
};

const send = async (
  campaign: CampaignDoc,
  input: { type: Parameters<typeof notify>[0]['type']; title: string; body: string },
  exclude: Types.ObjectId | null,
) => {
  const recipients = (await campaignRecipients(campaign)).filter(
    (r) => !exclude || !r.userId.equals(exclude),
  );
  await notify({
    accountId: campaign.accountId,
    userIds: recipients.map((r) => r.userId),
    ...input,
    link: link(campaign.parentId ?? campaign._id),
  });
  return recipients;
};

/**
 * In-app notifications (+ an email for automatic pauses, once per pause) after
 * a status change. `by` (a user's own action) is not notified. Never throws.
 */
export const notifyCampaignStatus = async (
  campaign: CampaignDoc,
  by: Types.ObjectId | null,
): Promise<void> => {
  try {
    if (campaign.status === 'completed' && !campaign.schedule.recurrence) {
      await send(
        campaign,
        {
          type: 'campaign.completed',
          title: 'Campaign finished',
          body: `Campaign "${campaign.name}" finished — ${String(campaign.stats.completed)} completed, ${String(campaign.stats.failed)} not reached.`,
        },
        by,
      );
      return;
    }
    if (campaign.status !== 'paused' || !campaign.pauseReason) return;
    const reason = PAUSE_REASON_LABELS[campaign.pauseReason];
    const recipients = await send(
      campaign,
      {
        type: 'campaign.paused',
        title: 'Campaign paused',
        body: `Campaign "${campaign.name}" paused: ${reason}.`,
      },
      by,
    );
    if (campaign.pauseReason === 'manual') return;
    const account = await AccountModel.findById(campaign.accountId)
      .select({ name: 1 })
      .lean<{ name: string }>();
    const campaignUrl = `${getEnv().FRONTEND_URL.replace(/\/+$/, '')}${link(campaign._id)}`;
    const pausedAt = campaign.pausedAt?.getTime() ?? 0;
    for (const r of recipients) {
      await getEmail().enqueue(
        'campaign.paused',
        r.email,
        {
          accountName: account?.name ?? 'Your account',
          campaignName: campaign.name,
          reason,
          dryRun: campaign.mode === 'dry_run',
          campaignUrl,
        },
        // once per pause and person
        {
          dedupeKey: `campaign-paused:${campaign._id.toString()}:${String(pausedAt)}:${r.userId.toString()}`,
        },
      );
    }
  } catch (err) {
    getLogger().error(
      { err, campaignId: campaign._id.toString() },
      'campaign: notification failed',
    );
  }
};

/** A recurring occurrence was skipped because the previous run is still active. */
export const notifyRunSkipped = async (parent: CampaignDoc): Promise<void> => {
  try {
    await send(
      parent,
      {
        type: 'campaign.run_skipped',
        title: 'Scheduled run skipped',
        body: `Run of "${parent.name}" skipped — the previous run is still active.`,
      },
      null,
    );
  } catch (err) {
    getLogger().error({ err, campaignId: parent._id.toString() }, 'campaign: notification failed');
  }
};
