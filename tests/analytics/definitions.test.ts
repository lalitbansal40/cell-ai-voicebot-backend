import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import type { AnalyticsRow } from '../../src/db/models/analytics-mark.model';
import {
  bucketOf,
  callCounts,
  callRows,
  diffRows,
  isBusinessMessage,
  isCustomerMessage,
  ledgerRows,
  M,
  mergeRows,
  messageRows,
  NO_MESSAGE_CONTEXT,
  rowKey,
  safeKey,
  type CallFacts,
  type LedgerFacts,
  type MessageFacts,
} from '../../src/modules/analytics/definitions';

const IST = 'Asia/Kolkata';
const id = () => new Types.ObjectId();
const campaignId = id();
const flowId = id();
const agentId = id();
const userId = id();
const channelId = id();

const call = (over: Partial<CallFacts> = {}): CallFacts => ({
  _id: id(),
  status: 'completed',
  isTest: false,
  // 2026-10-26 23:59:59 IST
  createdAt: new Date('2026-10-26T18:29:59.000Z'),
  timestamps: {
    queuedAt: new Date('2026-10-26T18:29:59.000Z'),
    ringingAt: new Date('2026-10-26T18:30:01.000Z'),
    answeredAt: new Date('2026-10-26T18:30:05.000Z'),
    endedAt: new Date('2026-10-26T18:31:05.000Z'),
  },
  durationSec: 60.4,
  direction: 'outbound',
  mode: 'ai',
  disposition: 'Promise to pay!',
  campaignId,
  source: { kind: 'flow', flowId },
  agentUserId: null,
  whatsapp: null,
  ...over,
});

const byKind = (rows: AnalyticsRow[]) => Object.fromEntries(rows.map((r) => [r.kind, r]));

describe('analytics definitions — calls', () => {
  it('a final answered call counts on its account day with every slice', () => {
    const rows = callRows(call(), IST);
    expect(rows.map((r) => r.kind)).toEqual(['all', 'campaign', 'flow']);
    const all = byKind(rows).all;
    expect(all).toMatchObject({ day: '2026-10-26', channel: 'voice', test: false, refId: null });
    expect(all?.counters).toEqual({
      [M.callsAttempted]: 1,
      status_completed: 1,
      [M.callsOutbound]: 1,
      [M.callsAi]: 1,
      [M.callsAnswered]: 1,
      [M.callsTalkSec]: 60,
      dur_b3: 1,
      outcome_promise_to_pay: 1,
    });
    // the same instant is the next day in UTC
    expect(callRows(call(), 'UTC')[0]?.day).toBe('2026-10-26');
    expect(callRows(call({ createdAt: new Date('2026-10-26T18:30:00.000Z') }), IST)[0]?.day).toBe(
      '2026-10-27',
    );
  });

  it('live calls and calls canceled before dialing do not count; canceled after ringing does', () => {
    expect(callRows(call({ status: 'in_progress' }), IST)).toEqual([]);
    expect(callRows(call({ status: 'queued' }), IST)).toEqual([]);
    const notDialed = call({
      status: 'canceled',
      timestamps: { queuedAt: new Date(), ringingAt: null, answeredAt: null, endedAt: new Date() },
    });
    expect(callCounts(notDialed)).toBe(false);
    const rang = call({
      status: 'canceled',
      timestamps: {
        queuedAt: new Date(),
        ringingAt: new Date(),
        answeredAt: null,
        endedAt: new Date(),
      },
    });
    expect(byKind(callRows(rang, IST)).all?.counters).toEqual({
      [M.callsAttempted]: 1,
      status_canceled: 1,
      [M.callsOutbound]: 1,
      [M.callsAi]: 1,
    });
  });

  it('unanswered calls have no talk time or outcome; answered without disposition → no outcome', () => {
    const missed = call({
      status: 'no_answer',
      timestamps: {
        queuedAt: new Date(),
        ringingAt: new Date(),
        answeredAt: null,
        endedAt: new Date(),
      },
    });
    expect(byKind(callRows(missed, IST)).all?.counters[M.callsAnswered]).toBeUndefined();
    const plain = byKind(callRows(call({ disposition: null }), IST)).all?.counters;
    expect(plain?.[M.callsNoOutcome]).toBe(1);
  });

  it('WhatsApp human calls count on the whatsapp channel with the number and the person', () => {
    const rows = callRows(
      call({
        mode: 'human',
        direction: 'inbound',
        campaignId: null,
        source: { kind: null },
        agentUserId: id(),
        whatsapp: { channelId, answeredBy: userId } as CallFacts['whatsapp'],
      }),
      IST,
    );
    const kinds = byKind(rows);
    expect(Object.keys(kinds)).toEqual(['all', 'user', 'number']);
    expect(kinds.user?.refId).toEqual(userId);
    expect(kinds.number?.refId).toEqual(channelId);
    expect(kinds.all?.channel).toBe('whatsapp');
    expect(kinds.all?.counters[M.callsHuman]).toBe(1);
    expect(kinds.all?.counters[M.callsInbound]).toBe(1);
  });

  it('agent calls slice by AI agent; test calls stay apart', () => {
    const rows = callRows(
      call({ isTest: true, campaignId: null, source: { kind: 'agent', agentId } }),
      IST,
    );
    expect(rows.map((r) => [r.kind, r.test])).toEqual([
      ['all', true],
      ['agent', true],
    ]);
  });

  it('done insights add sentiment and promise-to-pay; other states add nothing', () => {
    const state = {
      status: 'done' as const,
      reason: null,
      version: 1,
      sentiment: 'negative' as const,
      hasPromise: true,
      promiseAmountMicros: 2_500_000_000,
      hasSummary: true,
      at: new Date(),
    };
    expect(byKind(callRows(call({ insights: state }), IST)).all?.counters).toMatchObject({
      sentiment_negative: 1,
      ptp_count: 1,
      ptp_micros: 2_500_000_000,
    });
    const noAmount = byKind(
      callRows(call({ insights: { ...state, sentiment: null, promiseAmountMicros: null } }), IST),
    ).all?.counters;
    expect(noAmount).toMatchObject({ ptp_count: 1 });
    expect(noAmount?.ptp_micros).toBeUndefined();
    expect(Object.keys(noAmount ?? {}).some((k) => k.startsWith('sentiment_'))).toBe(false);
    const pending = byKind(callRows(call({ insights: { ...state, status: 'pending' } }), IST)).all;
    expect(pending?.counters.ptp_count).toBeUndefined();
    const noPromise = byKind(
      callRows(call({ insights: { ...state, hasPromise: false } }), IST),
    ).all;
    expect(noPromise?.counters.ptp_count).toBeUndefined();
  });

  it('buckets, keys', () => {
    expect(bucketOf(0, [0, 15, 30])).toBe(0);
    expect(bucketOf(15, [0, 15, 30])).toBe(1);
    expect(bucketOf(9_999, [0, 15, 30])).toBe(2);
    expect(safeKey('  Paid — in FULL!! ')).toBe('paid_in_full');
    expect(safeKey('!!!')).toBe('other');
    expect(safeKey('x'.repeat(60))).toHaveLength(40);
  });
});

const msg = (over: Partial<MessageFacts> = {}): MessageFacts => ({
  _id: id(),
  direction: 'out',
  origin: 'agent',
  type: 'text',
  status: 'read',
  at: new Date('2026-10-26T10:00:00.000Z'),
  channelId,
  sentBy: userId,
  template: null,
  ...over,
});

describe('analytics definitions — WhatsApp messages', () => {
  it('a read business message counts as sent, delivered and read, by person and number', () => {
    const rows = messageRows(msg(), IST, NO_MESSAGE_CONTEXT);
    expect(rows.map((r) => r.kind)).toEqual(['all', 'user', 'number']);
    expect(rows[0]?.counters).toEqual({
      [M.msgSent]: 1,
      [M.msgDelivered]: 1,
      [M.msgRead]: 1,
    });
  });

  it('status ladder: queued counts nothing, sent / delivered / failed', () => {
    expect(messageRows(msg({ status: 'queued' }), IST, NO_MESSAGE_CONTEXT)).toEqual([]);
    expect(messageRows(msg({ status: 'sent' }), IST, NO_MESSAGE_CONTEXT)[0]?.counters).toEqual({
      [M.msgSent]: 1,
    });
    expect(messageRows(msg({ status: 'delivered' }), IST, NO_MESSAGE_CONTEXT)[0]?.counters).toEqual(
      { [M.msgSent]: 1, [M.msgDelivered]: 1 },
    );
    expect(messageRows(msg({ status: 'failed' }), IST, NO_MESSAGE_CONTEXT)[0]?.counters).toEqual({
      [M.msgFailed]: 1,
    });
  });

  it('templates add the template slice; notes, reactions, call bubbles and imports never count', () => {
    const templateId = id();
    const rows = messageRows(
      msg({ type: 'template', sentBy: null, template: { templateId } as MessageFacts['template'] }),
      IST,
      NO_MESSAGE_CONTEXT,
    );
    expect(rows.map((r) => r.kind)).toEqual(['all', 'template', 'number']);
    expect(rows[0]?.counters[M.msgTemplateSent]).toBe(1);
    for (const over of [
      { type: 'note' },
      { type: 'reaction' },
      { type: 'call' },
      { origin: 'history' },
      { direction: 'in', origin: 'customer', type: 'reaction' },
    ] as Partial<MessageFacts>[])
      expect(messageRows(msg(over), IST, NO_MESSAGE_CONTEXT)).toEqual([]);
    expect(isBusinessMessage(msg({ origin: 'business_app' }))).toBe(true);
    expect(isCustomerMessage(msg({ direction: 'in', origin: 'customer' }))).toBe(true);
  });

  it('a first team reply carries the wait; a customer reply counts on the template day', () => {
    const replied = messageRows(msg(), IST, { repliesTo: null, responseSec: 400.6 });
    expect(replied[0]?.counters).toMatchObject({ [M.respCount]: 1, [M.respSec]: 401, resp_b2: 1 });
    const templateId = id();
    const inbound = messageRows(
      msg({
        direction: 'in',
        origin: 'customer',
        sentBy: null,
        at: new Date('2026-10-27T03:00:00Z'),
      }),
      IST,
      {
        repliesTo: { at: new Date('2026-10-26T15:00:00Z'), templateId, channelId },
        responseSec: null,
      },
    );
    expect(inbound.map((r) => [r.day, r.kind, r.counters])).toEqual([
      ['2026-10-27', 'all', { [M.msgInbound]: 1 }],
      ['2026-10-27', 'number', { [M.msgInbound]: 1 }],
      ['2026-10-26', 'all', { [M.msgReplied]: 1 }],
      ['2026-10-26', 'template', { [M.msgReplied]: 1 }],
      ['2026-10-26', 'number', { [M.msgReplied]: 1 }],
    ]);
  });
});

const entry = (over: Partial<LedgerFacts> = {}): LedgerFacts => ({
  _id: id(),
  type: 'call_charge',
  direction: 'debit',
  status: 'captured',
  amountMicros: 1_250_000,
  createdAt: new Date('2026-10-26T10:00:00.000Z'),
  ref: { type: 'call', id: id().toString() },
  ...over,
});

describe('analytics definitions — money', () => {
  it('captured debits of spend types count; holds, releases, top-ups and adjustments do not', () => {
    const rows = ledgerRows(entry(), IST, [
      { kind: 'all', refId: null },
      { kind: 'campaign', refId: campaignId },
    ]);
    expect(rows.map((r) => [r.channel, r.kind, r.counters])).toEqual([
      ['money', 'all', { [M.spendTotal]: 1_250_000, spend_call_charge: 1_250_000 }],
      ['money', 'campaign', { [M.spendTotal]: 1_250_000, spend_call_charge: 1_250_000 }],
    ]);
    expect(ledgerRows(entry({ status: 'held' }), IST, [])).toEqual([]);
    expect(ledgerRows(entry({ status: 'released' }), IST, [])).toEqual([]);
    expect(ledgerRows(entry({ type: 'topup', direction: 'credit' }), IST, [])).toEqual([]);
    expect(ledgerRows(entry({ type: 'adjustment' }), IST, [])).toEqual([]);
    expect(ledgerRows(entry({ type: 'refund', direction: 'credit' }), IST, [])).toEqual([]);
  });
});

describe('analytics definitions — row arithmetic', () => {
  const r = (day: string, counters: Record<string, number>, kind: AnalyticsRow['kind'] = 'all') =>
    ({ day, channel: 'voice', test: false, kind, refId: null, counters }) as AnalyticsRow;

  it('merge sums equal keys and drops zeros; diff = next − previous', () => {
    expect(mergeRows([r('d1', { a: 1 }), r('d1', { a: 2, b: 0 }), r('d2', { a: 0 })])).toEqual([
      r('d1', { a: 3 }),
    ]);
    expect(
      diffRows([r('d1', { a: 1, b: 2 })], [r('d1', { a: 1, b: 5 }), r('d2', { c: 1 })]),
    ).toEqual([r('d1', { b: 3 }), r('d2', { c: 1 })]);
    expect(diffRows([r('d1', { a: 1 })], [])).toEqual([r('d1', { a: -1 })]);
    expect(diffRows([r('d1', { a: 1 })], [r('d1', { a: 1 })])).toEqual([]);
    expect(rowKey(r('d1', {}, 'campaign'))).toBe('d1|voice|f|campaign|-');
  });
});
