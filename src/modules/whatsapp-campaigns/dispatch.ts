import { createHash } from 'node:crypto';

import { Types } from 'mongoose';

import { ContactModel, type ContactDoc } from '../../db/models/contact.model';
import { ConversationModel, type ConversationDoc } from '../../db/models/conversation.model';
import { MessageModel } from '../../db/models/message.model';
import {
  WhatsAppCampaignRecipientModel,
  type WhatsAppCampaignRecipientDoc,
} from '../../db/models/whatsapp-campaign-recipient.model';
import {
  WhatsAppCampaignModel,
  type WaCampaignPauseReason,
  type WaCampaignSkipReason,
  type WhatsAppCampaignDoc,
} from '../../db/models/whatsapp-campaign.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { WhatsAppTemplateModel } from '../../db/models/whatsapp-template.model';
import { AppError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';
import { recordAudit } from '../audit/audit.service';
import type { InboxContext } from '../inbox/context';
import { upsertConversation } from '../inbox/conversation-store';
import { sendMessage } from '../inbox/outbound.service';
import { notify, usersWithPermission } from '../notifications/notifications.service';
import type { CallPermissionsService } from '../whatsapp-calling/permissions.service';

import { variablesFor, type VariantInfo } from './audience';
import { allowedNow } from './pacing';
import { emitProgress, trackCampaignMessage } from './tracking';

export const DISPATCH_BATCH = 100;
/** A `sending` claim older than this is a crash: the sweep puts it back to `pending`. */
export const STALE_CLAIM_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

/** Stable UUID per campaign + contact (`wac:<campaignId>:<contactId>`): a retry never sends twice. */
export const campaignClientId = (campaignId: string, contactId: string): string => {
  const hex = createHash('sha1').update(`wac:${campaignId}:${contactId}`).digest('hex');
  const variant = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export interface DispatchDeps {
  ix: InboxContext;
  permissions?: CallPermissionsService;
  now?: () => Date;
  /** Tests: no waiting between batches. */
  sleep?: (ms: number) => Promise<void>;
}

/** Variant templates of a campaign (approved, on the campaign's WABA). */
export const loadVariants = async (
  campaign: Pick<WhatsAppCampaignDoc, 'accountId' | 'variants'>,
  wabaId: string,
): Promise<VariantInfo[]> => {
  const templates = await WhatsAppTemplateModel.find({
    _id: { $in: campaign.variants.map((v) => v.templateId) },
    accountId: campaign.accountId,
    wabaId,
  })
    .select({ category: 1, purpose: 1, variables: 1, status: 1 })
    .lean<
      {
        _id: Types.ObjectId;
        category: string;
        purpose?: string;
        status: string;
        variables: { key: string }[];
      }[]
    >();
  const byId = new Map(templates.map((t) => [t._id.toString(), t]));
  return campaign.variants.flatMap((v) => {
    const t = byId.get(v.templateId.toString());
    return t
      ? [
          {
            key: v.key,
            templateId: t._id,
            category: t.category,
            purpose: t.purpose ?? 'general',
            keys: [...new Set(t.variables.map((x) => x.key))],
            status: t.status,
          },
        ]
      : [];
  });
};

/** People the number started a business conversation with in the last 24 h (tier usage). */
export const sentLast24h = async (channelId: Types.ObjectId, now: Date): Promise<number> => {
  const rows = await MessageModel.aggregate<{ n: number }>([
    {
      $match: {
        channelId,
        direction: 'out',
        type: 'template',
        createdAt: { $gte: new Date(now.getTime() - DAY_MS) },
      },
    },
    { $group: { _id: '$contactId' } },
    { $count: 'n' },
  ]);
  return rows[0]?.n ?? 0;
};

const pauseReasonOf = (
  channel: WhatsAppChannelDoc | null,
  variants: VariantInfo[],
): WaCampaignPauseReason | null => {
  if (!channel || channel.status !== 'connected') return 'channel_down';
  if (channel.qualityRating === 'RED') return 'quality_red';
  if (variants.some((v) => v.status !== 'APPROVED')) return 'template_paused';
  return null;
};

const bellCreator = async (
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

const systemAudit = (
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
  await emitProgress(campaign._id, true);
};

/**
 * Marks the campaign completed once dispatch is done — nothing left to claim. A `sending`
 * recipient that already has a message is in flight (Meta / the status webhook will move it
 * on), so it does not keep the campaign open; a `sending` without a message is a crash
 * mid-claim, and the sweep re-claims it, so that one keeps it open.
 */
const maybeComplete = async (campaign: WhatsAppCampaignDoc, now: Date) => {
  const [pending, stuck] = await Promise.all([
    WhatsAppCampaignRecipientModel.exists({ campaignId: campaign._id, status: 'pending' }),
    WhatsAppCampaignRecipientModel.exists({
      campaignId: campaign._id,
      status: 'sending',
      messageId: null,
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
    await bellCreator(
      done,
      'whatsapp_campaign.completed',
      `${done.name}: ${String(done.counters.sent)} sent, ${String(done.counters.skippedTotal)} skipped, ${String(done.counters.failedTotal)} failed.`,
    );
    await emitProgress(done._id, true);
  }
  return true;
};

const skipRecipient = async (r: WhatsAppCampaignRecipientDoc, reason: WaCampaignSkipReason) => {
  const moved = await WhatsAppCampaignRecipientModel.updateOne(
    { _id: r._id, status: 'sending' },
    { $set: { status: 'skipped', skipReason: reason, claimedAt: null } },
  );
  if (moved.modifiedCount) {
    await WhatsAppCampaignModel.updateOne(
      { _id: r.campaignId },
      {
        $inc: {
          'counters.skippedTotal': 1,
          [`counters.skipped.${reason}`]: 1,
          'counters.queued': -1,
        },
      },
    );
  }
};

/**
 * The `whatsapp-campaign.dispatch` job: batches of 100 claimed `pending → sending`, each
 * sent through the existing template send path (priced, held and charged from the wallet;
 * consent variants through the call permission request), paced by the messaging tier and
 * Meta's throughput. Checks pause / stop and the auto-pause rules between batches. A crash
 * leaves `sending` claims: the sweep returns them to `pending`; the stable `clientId` means
 * a message that was already created is never sent twice.
 */
export const dispatchCampaign = async (
  deps: DispatchDeps,
  campaignId: string,
): Promise<{ status: string; sent: number }> => {
  const now = () => deps.now?.() ?? new Date();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let sent = 0;
  for (;;) {
    const campaign = await WhatsAppCampaignModel.findById(campaignId).lean<WhatsAppCampaignDoc>();
    if (!campaign) return { status: 'missing', sent };
    if (campaign.status !== 'running') return { status: campaign.status, sent };
    const channel = await WhatsAppChannelModel.findById(
      campaign.channelId,
    ).lean<WhatsAppChannelDoc>();
    const variants = channel ? await loadVariants(campaign, channel.wabaId) : [];
    const blocked = pauseReasonOf(channel, variants);
    if (blocked || !channel) {
      await autoPause(campaign, blocked ?? 'channel_down');
      return { status: 'paused', sent };
    }
    const room = allowedNow({
      tier: channel.messagingLimitTier,
      sentLast24h: await sentLast24h(channel._id, now()),
    });
    if (room <= 0) {
      const next = new Date(now().getTime() + 60 * 60_000);
      await WhatsAppCampaignModel.updateOne(
        { _id: campaign._id, status: 'running' },
        { $set: { status: 'waiting_for_limit', nextBatchAt: next } },
      );
      await emitProgress(campaign._id, true);
      return { status: 'waiting_for_limit', sent };
    }
    const size = Math.min(DISPATCH_BATCH, room);
    const claimed: WhatsAppCampaignRecipientDoc[] = [];
    for (let i = 0; i < size; i += 1) {
      const r = await WhatsAppCampaignRecipientModel.findOneAndUpdate(
        { campaignId: campaign._id, status: 'pending' },
        { $set: { status: 'sending', claimedAt: now() }, $inc: { attempts: 1 } },
        { sort: { _id: 1 }, returnDocument: 'after' },
      ).lean<WhatsAppCampaignRecipientDoc>();
      if (!r) break;
      claimed.push(r);
    }
    if (!claimed.length) {
      await maybeComplete(campaign, now());
      return { status: 'completed', sent };
    }
    await WhatsAppCampaignModel.updateOne(
      { _id: campaign._id },
      { $inc: { 'counters.queued': claimed.length } },
    );
    const contacts = await ContactModel.find({
      _id: { $in: claimed.map((r) => r.contactId) },
      accountId: campaign.accountId,
      deletedAt: null,
    })
      .select({ phoneE164: 1, name: 1, variables: 1, whatsapp: 1, dnd: 1, optedOutAt: 1 })
      .lean<ContactDoc[]>();
    const contactOf = new Map(contacts.map((c) => [c._id.toString(), c]));
    const variantOf = new Map(variants.map((v) => [v.key, v]));
    const actor = { accountId: campaign.accountId, userId: campaign.createdBy };
    for (const r of claimed) {
      const contact = contactOf.get(r.contactId.toString());
      const v =
        variantOf.get(campaign.abWinner?.winner ?? r.variant) ??
        variantOf.get(r.variant) ??
        variants[0];
      if (!contact || contact.dnd || contact.optedOutAt) {
        await skipRecipient(
          r,
          contact?.dnd ? 'dnd' : contact?.optedOutAt ? 'opted_out' : 'suppressed',
        );
        continue;
      }
      if (!v) {
        await skipRecipient(r, 'missing_variable');
        continue;
      }
      const values = variablesFor(contact, v.keys, campaign.variables);
      if (values === null) {
        await skipRecipient(r, 'missing_variable');
        continue;
      }
      const clientId = campaignClientId(campaign._id.toString(), contact._id.toString());
      try {
        let messageId: Types.ObjectId;
        if (v.purpose === 'call_permission' && deps.permissions) {
          const res = await deps.permissions.request(
            {
              type: 'user',
              id: campaign.createdBy,
              userId: campaign.createdBy,
              accountId: campaign.accountId,
              impersonatorId: null,
              ip: null,
            },
            {
              channelId: campaign.channelId.toString(),
              contactId: contact._id.toString(),
              forceTemplate: true,
              bulk: true,
              templateId: v.templateId.toString(),
              ...(Object.keys(values).length ? { variables: values } : {}),
              clientId,
            },
          );
          messageId = new Types.ObjectId(res.messageId);
        } else {
          const waId = contact.whatsapp?.waId ?? contact.phoneE164.replace(/\D/g, '');
          const conversation: ConversationDoc =
            (await ConversationModel.findOne({
              accountId: campaign.accountId,
              channelId: campaign.channelId,
              waId,
            }).lean<ConversationDoc>()) ??
            (await upsertConversation({
              key: { accountId: campaign.accountId, channelId: campaign.channelId, waId },
              contactId: contact._id,
              source: 'outbound',
            }));
          const out = await sendMessage(
            deps.ix,
            actor,
            conversation._id.toString(),
            {
              type: 'template',
              templateId: v.templateId.toString(),
              ...(Object.keys(values).length ? { variables: values } : {}),
              clientId,
            },
            { bulk: true, origin: 'system', externalRef: `wac:${campaign._id.toString()}` },
          );
          messageId = out.message._id;
        }
        await WhatsAppCampaignRecipientModel.updateOne(
          { _id: r._id },
          { $set: { messageId, sentAt: now(), variant: v.key } },
        );
        sent += 1;
        // the send job may already have moved the message on
        const m = await MessageModel.findById(messageId)
          .select({ status: 1, error: 1 })
          .lean<{ _id: Types.ObjectId; status: never; error: { code?: number } | null }>();
        if (m) await trackCampaignMessage(m);
      } catch (err) {
        const code = err instanceof AppError ? err.code : null;
        if (code === 'WALLET_INSUFFICIENT_BALANCE' || code === 'WALLET_BUDGET_EXCEEDED') {
          // back to pending: it goes out after the wallet is topped up and the campaign resumed
          await WhatsAppCampaignRecipientModel.updateOne(
            { _id: r._id },
            { $set: { status: 'pending', claimedAt: null } },
          );
          await WhatsAppCampaignRecipientModel.updateMany(
            { campaignId: campaign._id, status: 'sending', messageId: null },
            { $set: { status: 'pending', claimedAt: null } },
          );
          await WhatsAppCampaignModel.updateOne(
            { _id: campaign._id },
            { $set: { 'counters.queued': 0 } },
          );
          await autoPause(campaign, 'wallet_empty');
          return { status: 'paused', sent };
        }
        if (code === 'WHATSAPP_CALL_PERMISSION_EXISTS') await skipRecipient(r, 'already_allowed');
        else if (code === 'WHATSAPP_CALL_PERMISSION_LIMIT') await skipRecipient(r, 'meta_limit');
        else if (code === 'CALL_NOT_ALLOWED') await skipRecipient(r, 'no_whatsapp');
        else {
          await WhatsAppCampaignRecipientModel.updateOne(
            { _id: r._id },
            { $set: { status: 'failed', errorCode: null } },
          );
          await WhatsAppCampaignModel.updateOne(
            { _id: campaign._id },
            {
              $inc: {
                'counters.failedTotal': 1,
                'counters.failed.send_error': 1,
                'counters.queued': -1,
              },
            },
          );
          getLogger().warn({ err, campaignId }, 'whatsapp campaign: send failed');
        }
      }
    }
    await emitProgress(campaign._id);
    // Yield between batches. Actual provider attempts are paced in the shared send processor.
    await sleep(0);
  }
};

/**
 * `whatsapp-campaign.sweep` (every 5 min): scheduled starts, stale claims back to pending,
 * campaigns waiting for the tier, A/B winners. Returns the campaigns to dispatch.
 */
export const sweepCampaigns = async (now = new Date()): Promise<string[]> => {
  await WhatsAppCampaignRecipientModel.updateMany(
    {
      status: 'sending',
      messageId: null,
      claimedAt: { $lt: new Date(now.getTime() - STALE_CLAIM_MS) },
    },
    { $set: { status: 'pending', claimedAt: null } },
  );
  const due = await WhatsAppCampaignModel.find({
    $or: [
      { status: 'scheduled', 'schedule.at': { $lte: now } },
      { status: 'waiting_for_limit', nextBatchAt: { $lte: now } },
      { status: 'running', updatedAt: { $lt: new Date(now.getTime() - STALE_CLAIM_MS) } },
    ],
  })
    .select({ _id: 1, status: 1 })
    .lean<{ _id: Types.ObjectId; status: WhatsAppCampaignDoc['status'] }[]>();
  for (const c of due) {
    if (c.status !== 'running') {
      await WhatsAppCampaignModel.updateOne(
        { _id: c._id, status: c.status },
        {
          $set: {
            status: 'running',
            nextBatchAt: null,
            ...(c.status === 'scheduled' ? { startedAt: now } : {}),
          },
        },
      );
    }
  }
  await decideWinners(now);
  return due.map((c) => c._id.toString());
};

/** A/B: after `afterHours`, the variant with the best read (or reply) rate wins (ties → A). */
export const decideWinners = async (now = new Date()): Promise<number> => {
  const open = await WhatsAppCampaignModel.find({
    'abWinner.decidedAt': null,
    'abWinner.metric': { $in: ['read', 'reply'] },
    status: { $in: ['running', 'waiting_for_limit', 'paused'] },
  }).lean<WhatsAppCampaignDoc[]>();
  let decided = 0;
  for (const c of open) {
    if (!c.abWinner || !c.startedAt) continue;
    if (now.getTime() - c.startedAt.getTime() < c.abWinner.afterHours * 3_600_000) continue;
    const rows = await WhatsAppCampaignRecipientModel.aggregate<{
      _id: 'A' | 'B' | 'C';
      sent: number;
      read: number;
      replied: number;
    }>([
      { $match: { campaignId: c._id, status: { $in: ['sent', 'delivered', 'read'] } } },
      {
        $group: {
          _id: '$variant',
          sent: { $sum: 1 },
          read: { $sum: { $cond: [{ $eq: ['$status', 'read'] }, 1, 0] } },
          replied: { $sum: { $cond: [{ $ne: ['$repliedAt', null] }, 1, 0] } },
        },
      },
    ]);
    const score = (r: { sent: number; read: number; replied: number }) =>
      r.sent ? (c.abWinner?.metric === 'reply' ? r.replied : r.read) / r.sent : 0;
    const best = [...rows].sort((a, b) => score(b) - score(a) || a._id.localeCompare(b._id))[0];
    await WhatsAppCampaignModel.updateOne(
      { _id: c._id },
      { $set: { 'abWinner.decidedAt': now, 'abWinner.winner': best?._id ?? 'A' } },
    );
    decided += 1;
  }
  return decided;
};
