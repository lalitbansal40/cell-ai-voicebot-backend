import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Types } from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';

import { CallInsightModel } from '../../src/db/models/call-insight.model';
import { CallModel, emptyCallCost, emptyCallMetrics } from '../../src/db/models/call.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { ConversationModel } from '../../src/db/models/conversation.model';
import { MessageModel } from '../../src/db/models/message.model';
import { WebhookEventModel } from '../../src/db/models/webhook-event.model';
import { WEBHOOK_EVENT_TYPES, withoutPersonalData } from '../../src/modules/webhooks/events';
import { recordingWebhookJobs, setWebhookJobs } from '../../src/modules/webhooks/jobs';
import {
  publishCallCompleted,
  publishCallStarted,
  publishCampaignCompleted,
  publishContactOpt,
  publishInsightsReady,
  publishPhoneOpt,
} from '../../src/modules/webhooks/publish';
import { SAMPLE_DATA } from '../../src/modules/webhooks/samples';
import { useTestDb } from '../helpers/db';
import { customerText, uniqueWamid, useInboxWorld, valueOf } from '../helpers/inbox';

useTestDb();
const world = useInboxWorld();
const { state } = world;

beforeEach(async () => {
  setWebhookJobs(recordingWebhookJobs());
  await WebhookEventModel.createIndexes();
  await world.setup();
});

const eventsOf = (type: string) =>
  WebhookEventModel.find({ accountId: state.acc.account._id, type }).sort({ createdAt: 1 }).lean();

const contact = (over: Record<string, unknown> = {}) =>
  ContactModel.create({
    accountId: state.acc.account._id,
    phoneE164: `+91900077${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`,
    name: 'Asha Verma',
    externalId: `CUST-${String(Math.floor(Math.random() * 1e6))}`,
    source: { type: 'manual' },
    ...over,
  });

const call = async (over: Record<string, unknown> = {}) => {
  const c = await contact();
  return {
    contact: c,
    call: await CallModel.create({
      accountId: state.acc.account._id,
      direction: 'outbound',
      provider: 'dryrun',
      from: 'dryrun',
      to: c.phoneE164,
      status: 'completed',
      endReason: 'hangup_node',
      isTest: true,
      charged: false,
      contactId: c._id,
      externalRef: 'loan-9',
      source: { kind: 'flow', flowId: new Types.ObjectId() },
      timestamps: { queuedAt: new Date(), answeredAt: new Date(), endedAt: new Date() },
      durationSec: 61,
      disposition: 'promise_to_pay',
      dispositionSource: 'flow',
      metrics: emptyCallMetrics(),
      cost: { ...emptyCallCost(), totalMicros: 1_500_000 },
      ...over,
    }),
  };
};

describe('call events', () => {
  it('call.started + call.completed: the stored call, once each (settle retries ignored)', async () => {
    const { call: c, contact: who } = await call();
    await publishCallStarted(c._id.toString());
    await publishCallCompleted(c._id.toString());
    await publishCallCompleted(c._id.toString()); // a retry
    await publishCallStarted(c._id.toString());
    const [started] = await eventsOf('call.started');
    const completed = await eventsOf('call.completed');
    expect(completed).toHaveLength(1);
    expect(await eventsOf('call.started')).toHaveLength(1);
    expect(started?.data).toMatchObject({
      callId: c._id.toString(),
      contactExternalId: who.externalId,
      externalRef: 'loan-9',
      provider: 'dryrun',
      direction: 'outbound',
    });
    expect(completed[0]?.data).toEqual({
      callId: c._id.toString(),
      contactId: who._id.toString(),
      contactExternalId: who.externalId,
      externalRef: 'loan-9',
      provider: 'dryrun',
      direction: 'outbound',
      campaignId: null,
      flowId: c.source.flowId?.toString(),
      agentId: null,
      status: 'completed',
      endReason: 'hangup_node',
      durationSec: 61,
      costMicros: 1_500_000,
      disposition: 'promise_to_pay',
      dispositionSource: 'flow',
      recording: false,
      phone: who.phoneE164,
      name: 'Asha Verma',
    });
    // without the personal-data opt-in the endpoint gets ids only
    const filtered = withoutPersonalData(completed[0]?.data ?? {});
    expect(filtered).not.toHaveProperty('phone');
    expect(filtered).not.toHaveProperty('name');
  });

  it('a call that has not ended sends no call.completed; unknown calls send nothing', async () => {
    const { call: c } = await call({ timestamps: { queuedAt: new Date() }, status: 'ringing' });
    await publishCallCompleted(c._id.toString());
    await publishCallStarted(new Types.ObjectId().toString());
    expect(await eventsOf('call.completed')).toHaveLength(0);
    expect(await eventsOf('call.started')).toHaveLength(0);
  });

  it('WhatsApp calls add whatsapp.call.started / ended; an unanswered inbound call is missed', async () => {
    const wa = (direction: 'USER_INITIATED' | 'BUSINESS_INITIATED', answered: boolean) =>
      call({
        provider: 'whatsapp',
        direction: direction === 'USER_INITIATED' ? 'inbound' : 'outbound',
        status: answered ? 'completed' : 'no_answer',
        timestamps: {
          queuedAt: new Date(),
          ...(answered ? { answeredAt: new Date() } : {}),
          endedAt: new Date(),
        },
        whatsapp: {
          channelId: state.channel._id,
          direction,
          answeredBy: answered ? new Types.ObjectId() : null,
        },
      });
    const answered = await wa('USER_INITIATED', true);
    const missed = await wa('USER_INITIATED', false);
    const outbound = await wa('BUSINESS_INITIATED', false);
    for (const x of [answered, missed, outbound]) {
      await publishCallStarted(x.call._id.toString());
      await publishCallCompleted(x.call._id.toString());
    }
    expect((await eventsOf('whatsapp.call.started')).length).toBe(3);
    const ended = await eventsOf('whatsapp.call.ended');
    const missedRows = await eventsOf('whatsapp.call.missed');
    expect(ended.map((e) => e.data.callId).sort()).toEqual(
      [answered.call._id.toString(), outbound.call._id.toString()].sort(),
    );
    expect(missedRows.map((e) => e.data.callId)).toEqual([missed.call._id.toString()]);
    expect(missedRows[0]?.data).toMatchObject({
      direction: 'inbound',
      channelId: state.channel._id.toString(),
      answeredBy: null,
    });
  });

  it('call.insights.ready per version with the summary as personal data', async () => {
    const { call: c } = await call();
    await CallInsightModel.create({
      accountId: state.acc.account._id,
      callId: c._id,
      version: 1,
      status: 'done',
      output: {
        summary: 'Will pay ₹2,500 tomorrow.',
        suggestedDisposition: 'promise_to_pay',
        sentiment: { label: 'positive', score: 0.8 },
        keyInfo: {
          promiseDate: '2026-11-05',
          promiseAmountMicros: 2_500_000_000,
          callbackAt: null,
          disputeReason: null,
          wrongNumber: false,
          languagePreference: null,
          notes: null,
        },
        confidence: { disposition: 0.9, promise: 0.9, sentiment: 0.9 },
      },
    });
    await publishInsightsReady(c._id, 1);
    await publishInsightsReady(c._id, 1);
    await publishInsightsReady(c._id, 2); // a regenerate without a row yet (skipped)
    const rows = await eventsOf('call.insights.ready');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.data).toMatchObject({
      status: 'done',
      sentiment: 'positive',
      keyInfo: { promiseDate: '2026-11-05', promiseAmountMicros: 2_500_000_000 },
      summary: 'Will pay ₹2,500 tomorrow.',
      externalRef: 'loan-9',
    });
    expect(withoutPersonalData(rows[0]?.data ?? {})).not.toHaveProperty('summary');
  });
});

describe('campaign and contact events', () => {
  it('campaign.completed with counts, outcomes and cost (once)', async () => {
    const campaign = {
      _id: new Types.ObjectId(),
      accountId: state.acc.account._id,
      parentId: null,
      mode: 'dry_run',
      stats: {
        total: 10,
        attempts: 14,
        answered: 7,
        completed: 8,
        failed: 2,
        skipped: 0,
        canceled: 0,
        dispositions: { promise_to_pay: 3, callback: 0 },
        spentMicros: 0,
      },
    } as never;
    await publishCampaignCompleted(campaign);
    await publishCampaignCompleted(campaign);
    const rows = await eventsOf('campaign.completed');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toMatchObject({
      counts: { contacts: 10, calls: 14, answered: 7, completed: 8, failed: 2 },
      outcomes: { promise_to_pay: 3 },
      dryRun: true,
    });
  });

  it('contact.opted_out / opted_in for a contact and for every contact of a DND phone', async () => {
    const c = await contact();
    await publishContactOpt(c, 'opted_out', 'calls', 'manual');
    await publishPhoneOpt(state.acc.account._id, c.phoneE164, 'opted_in', 'dnd_list');
    const out = await eventsOf('contact.opted_out');
    const inn = await eventsOf('contact.opted_in');
    expect(out[0]?.data).toEqual({
      contactId: c._id.toString(),
      contactExternalId: c.externalId,
      channel: 'calls',
      source: 'manual',
      phone: c.phoneE164,
    });
    expect(inn[0]?.data).toMatchObject({ channel: 'calls', source: 'dnd_list' });
  });

  it('samples have the same keys as the real payloads', async () => {
    const { call: c } = await call();
    await publishCallCompleted(c._id.toString());
    const [real] = await eventsOf('call.completed');
    expect(Object.keys(SAMPLE_DATA['call.completed']).sort()).toEqual(
      Object.keys(real?.data ?? {}).sort(),
    );
  });
});

describe('inbox events (real webhook processing)', () => {
  it('whatsapp.message.received once per message, even when Meta redelivers it', async () => {
    const payload = customerText(state.channel, { from: '919000770001', text: 'I paid today' });
    await world.deliver(payload);
    await world.deliver(payload); // Meta retry
    const rows = await eventsOf('whatsapp.message.received');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toMatchObject({ type: 'text', text: 'I paid today' });
    expect(withoutPersonalData(rows[0]?.data ?? {})).not.toHaveProperty('text');
  });

  it('whatsapp.message.status for each forward move only (late / repeated statuses skipped)', async () => {
    await world.deliver(customerText(state.channel, { from: '919000770002' }));
    const conv = await ConversationModel.findOne({ accountId: state.acc.account._id }).lean();
    const wamid = uniqueWamid();
    const msg = await MessageModel.create({
      accountId: state.acc.account._id,
      conversationId: conv?._id,
      channelId: state.channel._id,
      contactId: conv?.contactId,
      direction: 'out',
      origin: 'api',
      type: 'text',
      text: 'Reminder',
      status: 'accepted',
      waMessageId: wamid,
      externalRef: 'reminder-1',
      at: new Date(),
    });
    const status = (value: string) =>
      world.fixture('statuses-sent.json', (p) => {
        const s = (valueOf(p).statuses as Record<string, unknown>[])[0] as Record<string, unknown>;
        Object.assign(s, {
          id: wamid,
          status: value,
          timestamp: String(Math.floor(Date.now() / 1000)),
        });
      });
    await status('sent');
    await status('delivered');
    await status('sent'); // late
    await status('delivered'); // repeat
    await status('read');
    const rows = await eventsOf('whatsapp.message.status');
    expect(rows.map((r) => r.data.status)).toEqual(['sent', 'delivered', 'read']);
    expect(rows[0]?.data).toMatchObject({
      messageId: msg._id.toString(),
      externalRef: 'reminder-1',
    });
  });

  it('STOP / START send contact.opted_out / opted_in (whatsapp), a repeated STOP nothing', async () => {
    await world.deliver(customerText(state.channel, { from: '919000770003', text: 'STOP' }));
    await world.deliver(
      customerText(state.channel, {
        from: '919000770003',
        text: 'STOP',
        at: Math.floor(Date.now() / 1000) + 5,
      }),
    );
    await world.deliver(
      customerText(state.channel, {
        from: '919000770003',
        text: 'START',
        at: Math.floor(Date.now() / 1000) + 10,
      }),
    );
    const out = await eventsOf('contact.opted_out');
    const inn = await eventsOf('contact.opted_in');
    expect(out).toHaveLength(1);
    expect(out[0]?.data).toMatchObject({ channel: 'whatsapp', source: 'stop_keyword' });
    expect(inn).toHaveLength(1);
    expect(inn[0]?.data).toMatchObject({ channel: 'whatsapp', source: 'start_keyword' });
  });
});

describe('docs/api/webhooks.md', () => {
  it('shows every event with exactly the sample payload', () => {
    const doc = readFileSync(path.join(__dirname, '../../docs/api/webhooks.md'), 'utf8');
    for (const type of WEBHOOK_EVENT_TYPES) {
      const at = doc.indexOf(`### \`${type}\``);
      expect(at, type).toBeGreaterThan(0);
      const json = /```json\n([\s\S]*?)\n```/.exec(doc.slice(at))?.[1] ?? '';
      expect(JSON.parse(json), type).toEqual(SAMPLE_DATA[type]);
    }
  });
});
