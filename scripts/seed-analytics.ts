/**
 * DEV / STAGING DEMO (Phase 14) — report history: `days` days (default 60) of calls of
 * every kind (flow / agent / campaign dry run / WhatsApp, answered or not) with post-call
 * insights written as the fake provider would ("Demo:" summaries, no OpenAI calls),
 * WhatsApp messages with status sequences and template sends on the demo number,
 * and AI charges through the billing engine (so the wallet still equals its ledger);
 * then the account's rollups are rebuilt for the range. Deterministic (fixed seed),
 * idempotent (marker `variables.seed`). `isTest` marks everything as test traffic
 * (the staging review account).
 */
import { Types } from 'mongoose';

import { chargeUsage, credit } from '../src/core/billing/engine';
import { AccountModel } from '../src/db/models/account.model';
import { AiAgentModel } from '../src/db/models/ai-agent.model';
import { CallInsightModel } from '../src/db/models/call-insight.model';
import {
  CallModel,
  emptyCallCost,
  emptyCallMetrics,
  type CallStatus,
  type Sentiment,
} from '../src/db/models/call.model';
import { CampaignModel } from '../src/db/models/campaign.model';
import { ContactModel } from '../src/db/models/contact.model';
import { ConversationModel } from '../src/db/models/conversation.model';
import { FlowModel } from '../src/db/models/flow.model';
import { LedgerEntryModel } from '../src/db/models/ledger-entry.model';
import { MessageModel } from '../src/db/models/message.model';
import { UserModel } from '../src/db/models/user.model';
import { WhatsAppChannelModel } from '../src/db/models/whatsapp-channel.model';
import { WhatsAppTemplateModel } from '../src/db/models/whatsapp-template.model';
import { rebuildAccount } from '../src/modules/analytics/rebuild';
import { addDays, startOfDayInZone, ymdInZone } from '../src/shared/time';

export const SEED_ANALYTICS_MARK = 'analytics-v1';
const DAY_MS = 86_400_000;
const MICROS = 1_000_000;

export interface SeedAnalyticsOptions {
  days?: number;
  now?: Date;
  /** Staging review account: everything is test traffic. */
  isTest?: boolean;
}

export interface SeedAnalyticsResult {
  calls: number;
  insights: number;
  messages: number;
  charges: number;
  rollupRows: number;
  skipped?: string;
}

/** Small deterministic generator (mulberry32). */
const prng = (seed: number) => {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
  };
};

const STATUSES: CallStatus[] = [
  'completed',
  'completed',
  'completed',
  'completed',
  'completed',
  'no_answer',
  'no_answer',
  'busy',
  'failed',
  'canceled',
];
const OUTCOMES = [
  'promise_to_pay',
  'promise_to_pay',
  'paid',
  'callback',
  'callback',
  'not_interested',
  'dispute',
  'wrong_number',
  'other',
] as const;
const SUMMARY: Record<(typeof OUTCOMES)[number], string> = {
  promise_to_pay: 'Customer agreed to pay the due amount by the date given.',
  paid: 'Customer said the payment was already made.',
  callback: 'Customer asked for a call back later.',
  not_interested: 'Customer did not want to talk about the loan.',
  dispute: 'Customer disputes the amount due.',
  wrong_number: 'The person who answered is not the customer.',
  other: 'Short call without a clear outcome.',
};
const MOOD: Record<(typeof OUTCOMES)[number], Sentiment> = {
  promise_to_pay: 'positive',
  paid: 'positive',
  callback: 'neutral',
  not_interested: 'negative',
  dispute: 'negative',
  wrong_number: 'neutral',
  other: 'neutral',
};

export const seedAnalytics = async (
  accountId: Types.ObjectId,
  options: SeedAnalyticsOptions = {},
): Promise<SeedAnalyticsResult> => {
  const empty = { calls: 0, insights: 0, messages: 0, charges: 0, rollupRows: 0 };
  if (await CallModel.exists({ accountId, 'variables.seed': SEED_ANALYTICS_MARK }))
    return { ...empty, skipped: 'already seeded' };
  const days = options.days ?? 60;
  const now = options.now ?? new Date();
  const isTest = options.isTest ?? false;
  const prefix = 'Demo: ';
  const rnd = prng(14);
  const account = await AccountModel.findById(accountId).select({ timezone: 1 }).lean();
  const tz = account?.timezone ?? 'Asia/Kolkata';
  const today = ymdInZone(now, tz);

  const [contacts, flows, agents, campaigns, users, channel] = await Promise.all([
    ContactModel.find({ accountId }).select({ _id: 1 }).limit(25).lean(),
    FlowModel.find({ accountId }).select({ _id: 1 }).limit(3).lean(),
    AiAgentModel.find({ accountId }).select({ _id: 1 }).limit(3).lean(),
    CampaignModel.find({ accountId, parentId: null }).select({ _id: 1 }).limit(3).lean(),
    UserModel.find({ accountId, status: 'active' }).select({ _id: 1 }).limit(5).lean(),
    WhatsAppChannelModel.findOne({ accountId }).select({ _id: 1 }).lean(),
  ]);
  if (!contacts.length) return { ...empty, skipped: 'no contacts' };
  const [conversations, templates] = channel
    ? await Promise.all([
        ConversationModel.find({ accountId, channelId: channel._id })
          .select({ _id: 1, contactId: 1 })
          .limit(10)
          .lean<{ _id: Types.ObjectId; contactId: Types.ObjectId }[]>(),
        WhatsAppTemplateModel.find({ accountId, status: 'APPROVED' })
          .select({ _id: 1, name: 1, language: 1, category: 1 })
          .limit(3)
          .lean<{ _id: Types.ObjectId; name: string; language: string; category: string }[]>(),
      ])
    : [[], []];

  const kinds = [
    ...(flows.length ? (['flow'] as const) : []),
    ...(agents.length ? (['agent'] as const) : []),
    ...(campaigns.length && flows.length ? (['campaign'] as const) : []),
    ...(channel && users.length ? (['whatsapp'] as const) : []),
  ];
  if (!kinds.length) return { ...empty, skipped: 'no flows, agents or WhatsApp number' };

  const calls: Record<string, unknown>[] = [];
  const insights: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];
  const spendByDay = new Map<string, number>();

  for (let d = days - 1; d >= 0; d -= 1) {
    const day = addDays(today, -d);
    const dayStart = startOfDayInZone(day, tz).getTime();
    // working hours, account time
    const at = () => new Date(dayStart + rnd.int(9 * 3600, 19 * 3600) * 1000);
    const weekend = new Date(`${day}T00:00:00Z`).getUTCDay() % 6 === 0;
    const count = weekend ? rnd.int(2, 6) : rnd.int(8, 18);
    for (let i = 0; i < count; i += 1) {
      const kind = rnd.pick(kinds);
      const created = at();
      if (created > now) continue;
      const status = rnd.pick(STATUSES);
      const answered = status === 'completed';
      const durationSec = answered ? rnd.int(25, 260) : 0;
      const ended = new Date(created.getTime() + (durationSec + 12) * 1000);
      const outcome = answered ? rnd.pick(OUTCOMES) : null;
      const contactId = rnd.pick(contacts)._id;
      const aiMicros = answered && kind !== 'whatsapp' ? durationSec * 6_000 : 0;
      const telephonyMicros = kind === 'campaign' ? 0 : durationSec * 8_000;
      const _id = new Types.ObjectId();
      const whatsappCall = kind === 'whatsapp' && channel;
      const answeredBy = whatsappCall && answered ? rnd.pick(users)._id : null;
      const promise = outcome === 'promise_to_pay';
      const amountMicros = promise ? rnd.int(2, 40) * 500 * MICROS : null;
      const doc = new CallModel({
        _id,
        accountId,
        direction: whatsappCall && rnd.next() < 0.5 ? 'inbound' : 'outbound',
        provider: kind === 'campaign' ? 'dryrun' : whatsappCall ? 'whatsapp' : 'webcall',
        from: 'demo',
        to: 'demo',
        mode: whatsappCall ? 'human' : 'ai',
        isTest,
        contactId,
        campaignId: kind === 'campaign' ? rnd.pick(campaigns)._id : null,
        source:
          kind === 'agent'
            ? { kind: 'agent', agentId: rnd.pick(agents)._id }
            : kind === 'whatsapp'
              ? { kind: 'whatsapp' }
              : { kind: 'flow', flowId: rnd.pick(flows)._id },
        status,
        durationSec,
        timestamps: {
          queuedAt: created,
          ringingAt: created,
          answeredAt: answered ? new Date(created.getTime() + 8_000) : null,
          endedAt: ended,
        },
        variables: { seed: SEED_ANALYTICS_MARK },
        metrics: emptyCallMetrics(),
        cost: {
          ...emptyCallCost(),
          telephonyMicros,
          aiMicros,
          totalMicros: telephonyMicros + aiMicros,
        },
        agentUserId: null,
        disposition: outcome,
        dispositionSource: outcome ? 'ai' : null,
        insights: answered
          ? {
              status: 'done',
              reason: null,
              version: 1,
              sentiment: outcome ? MOOD[outcome] : null,
              hasPromise: promise,
              promiseAmountMicros: amountMicros,
              hasSummary: true,
              at: new Date(ended.getTime() + 30_000),
            }
          : { status: 'skipped', reason: 'not_answered', version: 1, at: ended },
        ...(whatsappCall
          ? {
              whatsapp: {
                channelId: channel._id,
                direction: 'USER_INITIATED',
                answeredBy,
                timeline: [],
                ringUserIds: [],
              },
            }
          : {}),
      }).toObject({ transform: false, depopulate: true });
      calls.push({ ...doc, createdAt: created, updatedAt: ended });
      if (answered && outcome)
        insights.push({
          accountId,
          callId: _id,
          version: 1,
          status: 'done',
          reason: null,
          output: {
            summary: `${prefix}${SUMMARY[outcome]}`,
            suggestedDisposition: outcome,
            sentiment: { label: MOOD[outcome], score: MOOD[outcome] === 'negative' ? -0.6 : 0.5 },
            keyInfo: {
              promiseDate: promise ? addDays(day, rnd.int(2, 10)) : null,
              promiseAmountMicros: amountMicros,
              callbackAt: null,
              disputeReason: outcome === 'dispute' ? 'Amount' : null,
              wrongNumber: outcome === 'wrong_number',
              languagePreference: null,
              notes: null,
            },
            confidence: { disposition: 0.9, promise: promise ? 0.85 : 0, sentiment: 0.8 },
          },
          model: 'fake',
          promptVersion: 1,
          inputTokens: 0,
          outputTokens: 0,
          costMicros: 0,
          ledgerEntryId: null,
          createdBy: null,
          createdAt: new Date(ended.getTime() + 30_000),
          updatedAt: new Date(ended.getTime() + 30_000),
        });
      if (aiMicros) spendByDay.set(day, (spendByDay.get(day) ?? 0) + aiMicros);
    }

    if (channel && conversations.length && users.length) {
      const sends = weekend ? rnd.int(3, 8) : rnd.int(12, 30);
      for (let i = 0; i < sends; i += 1) {
        const sentAt = at();
        if (sentAt > now) continue;
        const conv = rnd.pick(conversations);
        const template = templates.length && rnd.next() < 0.4 ? rnd.pick(templates) : null;
        const final = rnd.pick([
          'read',
          'read',
          'delivered',
          'delivered',
          'sent',
          'failed',
        ] as const);
        const path = ['sent', 'delivered', 'read'];
        const history =
          final === 'failed'
            ? [{ status: 'failed', at: new Date(sentAt.getTime() + 2_000) }]
            : path
                .slice(0, path.indexOf(final) + 1)
                .map((s, n) => ({ status: s, at: new Date(sentAt.getTime() + (n + 1) * 60_000) }));
        messages.push({
          _id: new Types.ObjectId(),
          accountId,
          conversationId: conv._id,
          channelId: channel._id,
          contactId: conv.contactId,
          direction: 'out',
          origin: 'agent',
          type: template ? 'template' : 'text',
          text: null,
          status: final,
          statusHistory: history,
          sentBy: rnd.pick(users)._id,
          template: template
            ? {
                templateId: template._id,
                name: template.name,
                language: template.language,
                category: template.category,
              }
            : null,
          reactions: [],
          at: sentAt,
          createdAt: sentAt,
          updatedAt: sentAt,
        });
        // about a third of business messages get a customer reply
        if (final === 'read' && rnd.next() < 0.35) {
          const replyAt = new Date(sentAt.getTime() + rnd.int(2, 90) * 60_000);
          if (replyAt <= now)
            messages.push({
              _id: new Types.ObjectId(),
              accountId,
              conversationId: conv._id,
              channelId: channel._id,
              contactId: conv.contactId,
              direction: 'in',
              origin: 'customer',
              type: 'text',
              text: null,
              status: 'received',
              statusHistory: [],
              sentBy: null,
              template: null,
              reactions: [],
              at: replyAt,
              createdAt: replyAt,
              updatedAt: replyAt,
            });
        }
      }
    }
  }

  if (calls.length) await CallModel.collection.insertMany(calls);
  if (insights.length) await CallInsightModel.collection.insertMany(insights);
  if (messages.length) await MessageModel.collection.insertMany(messages);

  // AI spend through the engine (the wallet stays equal to its ledger), dated on its day
  let charges = 0;
  const total = [...spendByDay.values()].reduce((a, b) => a + b, 0);
  if (total > 0) {
    await credit({
      accountId,
      type: 'adjustment',
      amountMicros: total,
      ref: { type: 'seed', id: SEED_ANALYTICS_MARK },
      idempotencyKey: `seed-${SEED_ANALYTICS_MARK}-credit`,
      note: 'Demo report history',
    });
    for (const [day, amount] of spendByDay) {
      const key = `seed-${SEED_ANALYTICS_MARK}-ai-${day}`;
      await chargeUsage({
        accountId,
        type: 'ai_charge',
        amountMicros: amount,
        ref: { type: 'usage', id: `demo-${day}` },
        idempotencyKey: key,
      });
      const when = new Date(startOfDayInZone(day, tz).getTime() + 20 * 3600 * 1000);
      // DEV / demo seed only: the row keeps its amount (the wallet is untouched) and is
      // dated on its demo day through the driver, past the insert-only model guard
      await LedgerEntryModel.collection.updateOne(
        { accountId, idempotencyKey: key },
        { $set: { createdAt: when, updatedAt: when } },
      );
      charges += 1;
    }
  }

  const rebuilt = await rebuildAccount({
    accountId,
    from: addDays(today, -(days - 1)),
    to: today,
  });
  return {
    calls: calls.length,
    insights: insights.length,
    messages: messages.length,
    charges,
    rollupRows: rebuilt.rows,
  };
};

export { DAY_MS as SEED_DAY_MS };
