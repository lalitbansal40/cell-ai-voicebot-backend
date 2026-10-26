/**
 * WhatsApp chat summaries (Phase 14, ADR 0044): "Summarize" in a chat, or automatically
 * when it is closed (`settings.insights.chatSummaryOnClose`). Each summary covers the
 * messages since the previous one (at most the last `chatMaxMessages`), never notes,
 * reactions, system rows or file names. Prepaid AI usage, charged once per summary.
 */
import type { Request } from 'express';
import { Types } from 'mongoose';

import { INSIGHTS_LIMITS } from '../../config/limits';
import type { AiJobs } from '../../core/ai/jobs';
import { turnCost } from '../../core/ai/pricing';
import {
  CHAT_SUMMARY_FORMAT,
  CHAT_SUMMARY_JSON_SCHEMA,
  chatSummaryMessages,
} from '../../core/ai/prompts/chat-summary';
import type { TokenUsage } from '../../core/ai/types';
import { chargeUsage } from '../../core/billing/engine';
import { effectiveRateCard } from '../../core/billing/rates';
import { getOrCreateWallet } from '../../core/billing/wallets';
import { tryGetRealtime } from '../../core/realtime';
import { AccountModel, type AccountDoc } from '../../db/models/account.model';
import {
  ConversationSummaryModel,
  type ConversationSummaryDoc,
} from '../../db/models/conversation-summary.model';
import { ConversationModel, type ConversationDoc } from '../../db/models/conversation.model';
import { MessageModel, type MessageDoc, type MessageType } from '../../db/models/message.model';
import { UserModel } from '../../db/models/user.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter } from '../../shared/auth/tenant';
import { AppError, ConflictError, NotFoundError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';
import { z } from '../../shared/openapi/zod';
import { auditRequest } from '../audit/audit.service';

import { INSIGHT_JOBS, insightsSettingsOf, type InsightsDeps } from './insights.service';

export const chatSummaryJobId = (summaryId: string): string => `chat-summary-${summaryId}`;

const SKIPPED_TYPES: MessageType[] = ['note', 'reaction', 'system', 'call'];
const PLACEHOLDER: Partial<Record<MessageType, string>> = {
  image: '[image]',
  video: '[video]',
  audio: '[voice note]',
  document: '[document]',
  sticker: '[sticker]',
  location: '[location]',
  contacts: '[contact card]',
  order: '[order]',
  unsupported: '[unsupported message]',
};

const SummaryAnswer = z.strictObject({
  summary: z.string().transform((s) => s.trim().slice(0, 2000)),
});

type MessageLine = Pick<
  MessageDoc,
  '_id' | 'at' | 'direction' | 'type' | 'text' | 'template' | 'interactive' | 'button'
>;

const lineOf = (m: MessageLine): string => {
  const who = m.direction === 'in' ? '[customer]' : '[agent]';
  const text =
    m.text?.trim() ||
    (m.type === 'template' && m.template ? `[template ${m.template.name}]` : null) ||
    m.interactive?.body?.trim() ||
    m.button?.text?.trim() ||
    PLACEHOLDER[m.type] ||
    `[${m.type}]`;
  return `${who} ${text.replace(/\s+/g, ' ')}`;
};

/** Messages since the last finished summary, newest `chatMaxMessages`, oldest first. */
const newMessages = async (
  accountId: Types.ObjectId,
  conversationId: Types.ObjectId,
): Promise<MessageLine[]> => {
  const last = await ConversationSummaryModel.findOne({ accountId, conversationId, status: 'done' })
    .sort({ createdAt: -1 })
    .select({ toMessageId: 1 })
    .lean<{ toMessageId: Types.ObjectId | null }>();
  const after = last?.toMessageId
    ? await MessageModel.findOne({ _id: last.toMessageId, accountId })
        .select({ at: 1 })
        .lean<{ _id: Types.ObjectId; at: Date }>()
    : null;
  const rows = await MessageModel.find({
    accountId,
    conversationId,
    type: { $nin: SKIPPED_TYPES },
    ...(after
      ? { $or: [{ at: { $gt: after.at } }, { at: after.at, _id: { $gt: after._id } }] }
      : {}),
  })
    .sort({ at: -1, _id: -1 })
    .limit(INSIGHTS_LIMITS.chatMaxMessages)
    .select({
      at: 1,
      direction: 1,
      type: 1,
      text: 1,
      'template.name': 1,
      'interactive.body': 1,
      'button.text': 1,
    })
    .lean<MessageLine[]>();
  return rows.reverse();
};

const emit = (conversationId: Types.ObjectId, summaryId: Types.ObjectId): void => {
  const rt = tryGetRealtime();
  if (!rt) return;
  void rt
    .pushToTopic(`conversation:${conversationId.toString()}`, 'inbox.conversation.summary', {
      conversationId: conversationId.toString(),
      summaryId: summaryId.toString(),
    })
    .catch((err: unknown) => {
      getLogger().warn({ err }, 'chat summary: realtime push failed');
    });
};

const startSummary = async (
  conversation: Pick<ConversationDoc, '_id' | 'accountId'>,
  createdBy: Types.ObjectId | null,
  jobs: AiJobs,
): Promise<ConversationSummaryDoc> => {
  const doc = await ConversationSummaryModel.create({
    accountId: conversation.accountId,
    conversationId: conversation._id,
    status: 'pending',
    createdBy,
  });
  await jobs.enqueue(
    INSIGHT_JOBS.chatSummary,
    { accountId: conversation.accountId.toString(), summaryId: doc._id.toString() },
    { jobId: chatSummaryJobId(doc._id.toString()) },
  );
  return doc.toObject({ transform: false });
};

export const listChatSummaries = async (accountId: Types.ObjectId, conversationId: string) => {
  const conversation = await ConversationModel.findOne({ _id: conversationId, accountId })
    .select({ _id: 1 })
    .lean();
  if (!conversation) throw new NotFoundError('Conversation not found');
  const docs = await ConversationSummaryModel.find({ accountId, conversationId: conversation._id })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean<ConversationSummaryDoc[]>();
  const ids = [...new Set(docs.flatMap((d) => (d.createdBy ? [d.createdBy.toString()] : [])))];
  const users = ids.length
    ? await UserModel.find({ accountId, _id: { $in: ids } })
        .select({ name: 1 })
        .lean<{ _id: Types.ObjectId; name: string }[]>()
    : [];
  const names = new Map(users.map((u) => [u._id.toString(), u.name]));
  return docs.map((d) => ({
    id: d._id.toString(),
    status: d.status,
    reason: d.reason,
    summary: d.summary,
    messageCount: d.messageCount,
    costMicros: d.costMicros,
    createdBy: d.createdBy
      ? { id: d.createdBy.toString(), name: names.get(d.createdBy.toString()) ?? 'Former member' }
      : null,
    createdAt: d.createdAt.toISOString(),
  }));
};

export const getChatSummaries = (req: Request, id: string) =>
  listChatSummaries(tenantFilter(req).accountId, id);

/** `POST /inbox/conversations/:id/summary`. */
export const requestChatSummary = async (req: Request, id: string, deps: { jobs: AiJobs }) => {
  const { accountId } = tenantFilter(req);
  const conversation = await ConversationModel.findOne({ _id: id, accountId })
    .select({ accountId: 1 })
    .lean<Pick<ConversationDoc, '_id' | 'accountId'>>();
  if (!conversation) throw new NotFoundError('Conversation not found');
  const account = await AccountModel.findById(accountId)
    .select({ settings: 1 })
    .lean<Pick<AccountDoc, 'settings'>>();
  if (!account || !insightsSettingsOf(account).enabled) throw new AppError('INSIGHTS_DISABLED');
  if (
    await ConversationSummaryModel.exists({
      accountId,
      conversationId: conversation._id,
      status: 'pending',
    })
  )
    throw new ConflictError('CONFLICT_INVALID_STATE', 'A summary is already being made.');
  if (!(await newMessages(accountId, conversation._id)).length)
    throw new AppError('CHAT_SUMMARY_EMPTY');
  const wallet = await getOrCreateWallet(accountId);
  if (wallet.balanceMicros - wallet.holdMicros <= 0)
    throw new AppError('WALLET_INSUFFICIENT_BALANCE');
  const doc = await startSummary(
    conversation,
    new Types.ObjectId(requireAuth(req).userId),
    deps.jobs,
  );
  await auditRequest(req, 'conversation.summary_created', {
    target: { type: 'conversation', id: conversation._id.toString() },
    meta: { summaryId: doc._id.toString() },
  });
  return listChatSummaries(accountId, id);
};

/** Inbox close hook: a summary when the account wants one and the chat has news. Never throws. */
export const summarizeOnClose = async (
  conversation: Pick<ConversationDoc, '_id' | 'accountId'>,
  jobs: AiJobs,
): Promise<void> => {
  try {
    const account = await AccountModel.findById(conversation.accountId)
      .select({ settings: 1 })
      .lean<Pick<AccountDoc, 'settings'>>();
    const settings = account ? insightsSettingsOf(account) : null;
    if (!settings?.enabled || !settings.chatSummaryOnClose) return;
    const { accountId, _id } = conversation;
    if (
      await ConversationSummaryModel.exists({ accountId, conversationId: _id, status: 'pending' })
    )
      return;
    if (!(await newMessages(accountId, _id)).length) return;
    await startSummary(conversation, null, jobs);
  } catch (err) {
    getLogger().warn(
      { err, conversationId: conversation._id.toString() },
      'chat summary: on close failed',
    );
  }
};

const finish = async (
  doc: ConversationSummaryDoc,
  status: 'skipped' | 'failed',
  reason: string,
) => {
  await ConversationSummaryModel.updateOne({ _id: doc._id }, { $set: { status, reason } });
  emit(doc.conversationId, doc._id);
  return { status, reason };
};

/** `insights.chat_summary`. */
export const runChatSummary = async (
  data: { accountId: string; summaryId: string },
  deps: InsightsDeps,
  attempt: { made: number; max: number } = { made: 0, max: 1 },
): Promise<{ status: string; reason?: string }> => {
  const accountId = new Types.ObjectId(data.accountId);
  const doc = await ConversationSummaryModel.findOne({
    _id: data.summaryId,
    accountId,
  }).lean<ConversationSummaryDoc>();
  if (doc?.status !== 'pending') return { status: 'stale' };
  const wallet = await getOrCreateWallet(accountId);
  if (wallet.balanceMicros - wallet.holdMicros <= 0) return finish(doc, 'skipped', 'low_balance');
  const messages = await newMessages(accountId, doc.conversationId);
  if (!messages.length) return finish(doc, 'skipped', 'empty');
  if (!deps.provider) throw new Error('AI provider is not configured for the worker');
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let summary: string | null = null;
  try {
    for (let i = 0; i <= INSIGHTS_LIMITS.retries && summary === null; i += 1) {
      const result = await deps.provider.chat({
        model: deps.model,
        messages: chatSummaryMessages(messages.map(lineOf).join('\n')),
        responseFormat: {
          type: 'json_schema',
          name: CHAT_SUMMARY_FORMAT,
          schema: CHAT_SUMMARY_JSON_SCHEMA,
        },
        temperatureTenths: 2,
        maxOutputTokens: INSIGHTS_LIMITS.maxOutputTokens,
      });
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(result.content);
      } catch {
        parsed = null;
      }
      const checked = SummaryAnswer.safeParse(parsed);
      if (checked.success && checked.data.summary) summary = checked.data.summary;
    }
  } catch (err) {
    if (attempt.made + 1 < attempt.max) throw err;
    getLogger().warn(
      { summaryId: data.summaryId, err: (err as Error).name },
      'chat summary: provider failed',
    );
    return finish(doc, 'failed', 'provider_error');
  }
  const cost = turnCost(await effectiveRateCard(accountId), usage);
  if (cost > 0) {
    try {
      await chargeUsage({
        accountId,
        type: 'ai_charge',
        amountMicros: cost,
        breakdown: { aiMicros: cost, ...usage, model: deps.model, kind: 'chat_summary' },
        ref: { type: 'usage', id: doc._id.toString() },
        idempotencyKey: chatSummaryJobId(doc._id.toString()),
      });
    } catch (err) {
      if (
        err instanceof AppError &&
        (err.code === 'WALLET_INSUFFICIENT_BALANCE' || err.code === 'WALLET_BUDGET_EXCEEDED')
      )
        return finish(doc, 'skipped', 'low_balance');
      throw err;
    }
  }
  await ConversationSummaryModel.updateOne(
    { _id: doc._id },
    {
      $set: {
        ...(summary === null
          ? { status: 'failed', reason: 'invalid_output' }
          : { status: 'done', reason: null, summary }),
        fromMessageId: messages[0]?._id ?? null,
        toMessageId: messages[messages.length - 1]?._id ?? null,
        messageCount: messages.length,
        model: deps.model,
        ...usage,
        costMicros: cost,
      },
    },
  );
  emit(doc.conversationId, doc._id);
  return summary === null ? { status: 'failed', reason: 'invalid_output' } : { status: 'done' };
};
