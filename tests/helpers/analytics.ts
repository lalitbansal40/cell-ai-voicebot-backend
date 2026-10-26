import { Types } from 'mongoose';

import { CallModel } from '../../src/db/models/call.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { MessageModel } from '../../src/db/models/message.model';
import { StatsDailyModel, type StatsDailyDoc } from '../../src/db/models/stats-daily.model';
import { ymdInZone } from '../../src/shared/time';

/** Deterministic PRNG (mulberry32). */
export const prng = (seed: number) => {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    int: (max: number) => Math.floor(next() * max),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
  };
};

/** Raw call row (inserted without mongoose validation — only the fields analytics reads). */
export const callDoc = (accountId: Types.ObjectId, over: Record<string, unknown> = {}) => {
  const createdAt = (over.createdAt as Date | undefined) ?? new Date();
  return {
    _id: new Types.ObjectId(),
    accountId,
    status: 'completed',
    isTest: false,
    createdAt,
    updatedAt: createdAt,
    timestamps: {
      queuedAt: createdAt,
      ringingAt: createdAt,
      answeredAt: createdAt,
      endedAt: createdAt,
    },
    durationSec: 30,
    direction: 'outbound',
    mode: 'ai',
    disposition: null,
    campaignId: null,
    source: { kind: 'flow', flowId: new Types.ObjectId() },
    agentUserId: null,
    whatsapp: null,
    ...over,
  };
};

export const messageDoc = (accountId: Types.ObjectId, over: Record<string, unknown> = {}) => {
  const at = (over.at as Date | undefined) ?? new Date();
  return {
    _id: new Types.ObjectId(),
    accountId,
    conversationId: new Types.ObjectId(),
    channelId: new Types.ObjectId(),
    contactId: new Types.ObjectId(),
    direction: 'out',
    origin: 'agent',
    type: 'text',
    status: 'sent',
    statusHistory: [],
    sentBy: null,
    template: null,
    at,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
};

export const ledgerDoc = (accountId: Types.ObjectId, over: Record<string, unknown> = {}) => {
  const createdAt = (over.createdAt as Date | undefined) ?? new Date();
  return {
    _id: new Types.ObjectId(),
    accountId,
    type: 'call_charge',
    direction: 'debit',
    status: 'captured',
    amountMicros: 1_000_000,
    currency: 'INR',
    ref: { type: 'manual', id: 'x' },
    idempotencyKey: new Types.ObjectId().toString(),
    createdAt,
    updatedAt: createdAt,
    ...over,
  };
};

const STATUSES = ['completed', 'completed', 'no_answer', 'failed', 'busy', 'canceled', 'completed'];
const MSG_STATUSES = ['queued', 'sent', 'delivered', 'read', 'read', 'failed'];

/**
 * A random world for one account: calls, messages, ledger rows spread over `days`
 * days before `end`, many of them a second away from a local midnight.
 */
export const randomWorld = async (
  accountId: Types.ObjectId,
  input: { seed: number; end: Date; days: number; calls: number; messages: number; ledger: number },
) => {
  const r = prng(input.seed);
  const campaigns = [new Types.ObjectId(), new Types.ObjectId()];
  const channels = [new Types.ObjectId(), new Types.ObjectId()];
  const conversations = Array.from({ length: 12 }, () => new Types.ObjectId());
  const templates = [new Types.ObjectId(), new Types.ObjectId()];
  const users = [new Types.ObjectId(), new Types.ObjectId()];
  const at = () => {
    const base = input.end.getTime() - r.int(input.days * 24) * 3_600_000;
    // a third of the rows sit right at a half-hour boundary (IST and New York midnights)
    const t =
      r.int(3) === 0 ? base - (base % 1_800_000) - r.int(2) * 1000 : base - r.int(3_600_000);
    return new Date(t);
  };
  const calls = Array.from({ length: input.calls }, () => {
    const createdAt = at();
    const status = r.pick(STATUSES);
    const answered = status === 'completed';
    const wa = r.int(3) === 0;
    return callDoc(accountId, {
      createdAt,
      updatedAt: input.end,
      status,
      isTest: r.int(8) === 0,
      timestamps: {
        queuedAt: createdAt,
        ringingAt: status === 'canceled' && r.int(2) === 0 ? null : createdAt,
        answeredAt: answered ? createdAt : null,
        endedAt: createdAt,
      },
      durationSec: answered ? r.int(900) : 0,
      direction: r.int(4) === 0 ? 'inbound' : 'outbound',
      mode: wa && r.int(2) === 0 ? 'human' : 'ai',
      disposition:
        answered && r.int(2) === 0 ? r.pick(['promise_to_pay', 'callback', 'Paid!']) : null,
      campaignId: r.int(2) === 0 ? r.pick(campaigns) : null,
      whatsapp: wa ? { channelId: r.pick(channels), answeredBy: r.pick([null, ...users]) } : null,
    });
  });
  const messages = Array.from({ length: input.messages }, () => {
    const inbound = r.int(3) === 0;
    const template = !inbound && r.int(3) === 0;
    return messageDoc(accountId, {
      at: at(),
      updatedAt: input.end,
      conversationId: r.pick(conversations),
      channelId: r.pick(channels),
      direction: inbound ? 'in' : 'out',
      origin: inbound ? 'customer' : r.pick(['agent', 'agent', 'api', 'history']),
      type: template ? 'template' : r.pick(['text', 'text', 'image', 'note', 'reaction']),
      status: inbound ? 'received' : r.pick(MSG_STATUSES),
      sentBy: inbound ? null : r.pick([null, ...users]),
      template: template
        ? {
            templateId: r.pick(templates),
            name: 't',
            language: 'en',
            category: 'utility',
            parameters: [],
          }
        : null,
    });
  });
  const ledger = Array.from({ length: input.ledger }, () =>
    ledgerDoc(accountId, {
      createdAt: at(),
      updatedAt: input.end,
      type: r.pick(['call_charge', 'ai_charge', 'whatsapp_charge', 'topup', 'adjustment']),
      direction: 'debit',
      status: r.pick(['captured', 'captured', 'held', 'released']),
      amountMicros: 1 + r.int(5_000_000),
      ref:
        r.int(2) === 0 && calls.length
          ? { type: 'call', id: r.pick(calls)._id.toString() }
          : { type: 'manual', id: 'x' },
    }),
  );
  if (calls.length) await CallModel.collection.insertMany(calls);
  if (messages.length) await MessageModel.collection.insertMany(messages);
  if (ledger.length) await LedgerEntryModel.collection.insertMany(ledger);
  return { calls, messages, ledger };
};

export type Totals = Map<string, Record<string, number>>;

const bump = (t: Totals, key: string, counter: string, by = 1) => {
  const row = t.get(key) ?? {};
  row[counter] = (row[counter] ?? 0) + by;
  t.set(key, row);
};

const BUSINESS = ['agent', 'business_app', 'api', 'system'];
const SKIP = ['note', 'reaction', 'system', 'call'];
const SPEND = [
  'call_charge',
  'ai_charge',
  'tts_charge',
  'recording_charge',
  'whatsapp_charge',
  'whatsapp_call_charge',
  'subscription',
];

/**
 * Account-wide totals counted straight from raw rows, written independently of the
 * analytics code (the "count from raw" check): `day|channel|test` → counters.
 */
export const countFromRaw = async (
  accountId: Types.ObjectId,
  timeZone: string,
): Promise<Totals> => {
  const t: Totals = new Map();
  const calls = await CallModel.collection.find({ accountId }).toArray();
  for (const c of calls) {
    if (['queued', 'ringing', 'in_progress'].includes(c.status as string)) continue;
    const ts = c.timestamps as { ringingAt: Date | null; answeredAt: Date | null };
    if (c.status === 'canceled' && !ts.ringingAt && !ts.answeredAt) continue;
    const key = `${ymdInZone(c.createdAt as Date, timeZone)}|${c.whatsapp ? 'whatsapp' : 'voice'}|${c.isTest ? 't' : 'f'}`;
    bump(t, key, 'calls_attempted');
    if (ts.answeredAt) {
      bump(t, key, 'calls_answered');
      bump(t, key, 'calls_talk_sec', Math.round(c.durationSec as number));
    }
  }
  const messages = await MessageModel.collection.find({ accountId }).toArray();
  for (const m of messages) {
    const key = `${ymdInZone(m.at as Date, timeZone)}|whatsapp|f`;
    if (SKIP.includes(m.type as string)) continue;
    if (m.direction === 'in' && m.origin === 'customer') bump(t, key, 'msg_inbound');
    if (m.direction !== 'out' || !BUSINESS.includes(m.origin as string)) continue;
    if (['sent', 'delivered', 'read'].includes(m.status as string)) bump(t, key, 'msg_sent');
    if (['delivered', 'read'].includes(m.status as string)) bump(t, key, 'msg_delivered');
    if (m.status === 'read') bump(t, key, 'msg_read');
    if (m.status === 'failed') bump(t, key, 'msg_failed');
  }
  const ledger = await LedgerEntryModel.collection.find({ accountId }).toArray();
  for (const e of ledger) {
    if (e.status !== 'captured' || e.direction !== 'debit' || !SPEND.includes(e.type as string))
      continue;
    bump(
      t,
      `${ymdInZone(e.createdAt as Date, timeZone)}|money|f`,
      'spend_total',
      e.amountMicros as number,
    );
  }
  return t;
};

/** The same totals as stored in `statsDaily` (kind `all`), limited to the counters `countFromRaw` knows. */
export const storedTotals = async (accountId: Types.ObjectId, like: Totals): Promise<Totals> => {
  const names = new Set([...like.values()].flatMap((c) => Object.keys(c)));
  const rows = await StatsDailyModel.find({ accountId, kind: 'all' }).lean<StatsDailyDoc[]>();
  const t: Totals = new Map();
  for (const s of rows) {
    const counters = s.counters as unknown as Record<string, number>;
    const kept = Object.fromEntries(
      Object.entries(counters).filter(([k, v]) => names.has(k) && v !== 0),
    );
    if (Object.keys(kept).length) t.set(`${s.day}|${s.channel}|${s.test ? 't' : 'f'}`, kept);
  }
  return t;
};
