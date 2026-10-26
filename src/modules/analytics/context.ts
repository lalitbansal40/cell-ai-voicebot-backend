/** Loads what the pure definitions need from neighbouring rows (batched per sweep / rebuild). */
import { Types } from 'mongoose';

import { AccountModel } from '../../db/models/account.model';
import type { AnalyticsRow } from '../../db/models/analytics-mark.model';
import { CallModel } from '../../db/models/call.model';
import { MessageModel, type MessageDoc, type MessageType } from '../../db/models/message.model';

import {
  callDims,
  callRows,
  isBusinessMessage,
  isCustomerMessage,
  ledgerRows,
  messageRows,
  NO_MESSAGE_CONTEXT,
  type CallFacts,
  type Dim,
  type LedgerFacts,
  type MessageContext,
  type MessageFacts,
} from './definitions';

const DAY_MS = 86_400_000;
const DEFAULT_TZ = 'Asia/Kolkata';

/** Fields the call definitions read. */
export const CALL_FIELDS = {
  status: 1,
  isTest: 1,
  createdAt: 1,
  updatedAt: 1,
  timestamps: 1,
  durationSec: 1,
  direction: 1,
  mode: 1,
  disposition: 1,
  campaignId: 1,
  source: 1,
  agentUserId: 1,
  'whatsapp.channelId': 1,
  'whatsapp.answeredBy': 1,
  insights: 1,
  accountId: 1,
} as const;

export const MESSAGE_FIELDS = {
  accountId: 1,
  conversationId: 1,
  direction: 1,
  origin: 1,
  type: 1,
  status: 1,
  at: 1,
  channelId: 1,
  sentBy: 1,
  'template.templateId': 1,
  updatedAt: 1,
} as const;

export const LEDGER_FIELDS = {
  accountId: 1,
  type: 1,
  direction: 1,
  status: 1,
  amountMicros: 1,
  createdAt: 1,
  updatedAt: 1,
  ref: 1,
} as const;

export type CallRow = CallFacts & { accountId: Types.ObjectId; updatedAt: Date };
export type MessageRow = MessageFacts &
  Pick<MessageDoc, 'accountId' | 'conversationId' | 'updatedAt'>;
export type LedgerRow = LedgerFacts & { accountId: Types.ObjectId; updatedAt: Date };

/** Account timezones (missing / deleted account → India). */
export const timezones = async (accountIds: Types.ObjectId[]): Promise<Map<string, string>> => {
  const ids = [...new Set(accountIds.map(String))].map((id) => new Types.ObjectId(id));
  const accounts = await AccountModel.find({ _id: { $in: ids } })
    .select({ timezone: 1 })
    .lean<{ _id: Types.ObjectId; timezone?: string }[]>();
  const out = new Map<string, string>();
  for (const a of accounts) out.set(a._id.toString(), a.timezone ?? DEFAULT_TZ);
  return out;
};

const tzOf = (tz: Map<string, string>, accountId: Types.ObjectId): string =>
  tz.get(accountId.toString()) ?? DEFAULT_TZ;

const COUNTED_TYPES = { $nin: ['note', 'reaction', 'system', 'call'] as MessageType[] };

/** The template an inbound message is the first customer reply to (within 24 h), if any. */
const repliesTo = async (m: MessageRow): Promise<MessageContext['repliesTo']> => {
  const template = await MessageModel.findOne({
    accountId: m.accountId,
    conversationId: m.conversationId,
    direction: 'out',
    type: 'template',
    at: { $gte: new Date(m.at.getTime() - DAY_MS), $lte: m.at },
  })
    .sort({ at: -1, _id: -1 })
    .select({ at: 1, channelId: 1, 'template.templateId': 1 })
    .lean<Pick<MessageDoc, '_id' | 'at' | 'channelId' | 'template'>>();
  if (!template?.template) return null;
  const earlier = await MessageModel.exists({
    accountId: m.accountId,
    conversationId: m.conversationId,
    direction: 'in',
    origin: 'customer',
    type: COUNTED_TYPES,
    _id: { $ne: m._id },
    $or: [{ at: { $gt: template.at, $lt: m.at } }, { at: m.at, _id: { $lt: m._id } }],
  });
  if (earlier) return null;
  return {
    at: template.at,
    templateId: template.template.templateId,
    channelId: template.channelId,
  };
};

/** Seconds a customer waited for this reply, when it is the first team reply since they wrote. */
const responseSec = async (m: MessageRow): Promise<number | null> => {
  if (m.origin !== 'agent' && m.origin !== 'business_app') return null;
  const before = { $or: [{ at: { $lt: m.at } }, { at: m.at, _id: { $lt: m._id } }] };
  const previous = await MessageModel.findOne({
    accountId: m.accountId,
    conversationId: m.conversationId,
    direction: 'out',
    origin: { $in: ['agent', 'business_app', 'api', 'system'] },
    type: COUNTED_TYPES,
    ...before,
  })
    .sort({ at: -1, _id: -1 })
    .select({ at: 1 })
    .lean<Pick<MessageDoc, '_id' | 'at'>>();
  const waiting = await MessageModel.findOne({
    accountId: m.accountId,
    conversationId: m.conversationId,
    direction: 'in',
    origin: 'customer',
    type: COUNTED_TYPES,
    $and: [
      before,
      previous
        ? { $or: [{ at: { $gt: previous.at } }, { at: previous.at, _id: { $gt: previous._id } }] }
        : {},
    ],
  })
    .sort({ at: 1, _id: 1 })
    .select({ at: 1 })
    .lean<Pick<MessageDoc, '_id' | 'at'>>();
  return waiting ? (m.at.getTime() - waiting.at.getTime()) / 1000 : null;
};

export const messageContext = async (m: MessageRow): Promise<MessageContext> => {
  if (isCustomerMessage(m)) return { repliesTo: await repliesTo(m), responseSec: null };
  if (isBusinessMessage(m)) return { repliesTo: null, responseSec: await responseSec(m) };
  return NO_MESSAGE_CONTEXT;
};

/** Slices a ledger row's spend also counts in (the call's campaign / flow / …, the message's template / number). */
const ledgerDims = async (entries: LedgerRow[]): Promise<Map<string, Dim[]>> => {
  const callIds = entries
    .filter((e) => e.ref.type === 'call' && Types.ObjectId.isValid(e.ref.id))
    .map((e) => new Types.ObjectId(e.ref.id));
  const messageIds = entries
    .filter((e) => e.ref.type === 'whatsapp_message' && Types.ObjectId.isValid(e.ref.id))
    .map((e) => new Types.ObjectId(e.ref.id));
  const out = new Map<string, Dim[]>();
  if (callIds.length) {
    const calls = await CallModel.find({ _id: { $in: callIds } })
      .select(CALL_FIELDS)
      .lean<CallRow[]>();
    for (const c of calls) out.set(`call-${c._id.toString()}`, callDims(c));
  }
  if (messageIds.length) {
    const messages = await MessageModel.find({ _id: { $in: messageIds } })
      .select({ channelId: 1, 'template.templateId': 1 })
      .lean<Pick<MessageDoc, '_id' | 'channelId' | 'template'>[]>();
    for (const m of messages) {
      const d: Dim[] = [{ kind: 'number', refId: m.channelId }];
      if (m.template) d.push({ kind: 'template', refId: m.template.templateId });
      out.set(`whatsapp_message-${m._id.toString()}`, d);
    }
  }
  return out;
};

export interface EntityRows {
  id: Types.ObjectId;
  accountId: Types.ObjectId;
  rows: AnalyticsRow[];
}

export const callBatchRows = async (calls: CallRow[]): Promise<EntityRows[]> => {
  const tz = await timezones(calls.map((c) => c.accountId));
  return calls.map((c) => ({
    id: c._id,
    accountId: c.accountId,
    rows: callRows(c, tzOf(tz, c.accountId)),
  }));
};

export const messageBatchRows = async (messages: MessageRow[]): Promise<EntityRows[]> => {
  const tz = await timezones(messages.map((m) => m.accountId));
  const out: EntityRows[] = [];
  for (const m of messages) {
    out.push({
      id: m._id,
      accountId: m.accountId,
      rows: messageRows(m, tzOf(tz, m.accountId), await messageContext(m)),
    });
  }
  return out;
};

export const ledgerBatchRows = async (entries: LedgerRow[]): Promise<EntityRows[]> => {
  const tz = await timezones(entries.map((e) => e.accountId));
  const refDims = await ledgerDims(entries);
  return entries.map((e) => ({
    id: e._id,
    accountId: e.accountId,
    rows: ledgerRows(e, tzOf(tz, e.accountId), refDims.get(`${e.ref.type}-${e.ref.id}`) ?? []),
  }));
};
