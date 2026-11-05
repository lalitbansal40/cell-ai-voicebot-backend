import type { Types } from 'mongoose';

import { notifyAccount } from '../../core/realtime/notify';
import type { MessageStatus } from '../../db/models/message.model';
import {
  WhatsAppCampaignRecipientModel,
  type WaRecipientStatus,
  type WhatsAppCampaignRecipientDoc,
} from '../../db/models/whatsapp-campaign-recipient.model';
import { WhatsAppCampaignModel } from '../../db/models/whatsapp-campaign.model';
import { withTransaction } from '../../db/transaction';
import { getLogger } from '../../shared/logger';

import { maybeComplete } from './lifecycle';

/** Forward-only order of a recipient (a late `delivered` never undoes `read`). */
const RANK: Record<WaRecipientStatus, number> = {
  pending: 0,
  sending: 1,
  skipped: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  failed: 2,
};

const fromMessage = (s: MessageStatus): WaRecipientStatus | null =>
  s === 'accepted' || s === 'sent'
    ? 'sent'
    : s === 'delivered'
      ? 'delivered'
      : s === 'read'
        ? 'read'
        : s === 'failed'
          ? 'failed'
          : null;

const lastEmit = new Map<string, number>();

/** Account-level `whatsapp_campaign.progress`, at most once a second per campaign. */
export const emitProgress = async (campaignId: Types.ObjectId, force = false): Promise<void> => {
  const key = campaignId.toString();
  const now = Date.now();
  if (!force && now - (lastEmit.get(key) ?? 0) < 1_000) return;
  lastEmit.set(key, now);
  const c = await WhatsAppCampaignModel.findById(campaignId)
    .select({ accountId: 1, status: 1, counters: 1 })
    .lean<{ accountId: Types.ObjectId; status: string; counters: unknown }>();
  if (!c) return;
  notifyAccount(c.accountId.toString(), 'whatsapp_campaign.progress', {
    campaignId: key,
    status: c.status,
    counters: c.counters,
  });
};

/**
 * A campaign message changed status (send job or Meta's webhook): the recipient moves
 * forward and the campaign counters follow with `$inc` (never recounted). Never throws.
 */
export const trackCampaignMessage = async (message: {
  _id: Types.ObjectId;
  status: MessageStatus;
  error?: { code?: number | null } | null;
}): Promise<void> => {
  try {
    const next = fromMessage(message.status);
    if (!next) return;
    const campaignId = await withTransaction(async (session) => {
      const r = await WhatsAppCampaignRecipientModel.findOne({ messageId: message._id })
        .select({ status: 1, campaignId: 1, sentCounted: 1, errorCode: 1 })
        .session(session)
        .lean<
          Pick<
            WhatsAppCampaignRecipientDoc,
            '_id' | 'status' | 'campaignId' | 'sentCounted' | 'errorCode'
          >
        >();
      if (!r || r.status === 'skipped') return null;
      if (
        RANK[next] <= RANK[r.status] &&
        !(next === 'failed' && ['sending', 'sent'].includes(r.status))
      )
        return null;
      const code = message.error?.code ?? null;
      const moved = await WhatsAppCampaignRecipientModel.updateOne(
        { _id: r._id, status: r.status },
        {
          $set: {
            status: next,
            ...(next === 'failed'
              ? { errorCode: code }
              : {
                  sentCounted: true,
                  errorCode: null,
                  ...(!r.sentCounted ? { sentAt: new Date() } : {}),
                }),
          },
        },
        { session },
      );
      if (!moved.modifiedCount) return null;
      // a status can jump (sent → read): count every step it passed
      const inc: Record<string, number> = {};
      const steps: WaRecipientStatus[] = ['sent', 'delivered', 'read'];
      if (next === 'failed') {
        inc['counters.failedTotal'] = 1;
        inc[`counters.failed.${String(code ?? 'unknown')}`] = 1;
        if (r.status === 'sending') inc['counters.queued'] = -1;
      } else {
        if (r.status === 'failed') {
          inc['counters.failedTotal'] = -1;
          inc[`counters.failed.${String(r.errorCode ?? 'unknown')}`] = -1;
        }
        for (const s of steps) {
          if ((s === 'sent' ? !r.sentCounted : RANK[s] > RANK[r.status]) && RANK[s] <= RANK[next])
            inc[`counters.${s}`] = 1;
        }
        if (r.status === 'sending') inc['counters.queued'] = -1;
      }
      await WhatsAppCampaignModel.updateOne({ _id: r.campaignId }, { $inc: inc }, { session });
      return r.campaignId;
    });
    if (!campaignId) return;
    const campaign = await WhatsAppCampaignModel.findById(campaignId).lean();
    if (campaign) await maybeComplete(campaign, new Date());
    await emitProgress(campaignId);
  } catch (err) {
    getLogger().error({ err }, 'whatsapp campaign: status tracking failed');
  }
};

/** An inbound message within 72 h of a campaign send counts as one reply (once). */
export const trackCampaignReply = async (input: {
  accountId: Types.ObjectId;
  contactId: Types.ObjectId;
  at: Date;
}): Promise<void> => {
  try {
    const campaignId = await withTransaction(async (session) => {
      const r = await WhatsAppCampaignRecipientModel.findOneAndUpdate(
        {
          accountId: input.accountId,
          contactId: input.contactId,
          repliedAt: null,
          sentAt: { $gte: new Date(input.at.getTime() - 72 * 3_600_000), $lte: input.at },
          status: { $in: ['sent', 'delivered', 'read'] },
        },
        { $set: { repliedAt: input.at } },
        { sort: { sentAt: -1 }, projection: { campaignId: 1 }, session },
      ).lean<{ campaignId: Types.ObjectId }>();
      if (!r) return null;
      await WhatsAppCampaignModel.updateOne(
        { _id: r.campaignId },
        { $inc: { 'counters.replied': 1 } },
        { session },
      );
      return r.campaignId;
    });
    if (!campaignId) return;
    await emitProgress(campaignId);
  } catch (err) {
    getLogger().error({ err }, 'whatsapp campaign: reply tracking failed');
  }
};
