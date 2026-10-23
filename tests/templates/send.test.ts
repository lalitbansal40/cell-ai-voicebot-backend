import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { Types } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MetaApiError, type MetaMessagePayload } from '../../src/core/meta';
import { setRealtime } from '../../src/core/realtime';
import { ContactModel } from '../../src/db/models/contact.model';
import { ConversationModel, type ConversationDoc } from '../../src/db/models/conversation.model';
import { CustomFieldModel } from '../../src/db/models/custom-field.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { MessageModel, type MessageDoc } from '../../src/db/models/message.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import {
  WhatsAppTemplateModel,
  type WhatsAppTemplateDoc,
} from '../../src/db/models/whatsapp-template.model';
import { INBOX_JOBS } from '../../src/modules/inbox/jobs';
import type { SendMessageInput } from '../../src/modules/inbox/outbound.schema';
import {
  queueSystemText,
  retryMessage,
  sendMessage,
} from '../../src/modules/inbox/outbound.service';
import { processSend } from '../../src/modules/inbox/send.job';
import { createUpload } from '../../src/modules/inbox/upload.service';
import { uploadHeaderExample } from '../../src/modules/templates/example-media.service';
import { formatVariableValue } from '../../src/modules/templates/format';
import { recordingTemplateJobs } from '../../src/modules/templates/jobs';
import {
  createTemplate,
  setVariableSources,
  submitTemplate,
} from '../../src/modules/templates/template.service';
import { createWhatsAppBillingHook } from '../../src/modules/whatsapp-billing/billing-hook';
import { createLogger, setLogger } from '../../src/shared/logger';
import { expectWalletConsistent } from '../helpers/billing';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { customerText, mediaFixture, useInboxWorld, valueOf } from '../helpers/inbox';
import { userActor } from '../helpers/whatsapp';

const cases = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/template-format-cases.json'), 'utf8'),
) as unknown[];

useTestDb();
useCapturedEmail();
const world = useInboxWorld();
const { state } = world;
const templateJobs = recordingTemplateJobs();

const logLines: string[] = [];
beforeEach(() => {
  setRealtime(undefined);
  logLines.length = 0;
  setLogger(
    createLogger(
      { NODE_ENV: 'test', LOG_LEVEL: 'trace' },
      new Writable({
        write(chunk: Buffer, _enc, done) {
          logLines.push(chunk.toString());
          done();
        },
      }),
    ),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  setLogger(createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
});

let users: Awaited<ReturnType<typeof world.setup>>['users'];
let conv: ConversationDoc;
let n = 0;

/** A fresh account + number; a conversation (window open unless `closed`). */
const fresh = async (opts: { closed?: boolean; customer?: string } = {}) => {
  n += 1;
  ({ users } = await world.setup());
  state.ix.billing = createWhatsAppBillingHook();
  state.ix.templateJobs = templateJobs;
  templateJobs.syncs.length = 0;
  const from = opts.customer ?? `91900005${String(1000 + n).padStart(4, '0')}`;
  await world.deliver(customerText(state.channel, { from }));
  conv = (await ConversationModel.findOne({
    accountId: state.acc.account._id,
    waId: from,
  }).lean())!;
  if (opts.closed) {
    await ConversationModel.updateOne(
      { _id: conv._id },
      { $set: { windowExpiresAt: new Date(Date.now() - 1000) } },
    );
    conv = (await ConversationModel.findById(conv._id).lean())!;
  }
  world.jobs.sent.length = 0;
  return from;
};
const actor = () => ({ accountId: state.acc.account._id, userId: users.agent.user._id });
type Draft<T> = T extends unknown ? Omit<T, 'clientId'> & { clientId?: string } : never;
const send = (input: Draft<SendMessageInput>, conversationId = conv._id.toString()) =>
  sendMessage(state.ix, actor(), conversationId, { clientId: randomUUID(), ...input });

const tx = () => ({ wa: world.w.ctx, jobs: recordingTemplateJobs(), storage: world.storage });

/** An approved template on the current number (fake: `instant` names approve at once). */
const approved = async (over: Record<string, unknown> = {}) => {
  const r = await createTemplate(tx(), state.acc.account._id, userActor(users.owner.user._id), {
    channelId: state.channel._id.toString(),
    name: `t${String(n)}_${randomUUID().slice(0, 6)}_instant`,
    language: 'en',
    category: 'UTILITY',
    components: [
      { type: 'BODY', text: 'Hi {{1}}, your EMI is due.', example: { body_text: [['A']] } },
    ],
    ...over,
  });
  return (await WhatsAppTemplateModel.findById(r.id).lean<WhatsAppTemplateDoc>())!;
};

const capture = () => {
  const payloads: MetaMessagePayload[] = [];
  const real = world.w.fake.sendMessage.bind(world.w.fake);
  vi.spyOn(world.w.fake, 'sendMessage').mockImplementation(async (token, phone, payload) => {
    payloads.push(payload);
    return real(token, phone, payload);
  });
  return payloads;
};

const runSends = async () => {
  const out = [];
  for (const job of world.jobs.sent.splice(0)) {
    if (job.name !== INBOX_JOBS.messageSend) continue;
    for (let waits = 0; ; waits += 1) {
      const r = await processSend(state.ix, job.id, { finalAttempt: true, waits });
      if (r.kind !== 'wait' && r.kind !== 'later') {
        out.push(r);
        break;
      }
    }
  }
  return out;
};
const reload = (m: MessageDoc) => MessageModel.findById(m._id).lean<MessageDoc>();
const status = (wamid: string, value: string, pricing: Record<string, unknown> | null) =>
  world.fixture('statuses-sent.json', (p) => {
    const s = (valueOf(p).statuses as Record<string, unknown>[])[0]!;
    Object.assign(s, {
      id: wamid,
      status: value,
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    if (pricing) s.pricing = pricing;
    else delete s.pricing;
  });
const holdsOf = () =>
  LedgerEntryModel.find({ accountId: state.acc.account._id, type: 'whatsapp_charge' }).lean();

describe('template payloads (exact Graph bodies)', () => {
  it('positional: text header, body in order, URL suffix, copy code, quick replies', async () => {
    await fresh();
    const t = await approved({
      category: 'MARKETING',
      components: [
        { type: 'HEADER', format: 'TEXT', text: 'Order {{1}}', example: { header_text: ['O-1'] } },
        {
          type: 'BODY',
          text: 'Hi {{1}}, total {{2}} today.',
          example: { body_text: [['A', 'B']] },
        },
        { type: 'FOOTER', text: 'Reply STOP to opt out' },
        {
          type: 'BUTTONS',
          buttons: [
            { type: 'QUICK_REPLY', text: 'Yes' },
            {
              type: 'URL',
              text: 'Pay',
              url: 'https://pay.example.test/p/{{1}}',
              example: ['https://pay.example.test/p/42'],
            },
            { type: 'COPY_CODE', example: 'SAVE20' },
          ],
        },
      ],
    });
    const payloads = capture();
    const r = await send({
      type: 'template',
      templateId: t._id.toString(),
      variables: {
        header_1: 'ORD 7',
        '1': 'Asha',
        '2': '₹1,200.00',
        button_1: 'a b/42',
        copy_code_2: 'OFF10',
      },
    });
    expect(r.message).toMatchObject({
      type: 'template',
      text: 'Order ORD 7\n\nHi Asha, total ₹1,200.00 today.\n\nReply STOP to opt out',
      template: { name: t.name, language: 'en', category: 'MARKETING' },
    });
    await runSends();
    expect(payloads[0]).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: conv.waId,
      type: 'template',
      template: {
        name: t.name,
        language: { code: 'en' },
        components: [
          { type: 'header', parameters: [{ type: 'text', text: 'ORD 7' }] },
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Asha' },
              { type: 'text', text: '₹1,200.00' },
            ],
          },
          {
            type: 'button',
            sub_type: 'quick_reply',
            index: '0',
            parameters: [{ type: 'payload', payload: `qr_${t._id.toString()}_0` }],
          },
          {
            type: 'button',
            sub_type: 'url',
            index: '1',
            parameters: [{ type: 'text', text: 'a%20b%2F42' }],
          },
          {
            type: 'button',
            sub_type: 'copy_code',
            index: '2',
            parameters: [{ type: 'coupon_code', coupon_code: 'OFF10' }],
          },
        ],
      },
    });
  });

  it('named variables; sources: contact name / phone / email, custom field (formatted), static', async () => {
    await fresh();
    await ContactModel.updateOne(
      { _id: conv.contactId },
      {
        $set: {
          name: 'Asha Rao',
          email: 'asha@example.test',
          variables: { emi_amount: 2_500_500_000, due_date: '2026-11-05' },
        },
      },
    );
    await CustomFieldModel.create({
      accountId: state.acc.account._id,
      key: 'emi_amount',
      label: 'EMI',
      type: 'currency',
    });
    await CustomFieldModel.create({
      accountId: state.acc.account._id,
      key: 'due_date',
      label: 'Due',
      type: 'date',
    });
    const t = await approved({
      parameterFormat: 'named',
      components: [
        {
          type: 'BODY',
          text: 'Dear {{name}}, pay {{amount}} by {{due}} ({{phone}} / {{mail}}) — {{brand}} ok',
          example: {
            body_text_named_params: ['name', 'amount', 'due', 'phone', 'mail', 'brand'].map(
              (p) => ({ param_name: p, example: 'x' }),
            ),
          },
        },
      ],
    });
    await setVariableSources(state.acc.account._id, userActor(), t._id.toString(), [
      { key: 'name', kind: 'contact.name' },
      { key: 'amount', kind: 'field', value: 'emi_amount' },
      { key: 'due', kind: 'field', value: 'due_date' },
      { key: 'phone', kind: 'contact.phone' },
      { key: 'mail', kind: 'contact.email' },
      { key: 'brand', kind: 'static', value: 'Demo Finance' },
    ]);
    const payloads = capture();
    const r = await send({ type: 'template', templateId: t._id.toString() });
    expect(r.message.text).toContain('Dear Asha Rao, pay ₹2,500.50 by 05 Nov 2026');
    expect(r.message.text).toContain('— Demo Finance ok');
    await runSends();
    const body = (
      payloads[0]?.template as {
        components: { parameters: { parameter_name: string; text: string }[] }[];
      }
    ).components[0]?.parameters;
    expect(body?.map((p) => [p.parameter_name, p.text])).toEqual([
      ['name', 'Asha Rao'],
      ['amount', '₹2,500.50'],
      ['due', '05 Nov 2026'],
      ['phone', expect.stringMatching(/^\+91 \d{5} \d{5}$/)],
      ['mail', 'asha@example.test'],
      ['brand', 'Demo Finance'],
    ]);
  });

  it('media headers: the stored example (copied) or a fresh upload; location header', async () => {
    await fresh();
    const draft = await createTemplate(tx(), state.acc.account._id, userActor(), {
      channelId: state.channel._id.toString(),
      name: `img_${String(n)}_instant`,
      language: 'en',
      category: 'MARKETING',
      submit: false,
      components: [
        { type: 'HEADER', format: 'IMAGE' },
        { type: 'BODY', text: 'New offer for you today.' },
      ],
    });
    await uploadHeaderExample(tx(), state.acc.account._id, userActor(), draft.id, {
      bytes: mediaFixture('sample.png'),
      mimeType: 'image/png',
      fileName: 'offer.png',
    });
    await submitTemplate(tx(), state.acc.account._id, userActor(), draft.id);
    const t = (await WhatsAppTemplateModel.findById(draft.id).lean<WhatsAppTemplateDoc>())!;
    const payloads = capture();
    const r = await send({ type: 'template', templateId: t._id.toString() });
    expect(r.message.media?.storageKey).toMatch(/\/inbox-media\//);
    expect(r.message.media?.storageKey).not.toBe(t.headerMedia?.storageKey);
    await runSends();
    expect((payloads[0]?.template as { components: unknown[] }).components[0]).toEqual({
      type: 'header',
      parameters: [{ type: 'image', image: { id: expect.stringMatching(/^fake_media_/) } }],
    });

    // a synced template without our stored example: the sender attaches the file
    const video = await WhatsAppTemplateModel.create({
      accountId: state.acc.account._id,
      wabaId: state.channel.wabaId,
      metaTemplateId: `meta-video-${String(n)}`,
      name: `video_${String(n)}`,
      language: 'en',
      category: 'UTILITY',
      status: 'APPROVED',
      components: [
        { type: 'HEADER', format: 'VIDEO' },
        { type: 'BODY', text: 'Watch this now.' },
      ],
    });
    await expect(
      send({ type: 'template', templateId: video._id.toString() }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'header.mediaToken' }],
    });
    const up = await createUpload(state.ix, {
      ...actor(),
      kind: 'video',
      bytes: mediaFixture('sample.mp4'),
      declaredMime: 'video/mp4',
    });
    await send({
      type: 'template',
      templateId: video._id.toString(),
      header: { mediaToken: up._id.toString() },
    });

    const loc = await approved({
      components: [
        { type: 'HEADER', format: 'LOCATION' },
        { type: 'BODY', text: 'Visit our branch.' },
      ],
    });
    await expect(send({ type: 'template', templateId: loc._id.toString() })).rejects.toMatchObject({
      details: [{ path: 'header.location' }],
    });
    await send({
      type: 'template',
      templateId: loc._id.toString(),
      header: { location: { latitude: 26.9, longitude: 75.8, name: 'Branch', address: 'Jaipur' } },
    });
    await runSends();
    expect((payloads.at(-1)?.template as { components: unknown[] }).components[0]).toEqual({
      type: 'header',
      parameters: [
        {
          type: 'location',
          location: { latitude: 26.9, longitude: 75.8, name: 'Branch', address: 'Jaipur' },
        },
      ],
    });
  });

  it('formatter mirrors the frontend (shared cases)', () => {
    for (const c of cases as {
      type: 'currency' | 'number' | 'date' | 'phone' | 'text';
      value: string | number;
      text: string | null;
    }[]) {
      expect(formatVariableValue(c.type, c.value), JSON.stringify(c)).toBe(c.text);
    }
  });
});

describe('template rules', () => {
  it('works with a closed window (text does not)', async () => {
    await fresh({ closed: true });
    const t = await approved();
    await expect(send({ type: 'text', text: 'hi' })).rejects.toMatchObject({
      code: 'WHATSAPP_WINDOW_CLOSED',
    });
    const r = await send({
      type: 'template',
      templateId: t._id.toString(),
      variables: { '1': 'Asha' },
    });
    expect(r.created).toBe(true);
  });

  it('not approved / paused / another WABA / missing variables (keys only)', async () => {
    await fresh();
    const t = await approved();
    await WhatsAppTemplateModel.updateOne({ _id: t._id }, { $set: { status: 'PENDING' } });
    await expect(send({ type: 'template', templateId: t._id.toString() })).rejects.toMatchObject({
      code: 'TEMPLATE_NOT_APPROVED',
    });
    await WhatsAppTemplateModel.updateOne(
      { _id: t._id },
      { $set: { status: 'PAUSED', pausedUntil: new Date(Date.now() + 3_600_000) } },
    );
    await expect(send({ type: 'template', templateId: t._id.toString() })).rejects.toMatchObject({
      code: 'TEMPLATE_PAUSED',
    });
    await WhatsAppTemplateModel.updateOne(
      { _id: t._id },
      { $set: { status: 'APPROVED', pausedUntil: null, wabaId: 'other' } },
    );
    await expect(send({ type: 'template', templateId: t._id.toString() })).rejects.toMatchObject({
      code: 'TEMPLATE_NOT_FOUND',
    });
    await WhatsAppTemplateModel.updateOne(
      { _id: t._id },
      { $set: { wabaId: state.channel.wabaId } },
    );
    await expect(send({ type: 'template', templateId: t._id.toString() })).rejects.toMatchObject({
      code: 'TEMPLATE_VARIABLES_MISSING',
      details: [{ path: '1', message: 'Missing value' }],
    });
    await expect(
      send({ type: 'template', templateId: new Types.ObjectId().toString() }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
    expect(await holdsOf()).toEqual([]);
  });

  it('marketing: opted out / DND / stopped refused; utility: only DND refused; 1 marketing / 24 h', async () => {
    await fresh();
    const mkt = await approved({ category: 'MARKETING' });
    const util = await approved();
    const v = { variables: { '1': 'Asha' } };
    await ContactModel.updateOne({ _id: conv.contactId }, { $set: { optedOutAt: new Date() } });
    await expect(
      send({ type: 'template', templateId: mkt._id.toString(), ...v }),
    ).rejects.toMatchObject({
      code: 'TEMPLATE_MARKETING_BLOCKED',
      details: [{ message: 'opted_out' }],
    });
    await send({ type: 'template', templateId: util._id.toString(), ...v });
    await ContactModel.updateOne(
      { _id: conv.contactId },
      {
        $set: {
          optedOutAt: null,
          'whatsapp.marketing': { stopped: true, at: new Date(), source: 'user_preferences' },
        },
      },
    );
    await expect(
      send({ type: 'template', templateId: mkt._id.toString(), ...v }),
    ).rejects.toMatchObject({ details: [{ message: 'stopped_marketing' }] });
    await ContactModel.updateOne(
      { _id: conv.contactId },
      { $set: { 'whatsapp.marketing': null, dnd: true } },
    );
    await expect(
      send({ type: 'template', templateId: util._id.toString(), ...v }),
    ).rejects.toMatchObject({ details: [{ message: 'dnd' }] });
    await ContactModel.updateOne({ _id: conv.contactId }, { $set: { dnd: false } });
    await send({ type: 'template', templateId: mkt._id.toString(), ...v });
    await expect(
      send({ type: 'template', templateId: mkt._id.toString(), ...v }),
    ).rejects.toMatchObject({
      code: 'WHATSAPP_FREQUENCY_LIMIT',
      retryAfterSec: expect.any(Number),
    });
    // a failed marketing template doesn't count
    await MessageModel.updateMany(
      { conversationId: conv._id, type: 'template' },
      { $set: { status: 'failed' } },
    );
    await send({ type: 'template', templateId: mkt._id.toString(), ...v });
  });
});

describe('holds per path', () => {
  it('refused sends hold nothing; an empty wallet refuses before the message exists', async () => {
    await fresh();
    const t = await approved();
    await WalletModel.updateOne(
      { accountId: state.acc.account._id },
      { $set: { balanceMicros: 0 } },
    );
    await expect(
      send({ type: 'template', templateId: t._id.toString(), variables: { '1': 'A' } }),
    ).rejects.toMatchObject({
      code: 'WALLET_INSUFFICIENT_BALANCE',
      details: [{ path: 'whatsapp' }],
    });
    await expect(send({ type: 'text', text: 'hi' })).rejects.toMatchObject({
      code: 'WALLET_INSUFFICIENT_BALANCE',
    });
    expect(await MessageModel.countDocuments({ conversationId: conv._id, direction: 'out' })).toBe(
      0,
    );
    expect(await holdsOf()).toEqual([]);
  });

  it('idempotent resend holds once; template captured once delivered; usage counted', async () => {
    await fresh();
    const t = await approved();
    const clientId = randomUUID();
    const a = await send({
      clientId,
      type: 'template',
      templateId: t._id.toString(),
      variables: { '1': 'A' },
    });
    const b = await send({
      clientId,
      type: 'template',
      templateId: t._id.toString(),
      variables: { '1': 'A' },
    });
    expect(b.created).toBe(false);
    expect(await holdsOf()).toHaveLength(1);
    // the wallet line links to its chat
    expect((await holdsOf())[0]?.breakdown).toMatchObject({
      kind: 'whatsapp',
      waCategory: 'utility',
      waConversationId: conv._id.toString(),
    });
    expect(a.message.billing).toMatchObject({
      status: 'held',
      category: 'utility',
      market: 'IN',
      priceMicros: 140_000,
      payer: 'platform',
    });
    await runSends();
    const m = (await reload(a.message))!;
    await status(m.waMessageId!, 'sent', {
      billable: true,
      pricing_model: 'PMP',
      category: 'utility',
      type: 'regular',
    });
    expect((await reload(m))?.billing?.status).toBe('held');
    await status(m.waMessageId!, 'delivered', {
      billable: true,
      pricing_model: 'PMP',
      category: 'utility',
      type: 'regular',
    });
    expect((await reload(m))?.billing?.status).toBe('captured');
    expect((await WhatsAppTemplateModel.findById(t._id).lean())?.usage).toMatchObject({
      sent: 1,
      delivered: 1,
    });
    await expectWalletConsistent(state.acc.account._id);
  });

  it('service replies are held; free → released, 00010 knob → captured; notes never; retry holds again', async () => {
    await fresh();
    const free = await send({ type: 'text', text: 'Reply one' });
    expect(free.message.billing).toMatchObject({ status: 'held', category: 'service' });
    const note = await send({ type: 'note', text: 'internal' });
    expect(note.message.billing ?? null).toBeNull();
    await runSends();
    const m = (await reload(free.message))!;
    await status(m.waMessageId!, 'delivered', {
      billable: false,
      pricing_model: 'PMP',
      category: 'service',
      type: 'free_customer_service',
    });
    expect((await reload(m))?.billing?.status).toBe('released');
    // a failed send releases at once; the retry is a new message with a new hold
    world.w.fake.failNext(
      'sendMessage',
      new MetaApiError({
        status: 400,
        code: 131026,
        subcode: null,
        type: 'OAuthException',
        message: 'x',
        fbtraceId: null,
        retryable: false,
        tokenInvalid: false,
      }),
    );
    const doomed = await send({ type: 'text', text: 'Reply two' });
    await runSends();
    expect((await reload(doomed.message))?.billing?.status).toBe('released');
    const retried = await retryMessage(state.ix, actor(), doomed.message._id.toString());
    expect(retried.billing?.status).toBe('held');
    expect(retried.billing?.holdId?.toString()).not.toBe(
      doomed.message.billing?.holdId?.toString(),
    );
    await expectWalletConsistent(state.acc.account._id);
  });

  it('a billable service reply (beyond the free tier) is captured; confirmations are held too', async () => {
    const from = await fresh({ customer: `9190000${String(Date.now()).slice(-1)}00010` });
    expect(from.endsWith('00010')).toBe(true);
    const r = await send({ type: 'text', text: 'Paid reply' });
    await runSends();
    const m = (await reload(r.message))!;
    await status(m.waMessageId!, 'delivered', {
      billable: true,
      pricing_model: 'PMP',
      category: 'service',
      type: 'regular',
    });
    expect((await reload(m))?.billing?.status).toBe('captured');
    const sys = await queueSystemText(state.ix, conv, 'You are unsubscribed');
    expect(sys?.billing).toMatchObject({ status: 'held', category: 'service' });
  });

  it('customer pays Meta: no hold (fee 0), billing kept for the record', async () => {
    await fresh();
    await WhatsAppChannelModel.updateOne(
      { _id: state.channel._id },
      { $set: { metaPayer: 'customer' } },
    );
    const r = await send({ type: 'text', text: 'hi' });
    expect(r.message.billing).toMatchObject({
      payer: 'customer',
      status: 'none',
      priceMicros: 0,
      holdId: null,
    });
    expect(await holdsOf()).toEqual([]);
  });
});

describe('send job — template errors', () => {
  const metaError = (code: number) =>
    new MetaApiError({
      status: 400,
      code,
      subcode: null,
      type: 'OAuthException',
      message: 'x',
      fbtraceId: null,
      retryable: false,
      tokenInvalid: false,
    });

  it('131050 → contact stopped marketing; 132015 / 132016 → template status; 132001 → sync; holds released', async () => {
    await fresh();
    const t = await approved({ category: 'MARKETING' });
    const v = { type: 'template' as const, templateId: t._id.toString(), variables: { '1': 'A' } };
    world.w.fake.failNext('sendMessage', metaError(131050));
    const a = await send(v);
    await runSends();
    expect(await reload(a.message)).toMatchObject({
      status: 'failed',
      error: { code: 131050, reason: 'Customer stopped marketing messages' },
      billing: { status: 'released' },
    });
    expect((await ContactModel.findById(conv.contactId).lean())?.whatsapp?.marketing).toMatchObject(
      {
        stopped: true,
        source: 'error_131050',
      },
    );
    await ContactModel.updateOne({ _id: conv.contactId }, { $set: { 'whatsapp.marketing': null } });
    await MessageModel.updateMany({ conversationId: conv._id }, { $set: { status: 'failed' } });
    world.w.fake.failNext('sendMessage', metaError(132015));
    await send(v);
    await runSends();
    expect((await WhatsAppTemplateModel.findById(t._id).lean())?.status).toBe('PAUSED');
    await WhatsAppTemplateModel.updateOne(
      { _id: t._id },
      { $set: { status: 'APPROVED', pausedUntil: null } },
    );
    world.w.fake.failNext('sendMessage', metaError(132016));
    await send(v);
    await runSends();
    expect((await WhatsAppTemplateModel.findById(t._id).lean())?.status).toBe('DISABLED');
    await WhatsAppTemplateModel.updateOne({ _id: t._id }, { $set: { status: 'APPROVED' } });
    world.w.fake.failNext('sendMessage', metaError(132001));
    await send(v);
    await runSends();
    expect(templateJobs.syncs).toEqual([
      { channelId: state.channel._id.toString(), reason: 'webhook' },
    ]);
    expect((await WhatsAppTemplateModel.findById(t._id).lean())?.usage.failed).toBe(4);
    await expectWalletConsistent(state.acc.account._id);
  });

  it('logs carry no variable values or rendered text', async () => {
    await fresh();
    const t = await approved();
    await send({
      type: 'template',
      templateId: t._id.toString(),
      variables: { '1': 'ZQX-SECRET-VALUE' },
    });
    await runSends();
    expect(logLines.join('')).not.toContain('ZQX-SECRET-VALUE');
  });
});
