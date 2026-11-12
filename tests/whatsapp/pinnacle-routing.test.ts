import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { ConversationModel, type ConversationDoc } from '../../src/db/models/conversation.model';
import { MessageModel } from '../../src/db/models/message.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../src/db/models/whatsapp-channel.model';
import { setBlocked } from '../../src/modules/inbox/conversations.service';
import { INBOX_JOBS } from '../../src/modules/inbox/jobs';
import { downloadInboundMedia } from '../../src/modules/inbox/media.service';
import { sendMessage } from '../../src/modules/inbox/outbound.service';
import { processReadReceipt } from '../../src/modules/inbox/receipts';
import { processSend } from '../../src/modules/inbox/send.job';
import { syncTemplates } from '../../src/modules/templates/template.service';
import { clientFor, sealSecret } from '../../src/modules/whatsapp/context';
import { receivePinnacleWebhook } from '../../src/modules/whatsapp/pinnacle-webhooks.service';
import {
  getBusinessProfile,
  updateBusinessProfile,
} from '../../src/modules/whatsapp/profile.service';
import { processWebhookEvent } from '../../src/modules/whatsapp/webhook-processor';
import { useTestDb } from '../helpers/db';
import { customerText, mediaFixture, useInboxWorld } from '../helpers/inbox';
import { userActor } from '../helpers/whatsapp';

useTestDb();
const world = useInboxWorld();
const { state } = world;

let conv: ConversationDoc;
let users: Awaited<ReturnType<typeof world.setup>>['users'];
let n = 0;
const customer = () => {
  n += 1;
  return `9190000${String(70_000 + n)}`;
};

/**
 * A number connected through the fake Meta, then turned into a managed number: same fake
 * identity, its Pinnacle API key sealed in place of the Meta token, provider `pinnacle`.
 */
const managed = async () => {
  const setup = await world.setup();
  const { signup } = setup;
  users = setup.users;
  const from = customer();
  const mediaId = await world.w.fake.putMedia(mediaFixture('sample.jpg'), 'image/jpeg');
  await world.deliver(customerText(state.channel, { from }));
  const image = customerText(state.channel, { from, text: 'photo' });
  const value = (image.entry[0]?.changes[0]?.value ?? {}) as Record<string, unknown>;
  const [msg] = value.messages as Record<string, unknown>[];
  if (msg) {
    msg.type = 'image';
    msg.id = `wamid.img-${randomUUID()}`;
    delete msg.text;
    msg.image = { id: mediaId, mime_type: 'image/jpeg', caption: 'photo' };
  }
  await world.deliver(image);
  conv = (await ConversationModel.findOne({
    accountId: state.acc.account._id,
    waId: from,
  }).lean())!;
  const number = await world.w.pinnacle.seedManagedNumber({
    businessName: signup.businessName,
    phone: signup.phone,
  });
  await WhatsAppChannelModel.updateOne(
    { _id: state.channel._id },
    {
      $set: {
        provider: 'pinnacle',
        tokenSealed: sealSecret(world.w.ctx, number.apiKey),
        tokenType: 'pinnacle_api_key',
      },
    },
  );
  state.channel = (await WhatsAppChannelModel.findById(state.channel._id)
    .select('+tokenSealed')
    .lean<WhatsAppChannelDoc>())!;
  world.w.pinnacle.calls.length = 0;
  world.w.fake.calls.length = 0;
};

const pinOps = () => world.w.pinnacle.calls.map((c) => c.op);
const metaOps = () => world.w.fake.calls.map((c) => c.op);
/** The fake Pinnacle relays to the fake Meta: every Meta call of `op` came through Pinnacle. */
const onlyViaPinnacle = (...ops: string[]) => {
  for (const op of ops) {
    expect(metaOps().filter((o) => o === op).length, op).toBe(
      pinOps().filter((o) => o === op).length,
    );
  }
};

const runSends = async () => {
  for (const job of world.jobs.sent.splice(0)) {
    if (job.name !== INBOX_JOBS.messageSend) continue;
    for (let waits = 0; waits < 30; waits += 1) {
      const out = await processSend(state.ix, job.id, { finalAttempt: true, waits });
      if (out.kind !== 'wait' && out.kind !== 'later') break;
    }
  }
};

describe('per-channel routing (PN D7)', () => {
  beforeEach(async () => {
    await managed();
  });

  it('clientFor: Pinnacle for a managed number, Meta otherwise', () => {
    expect(clientFor(world.w.ctx, state.channel)).toBe(world.w.pinnacle);
    expect(clientFor(world.w.ctx, { provider: 'fake' })).toBe(world.w.fake);
    expect(() => clientFor({ meta: world.w.fake, pinnacle: null }, state.channel)).toThrow(
      expect.objectContaining({ code: 'WA_PROVIDER_NOT_CONFIGURED' }),
    );
  });

  it('inbox: send, read receipt, block / unblock, media download go to Pinnacle', async () => {
    const actor = { accountId: state.acc.account._id, userId: users.agent.user._id };
    await sendMessage(state.ix, actor, conv._id.toString(), {
      clientId: randomUUID(),
      type: 'text',
      text: 'Hello from a managed number',
    });
    await runSends();
    expect(pinOps()).toContain('sendMessage');

    const inbound = await MessageModel.findOne({ conversationId: conv._id, direction: 'in' })
      .sort({ at: 1 })
      .lean();
    await processReadReceipt(state.ix, inbound!._id.toString(), { finalAttempt: true });
    expect(pinOps()).toContain('markRead');

    const ownerActor = { accountId: state.acc.account._id, userId: users.owner.user._id };
    await setBlocked(state.ix, ownerActor as never, conv._id.toString(), true);
    await setBlocked(state.ix, ownerActor as never, conv._id.toString(), false);
    expect(pinOps()).toEqual(expect.arrayContaining(['blockUsers', 'unblockUsers']));

    const image = await MessageModel.findOne({ conversationId: conv._id, type: 'image' }).lean();
    expect(
      await downloadInboundMedia(state.ix, image!._id.toString(), { finalAttempt: true }),
    ).toBe('ready');
    expect(pinOps()).toEqual(expect.arrayContaining(['getMediaUrl', 'downloadMedia']));

    onlyViaPinnacle('sendMessage', 'markRead', 'blockUsers', 'unblockUsers', 'getMediaUrl');
  });

  it('templates sync and the business profile go to Pinnacle', async () => {
    await syncTemplates(
      { wa: world.w.ctx, jobs: { enqueueSync: () => Promise.resolve() } as never },
      state.channel._id,
      'test',
    ).catch(() => undefined);
    expect(pinOps()).toContain('listTemplates');
    await getBusinessProfile(world.w.ctx, state.acc.account._id, state.channel._id.toString());
    await updateBusinessProfile(
      world.w.ctx,
      state.acc.account._id,
      state.channel._id.toString(),
      { about: 'Managed' },
      userActor(),
    );
    expect(pinOps()).toEqual(
      expect.arrayContaining(['getBusinessProfile', 'updateBusinessProfile']),
    );
    onlyViaPinnacle('listTemplates', 'getBusinessProfile', 'updateBusinessProfile');
  });

  it('a customer message relayed by Pinnacle lands in the inbox (worker path)', async () => {
    const secret = 'relay-secret-0123456789';
    await WhatsAppChannelModel.updateOne(
      { _id: state.channel._id },
      {
        $set: {
          pinnacle: {
            webhookSecretSealed: sealSecret(world.w.ctx, secret),
            webhookUrl: null,
            webhookSetAt: new Date(),
            keyLast4: 'abcd',
            keyCheckedAt: new Date(),
            lastBalanceErrorAt: null,
            addedBy: null,
          },
        },
      },
    );
    const ids: string[] = [];
    const jobs = {
      enqueueEvent: (id: string) => {
        ids.push(id);
        return Promise.resolve();
      },
    };
    const from = customer();
    const payload = Buffer.from(
      JSON.stringify(customerText(state.channel, { from, text: 'via the partner' })),
    );
    const receipt = await receivePinnacleWebhook(
      world.w.ctx,
      jobs,
      state.channel._id.toString(),
      payload,
      secret,
    );
    expect(receipt.received).toBe(1);
    for (const id of ids) await processWebhookEvent(state.h, id, { finalAttempt: false });
    const conversation = await ConversationModel.findOne({
      accountId: state.acc.account._id,
      waId: from,
    }).lean();
    expect(conversation).toBeTruthy();
    expect(
      await MessageModel.countDocuments({ conversationId: conversation?._id, direction: 'in' }),
    ).toBe(1);
  });
});
