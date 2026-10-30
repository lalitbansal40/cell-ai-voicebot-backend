import { Types } from 'mongoose';

import { CallModel, type CallDoc } from '../../db/models/call.model';
import { ContactModel, type ContactDoc } from '../../db/models/contact.model';
import { OutcomeRuleModel } from '../../db/models/outcome-rule.model';
import {
  PostCallMessageModel,
  type PostCallMessageDoc,
  type PostCallSkipReason,
} from '../../db/models/post-call-message.model';
import { WA_ACTIVE_STATUSES, WhatsAppChannelModel } from '../../db/models/whatsapp-channel.model';
import {
  WhatsAppTemplateModel,
  type WhatsAppTemplateDoc,
} from '../../db/models/whatsapp-template.model';
import { AppError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';
import type { InboxContext } from '../inbox/context';
import { startConversation } from '../inbox/conversations.service';
import { sendMessage } from '../inbox/outbound.service';

/** Send-time refusals of the inbox / template path → our skip reasons. */
const REASON_OF: Record<string, PostCallSkipReason> = {
  WALLET_INSUFFICIENT_BALANCE: 'low_balance',
  WALLET_BUDGET_EXCEEDED: 'low_balance',
  WHATSAPP_FREQUENCY_LIMIT: 'marketing_limit',
  TEMPLATE_NOT_FOUND: 'no_template',
  TEMPLATE_NOT_APPROVED: 'template_not_approved',
  TEMPLATE_PAUSED: 'template_not_approved',
  WHATSAPP_CHANNEL_NOT_READY: 'no_number',
};

/** Marketing blocks name the cause in `details[0].message`. */
const blockedReason = (err: AppError): PostCallSkipReason => {
  const why = err.details?.[0]?.message;
  return why === 'dnd' ? 'dnd' : 'opted_out';
};

/**
 * `postcall.send` (delayed until `scheduledAt`): checks everything again (contact
 * phone, opt-out, DND, rule still on, number connected, template approved) then the
 * inbox template send — wallet hold, marketing limit, `origin: system`, the call's
 * `externalRef`. A row leaves `scheduled` exactly once (retry-safe: the client id is
 * the row id, the status update is compare-and-set). Texts / phones never logged.
 */
export const processPostCallSend = async (
  ix: InboxContext,
  postCallMessageId: string,
): Promise<{ status: string; reason?: string }> => {
  const row = await PostCallMessageModel.findById(postCallMessageId).lean<PostCallMessageDoc>();
  if (!row || row.status !== 'scheduled') return { status: 'done' };
  const finish = async (set: Partial<PostCallMessageDoc>) => {
    await PostCallMessageModel.updateOne({ _id: row._id, status: 'scheduled' }, { $set: set });
    getLogger().info(
      { postCallMessageId, status: set.status, reason: set.reason ?? null },
      'post-call: message handled',
    );
    return { status: set.status as string, ...(set.reason ? { reason: set.reason } : {}) };
  };
  const skip = (reason: PostCallSkipReason) => finish({ status: 'skipped', reason });

  if (row.ruleId && !(await OutcomeRuleModel.exists({ _id: row.ruleId, active: true })))
    return skip('rule_disabled');
  const contact = row.contactId
    ? await ContactModel.findOne({ _id: row.contactId, accountId: row.accountId, deletedAt: null })
        .select({ phoneE164: 1, optedOutAt: 1, dnd: 1 })
        .lean<Pick<ContactDoc, '_id' | 'phoneE164' | 'optedOutAt' | 'dnd'>>()
    : null;
  if (!contact?.phoneE164) return skip('no_phone');
  if (contact.optedOutAt) return skip('opted_out');
  if (contact.dnd) return skip('dnd');
  if (
    !row.channelId ||
    !(await WhatsAppChannelModel.exists({
      _id: row.channelId,
      accountId: row.accountId,
      status: { $in: WA_ACTIVE_STATUSES },
    }))
  )
    return skip('no_number');
  const template = row.templateId
    ? await WhatsAppTemplateModel.findOne({
        _id: row.templateId,
        accountId: row.accountId,
        deletedAt: null,
      })
        .select({ status: 1 })
        .lean<Pick<WhatsAppTemplateDoc, 'status'>>()
    : null;
  if (!template) return skip('no_template');
  if (template.status !== 'APPROVED') return skip('template_not_approved');

  const call = await CallModel.findById(row.callId)
    .select({ externalRef: 1, startedBy: 1 })
    .lean<Pick<CallDoc, 'externalRef' | 'startedBy'>>();
  // a system send: no person, the audit names the system
  const actor = {
    accountId: row.accountId,
    userId: call?.startedBy ?? new Types.ObjectId('000000000000000000000000'),
    type: 'system' as const,
    id: null,
  };
  try {
    const conv = await startConversation(ix, actor, {
      channelId: row.channelId.toString(),
      contactId: contact._id.toString(),
    });
    const sent = await sendMessage(
      ix,
      actor,
      conv.id,
      {
        type: 'template',
        templateId: row.templateId?.toString() ?? '',
        variables: row.variables,
        clientId: `postcall-${row._id.toString()}`,
      },
      { origin: 'system', externalRef: call?.externalRef ?? null },
    );
    return await finish({ status: 'sent', messageId: sent.message._id, sentAt: new Date() });
  } catch (err) {
    if (err instanceof AppError) {
      if (err.code === 'TEMPLATE_MARKETING_BLOCKED') return skip(blockedReason(err));
      const reason = REASON_OF[err.code];
      if (reason) return skip(reason);
      if (err.status < 500)
        return finish({ status: 'failed', reason: err.code.toLowerCase().slice(0, 60) });
    }
    throw err; // a retry of the job (the row is still scheduled)
  }
};
