import { INBOX_LIMITS } from '../../config/limits';
import { mapSendError, metaTime, type MetaStatus } from '../../core/meta';
import { MessageModel, type MessageDoc } from '../../db/models/message.model';
import type { WhatsAppChannelDoc } from '../../db/models/whatsapp-channel.model';
import { getLogger } from '../../shared/logger';

import { applyChannelEffect } from './channel-effects';
import type { InboxContext } from './context';
import { syncLastMessageStatus } from './conversation-store';
import { emitConversation, emitMessageUpdated } from './events';
import { canMoveTo, fromMetaStatus } from './status-rank';

export interface StatusResult {
  applied: number;
  ignored: number;
  /** Statuses for messages this app didn't send (another tool on the number). */
  unknown: number;
}

const pricingOf = (s: MetaStatus) =>
  s.pricing || s.conversation
    ? {
        billable: s.pricing?.billable ?? null,
        model: s.pricing?.pricing_model ?? null,
        category: s.pricing?.category ?? null,
        type: s.pricing?.type ?? null,
        subtype: s.pricing?.subtype ?? null,
        conversationId: s.conversation?.id ?? null,
        conversationOrigin: s.conversation?.origin?.type ?? null,
      }
    : null;

/** Applies one Meta status to its message (monotonic, deduped). */
const applyOne = async (
  ix: InboxContext,
  channel: WhatsAppChannelDoc,
  s: MetaStatus,
): Promise<'applied' | 'ignored' | 'unknown'> => {
  const next = fromMetaStatus(s.status);
  if (!next) return 'ignored';
  const at = metaTime(s.timestamp) ?? new Date();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await MessageModel.findOne({
      accountId: channel.accountId,
      channelId: channel._id,
      waMessageId: s.id,
    })
      .select({ status: 1, direction: 1, conversationId: 1, pricing: 1 })
      .lean<Pick<MessageDoc, '_id' | 'status' | 'direction' | 'conversationId' | 'pricing'>>();
    if (!current) return 'unknown';
    const pricing = pricingOf(s);
    if (!canMoveTo(current.status, next, current.direction)) {
      // a late duplicate may still carry pricing (Phase 11 bills from it)
      if (pricing && !current.pricing) {
        await MessageModel.updateOne({ _id: current._id }, { $set: { pricing } });
      }
      return 'ignored';
    }
    const set: Record<string, unknown> = { status: next };
    if (pricing) set.pricing = pricing;
    let effect: ReturnType<typeof mapSendError>['channelEffect'] = 'none';
    if (next === 'failed') {
      const err = s.errors?.[0];
      const mapped = mapSendError({ code: err?.code ?? null });
      set.error = {
        code: err?.code ?? null,
        title: err?.title?.slice(0, 300) ?? null,
        reason: mapped.reason,
      };
      effect = mapped.channelEffect;
    } else if (current.status === 'failed') {
      set.error = null;
    }
    const updated = await MessageModel.findOneAndUpdate(
      { _id: current._id, status: current.status },
      {
        $set: set,
        $push: {
          statusHistory: { $each: [{ status: next, at }], $slice: -INBOX_LIMITS.statusHistoryMax },
        },
      },
      { returnDocument: 'after' },
    ).lean<MessageDoc>();
    if (!updated) continue; // another status won the race — re-read and re-check
    emitMessageUpdated(updated);
    const conv = await syncLastMessageStatus(updated);
    if (conv) emitConversation(conv);
    await applyChannelEffect(ix.wa, channel._id, effect);
    return 'applied';
  }
  /* c8 ignore next -- three lost races in a row */
  return 'ignored';
};

/** `value.statuses[]` of a `messages` webhook (PHASE_10_PLAN §1e). */
export const applyStatuses = async (
  ix: InboxContext,
  channel: WhatsAppChannelDoc,
  statuses: MetaStatus[],
): Promise<StatusResult> => {
  const result: StatusResult = { applied: 0, ignored: 0, unknown: 0 };
  for (const s of statuses) result[await applyOne(ix, channel, s)] += 1;
  if (result.unknown) {
    getLogger().info(
      { channelId: channel._id.toString(), unknown: result.unknown },
      'inbox: statuses for unknown messages',
    );
  }
  return result;
};
