import { Types } from 'mongoose';

import type { QueuedMessage } from '../../core/engine/types';
import { isDuplicateKeyError } from '../../db/errors';
import { CallModel, type CallDoc } from '../../db/models/call.model';
import { PostCallMessageModel } from '../../db/models/post-call-message.model';
import {
  WA_ACTIVE_STATUSES,
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import {
  WhatsAppTemplateModel,
  type WhatsAppTemplateDoc,
} from '../../db/models/whatsapp-template.model';
import { getLogger } from '../../shared/logger';

import { getPostCallJobs } from './jobs';

/** The chosen number, or the account's only connected one (null = none / ambiguous). */
export const channelFor = async (
  accountId: Types.ObjectId,
  channelId: Types.ObjectId | string | null | undefined,
): Promise<Pick<WhatsAppChannelDoc, '_id' | 'wabaId'> | null> => {
  const rows = await WhatsAppChannelModel.find({
    accountId,
    status: { $in: WA_ACTIVE_STATUSES },
    ...(channelId ? { _id: new Types.ObjectId(String(channelId)) } : {}),
  })
    .select({ _id: 1, wabaId: 1 })
    .limit(2)
    .lean<Pick<WhatsAppChannelDoc, '_id' | 'wabaId'>[]>();
  return rows.length === 1 ? (rows[0] ?? null) : null;
};

/** The template by name + language on the number's WABA (any status — the send re-checks). */
export const templateByName = (
  accountId: Types.ObjectId,
  wabaId: string,
  name: string,
  language: string,
) =>
  WhatsAppTemplateModel.findOne({ accountId, wabaId, name, language, deletedAt: null })
    .select({ _id: 1, name: 1, language: 1, variables: 1, status: 1 })
    .lean<Pick<WhatsAppTemplateDoc, '_id' | 'name' | 'language' | 'variables' | 'status'>>();

/** Positional values → the template's variable keys, in order. */
export const variablesFor = (
  template: Pick<WhatsAppTemplateDoc, 'variables'> | null,
  values: string[],
): Record<string, string> => {
  const keys = template?.variables.length
    ? template.variables.map((v) => v.key)
    : values.map((_, i) => String(i + 1));
  return Object.fromEntries(keys.map((k, i) => [k, values[i] ?? '']));
};

/** Stores one post-call message (unique per call + source) and queues its send. */
export const schedulePostCall = async (row: {
  accountId: Types.ObjectId;
  callId: Types.ObjectId;
  contactId: Types.ObjectId | null;
  source: string;
  ruleId?: Types.ObjectId | null;
  channelId: Types.ObjectId | null;
  templateId: Types.ObjectId | null;
  templateName: string;
  language: string;
  variables: Record<string, string>;
  scheduledAt: Date;
  now: Date;
}): Promise<boolean> => {
  try {
    const { now, ...doc } = row;
    // a call without a contact (a browser test call) never gets a message
    if (!doc.contactId) {
      await PostCallMessageModel.create({
        ...doc,
        ruleId: doc.ruleId ?? null,
        status: 'skipped',
        reason: 'call_not_eligible',
      });
      return true;
    }
    const created = await PostCallMessageModel.create({ ...doc, ruleId: doc.ruleId ?? null });
    await getPostCallJobs().enqueueSend(
      created._id.toString(),
      row.scheduledAt.getTime() - now.getTime(),
    );
    return true;
  } catch (err) {
    // this call + source was already handled (settle retry, concurrent evaluation)
    if (isDuplicateKeyError(err)) return false;
    throw err;
  }
};

/**
 * At call settle (Phase 15, PHASE_15_PLAN §1d): every WhatsApp entry the flow queued
 * (`outcome.messages`, "Send WhatsApp" steps) becomes a post-call message sent now.
 * SMS entries stay queued (SMS starts with phone lines). Never throws into the call.
 */
export const collectFlowMessages = async (callId: string, now = new Date()): Promise<number> => {
  try {
    const call = await CallModel.findById(callId)
      .select({ accountId: 1, contactId: 1, outcome: 1 })
      .lean<Pick<CallDoc, '_id' | 'accountId' | 'contactId' | 'outcome'>>();
    const queued = (
      (call?.outcome as { messages?: QueuedMessage[] } | undefined)?.messages ?? []
    ).filter((m) => m.channel === 'whatsapp' && m.templateName);
    if (!call || !queued.length) return 0;
    let scheduled = 0;
    for (const m of queued) {
      const channel = await channelFor(call.accountId, m.channelId ?? null);
      const template = channel
        ? await templateByName(
            call.accountId,
            channel.wabaId,
            m.templateName ?? '',
            m.language ?? 'hi',
          )
        : null;
      if (
        await schedulePostCall({
          accountId: call.accountId,
          callId: call._id,
          contactId: call.contactId,
          source: `flow:${m.nodeId}`,
          channelId: channel?._id ?? null,
          templateId: template?._id ?? null,
          templateName: m.templateName ?? '',
          language: m.language ?? 'hi',
          variables: variablesFor(template, m.params),
          scheduledAt: now,
          now,
        })
      )
        scheduled += 1;
    }
    return scheduled;
  } catch (err) {
    getLogger().error({ err, callId }, 'post-call: flow messages not collected');
    return 0;
  }
};
