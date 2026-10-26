/**
 * Metric definitions (docs/analytics/METRICS.md) as pure functions: what one call,
 * WhatsApp message or ledger row adds to the daily rollups. The sweep stores each
 * entity's rows and applies only the difference when the entity changes, so late
 * webhooks and re-runs never double count (ADR 0043).
 */
import type { Types } from 'mongoose';

import { DURATION_BUCKETS_SEC, RESPONSE_BUCKETS_SEC } from '../../config/limits';
import type { AnalyticsRow } from '../../db/models/analytics-mark.model';
import { LIVE_CALL_STATUSES, type CallDoc } from '../../db/models/call.model';
import type { LedgerEntryDoc, LedgerType } from '../../db/models/ledger-entry.model';
import type { MessageDoc, MessageOrigin, MessageType } from '../../db/models/message.model';
import type { StatsChannel, StatsKind } from '../../db/models/stats-daily.model';
import { ymdInZone } from '../../shared/time';

export type Counters = Record<string, number>;

/** Metric keys (stored counters). Ratios are computed when reading, never stored. */
export const M = {
  callsAttempted: 'calls_attempted',
  callsAnswered: 'calls_answered',
  callsTalkSec: 'calls_talk_sec',
  callsInbound: 'calls_inbound',
  callsOutbound: 'calls_outbound',
  callsAi: 'calls_ai',
  callsHuman: 'calls_human',
  callsNoOutcome: 'calls_no_outcome',
  msgSent: 'msg_sent',
  msgDelivered: 'msg_delivered',
  msgRead: 'msg_read',
  msgFailed: 'msg_failed',
  msgTemplateSent: 'msg_tpl_sent',
  msgReplied: 'msg_replied',
  msgInbound: 'msg_inbound',
  respCount: 'resp_count',
  respSec: 'resp_sec',
  spendTotal: 'spend_total',
} as const;

/** Prefixes of keyed counters. */
export const P = {
  outcome: 'outcome_',
  status: 'status_',
  durationBucket: 'dur_b',
  responseBucket: 'resp_b',
  spend: 'spend_',
} as const;

/** Ledger types that are spend (captured debits). Top-ups, adjustments and refunds of top-ups are not. */
export const SPEND_TYPES: readonly LedgerType[] = [
  'call_charge',
  'ai_charge',
  'tts_charge',
  'recording_charge',
  'whatsapp_charge',
  'whatsapp_call_charge',
  'subscription',
];

/** Business messages we send (not imports, not the customer). */
const BUSINESS_ORIGINS: readonly MessageOrigin[] = ['agent', 'business_app', 'api', 'system'];
/** Rows that are not messages people read or write. */
const NOT_COUNTED_TYPES: readonly MessageType[] = ['note', 'reaction', 'system', 'call'];
const SENT_OR_LATER = new Set(['sent', 'delivered', 'read']);
const DELIVERED_OR_LATER = new Set(['delivered', 'read']);

/** A free-text value as a counter-key part: lower-case `[a-z0-9_]`, ≤ 40 chars. */
export const safeKey = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'other';

/** Index of the bucket `value` falls in (buckets are ascending lower bounds). */
export const bucketOf = (value: number, buckets: readonly number[]): number => {
  let index = 0;
  for (let i = 0; i < buckets.length; i += 1) if (value >= (buckets[i] ?? 0)) index = i;
  return index;
};

export interface Dim {
  kind: StatsKind;
  refId: Types.ObjectId | null;
}

const dims = (pairs: [StatsKind, Types.ObjectId | null | undefined][]): Dim[] => [
  { kind: 'all', refId: null },
  ...pairs
    .filter((p): p is [StatsKind, Types.ObjectId] => Boolean(p[1]))
    .map(([kind, refId]) => ({ kind, refId })),
];

const rowsFor = (
  day: string,
  channel: StatsChannel,
  test: boolean,
  on: Dim[],
  counters: Counters,
): AnalyticsRow[] =>
  Object.keys(counters).length
    ? on.map((d) => ({
        day,
        channel,
        test,
        kind: d.kind,
        refId: d.refId,
        counters: { ...counters },
      }))
    : [];

export type CallFacts = Pick<
  CallDoc,
  | '_id'
  | 'status'
  | 'isTest'
  | 'createdAt'
  | 'timestamps'
  | 'durationSec'
  | 'direction'
  | 'mode'
  | 'disposition'
  | 'campaignId'
  | 'source'
  | 'agentUserId'
  | 'whatsapp'
>;

/** A call counts once it is final, unless it was canceled before dialing. */
export const callCounts = (call: CallFacts): boolean =>
  !LIVE_CALL_STATUSES.includes(call.status) &&
  !(call.status === 'canceled' && !call.timestamps.ringingAt && !call.timestamps.answeredAt);

export const callDims = (call: CallFacts): Dim[] =>
  dims([
    ['campaign', call.campaignId],
    ['flow', call.source.flowId],
    ['agent', call.source.agentId],
    ['user', call.whatsapp?.answeredBy ?? call.agentUserId],
    ['number', call.whatsapp?.channelId],
  ]);

/** Rows of one call (day = the account day the call was created). */
export const callRows = (call: CallFacts, timeZone: string): AnalyticsRow[] => {
  if (!callCounts(call)) return [];
  const answered = Boolean(call.timestamps.answeredAt);
  const c: Counters = {
    [M.callsAttempted]: 1,
    [`${P.status}${call.status}`]: 1,
    [call.direction === 'inbound' ? M.callsInbound : M.callsOutbound]: 1,
    [call.mode === 'human' ? M.callsHuman : M.callsAi]: 1,
  };
  if (answered) {
    const talk = Math.max(0, Math.round(call.durationSec));
    c[M.callsAnswered] = 1;
    c[M.callsTalkSec] = talk;
    c[`${P.durationBucket}${String(bucketOf(talk, DURATION_BUCKETS_SEC))}`] = 1;
    if (call.disposition) c[`${P.outcome}${safeKey(call.disposition)}`] = 1;
    else c[M.callsNoOutcome] = 1;
  }
  const channel: StatsChannel = call.whatsapp ? 'whatsapp' : 'voice';
  return rowsFor(ymdInZone(call.createdAt, timeZone), channel, call.isTest, callDims(call), c);
};

export type MessageFacts = Pick<
  MessageDoc,
  '_id' | 'direction' | 'origin' | 'type' | 'status' | 'at' | 'channelId' | 'sentBy' | 'template'
>;

/** Facts about neighbouring messages, loaded by the sweep (see `context.ts`). */
export interface MessageContext {
  /** Inbound only: the template this is the first customer reply to (within 24 h). */
  repliesTo: { at: Date; templateId: Types.ObjectId; channelId: Types.ObjectId } | null;
  /** Outbound only: seconds since the customer started waiting (first team reply). */
  responseSec: number | null;
}

export const NO_MESSAGE_CONTEXT: MessageContext = { repliesTo: null, responseSec: null };

export const isBusinessMessage = (
  m: Pick<MessageFacts, 'direction' | 'origin' | 'type'>,
): boolean =>
  m.direction === 'out' &&
  BUSINESS_ORIGINS.includes(m.origin) &&
  !NOT_COUNTED_TYPES.includes(m.type);

export const isCustomerMessage = (
  m: Pick<MessageFacts, 'direction' | 'origin' | 'type'>,
): boolean =>
  m.direction === 'in' && m.origin === 'customer' && !NOT_COUNTED_TYPES.includes(m.type);

/** Rows of one WhatsApp message (day = the account day of `at`). */
export const messageRows = (
  m: MessageFacts,
  timeZone: string,
  ctx: MessageContext,
): AnalyticsRow[] => {
  const day = ymdInZone(m.at, timeZone);
  const rows: AnalyticsRow[] = [];
  if (isBusinessMessage(m)) {
    const c: Counters = {};
    if (SENT_OR_LATER.has(m.status)) {
      c[M.msgSent] = 1;
      if (m.template) c[M.msgTemplateSent] = 1;
    }
    if (DELIVERED_OR_LATER.has(m.status)) c[M.msgDelivered] = 1;
    if (m.status === 'read') c[M.msgRead] = 1;
    if (m.status === 'failed') c[M.msgFailed] = 1;
    if (ctx.responseSec !== null) {
      const sec = Math.max(0, Math.round(ctx.responseSec));
      c[M.respCount] = 1;
      c[M.respSec] = sec;
      c[`${P.responseBucket}${String(bucketOf(sec, RESPONSE_BUCKETS_SEC))}`] = 1;
    }
    rows.push(
      ...rowsFor(
        day,
        'whatsapp',
        false,
        dims([
          ['template', m.template?.templateId],
          ['user', m.sentBy],
          ['number', m.channelId],
        ]),
        c,
      ),
    );
  } else if (isCustomerMessage(m)) {
    rows.push(
      ...rowsFor(day, 'whatsapp', false, dims([['number', m.channelId]]), { [M.msgInbound]: 1 }),
    );
    if (ctx.repliesTo) {
      // the reply counts on the template's day (template performance by send date)
      rows.push(
        ...rowsFor(
          ymdInZone(ctx.repliesTo.at, timeZone),
          'whatsapp',
          false,
          dims([
            ['template', ctx.repliesTo.templateId],
            ['number', ctx.repliesTo.channelId],
          ]),
          { [M.msgReplied]: 1 },
        ),
      );
    }
  }
  return rows;
};

export type LedgerFacts = Pick<
  LedgerEntryDoc,
  '_id' | 'type' | 'direction' | 'status' | 'amountMicros' | 'createdAt' | 'ref'
>;

/** Rows of one ledger row: captured spend only (day = the account day it was written). */
export const ledgerRows = (
  entry: LedgerFacts,
  timeZone: string,
  refDims: Dim[],
): AnalyticsRow[] => {
  if (
    entry.status !== 'captured' ||
    entry.direction !== 'debit' ||
    !SPEND_TYPES.includes(entry.type)
  )
    return [];
  return rowsFor(
    ymdInZone(entry.createdAt, timeZone),
    'money',
    false,
    [{ kind: 'all', refId: null }, ...refDims.filter((d) => d.kind !== 'all')],
    { [M.spendTotal]: entry.amountMicros, [`${P.spend}${entry.type}`]: entry.amountMicros },
  );
};

export const rowKey = (
  r: Pick<AnalyticsRow, 'day' | 'channel' | 'test' | 'kind' | 'refId'>,
): string =>
  `${r.day}|${r.channel}|${r.test ? 't' : 'f'}|${r.kind}|${r.refId ? r.refId.toString() : '-'}`;

/** Merges rows with the same key (counters summed, zeros dropped). */
export const mergeRows = (rows: AnalyticsRow[]): AnalyticsRow[] => {
  const out = new Map<string, AnalyticsRow>();
  for (const r of rows) {
    const key = rowKey(r);
    const into = out.get(key) ?? { ...r, counters: {} };
    for (const [k, v] of Object.entries(r.counters)) into.counters[k] = (into.counters[k] ?? 0) + v;
    out.set(key, into);
  }
  for (const [key, r] of out) {
    for (const [k, v] of Object.entries(r.counters)) if (v === 0) delete r.counters[k];
    if (!Object.keys(r.counters).length) out.delete(key);
  }
  return [...out.values()];
};

/** `next − previous`, per row and counter (what the rollups still need). */
export const diffRows = (previous: AnalyticsRow[], next: AnalyticsRow[]): AnalyticsRow[] =>
  mergeRows([
    ...next,
    ...previous.map((r) => ({
      ...r,
      counters: Object.fromEntries(Object.entries(r.counters).map(([k, v]) => [k, -v])),
    })),
  ]);
