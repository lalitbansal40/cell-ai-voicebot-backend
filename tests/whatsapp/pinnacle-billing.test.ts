import { randomUUID } from 'node:crypto';

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FAKE_PINNACLE_KEY_PREFIXES, mapSendError } from '../../src/core/meta';
import { ConversationModel, type ConversationDoc } from '../../src/db/models/conversation.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { MessageModel } from '../../src/db/models/message.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../src/db/models/whatsapp-channel.model';
import { INBOX_JOBS } from '../../src/modules/inbox/jobs';
import { sendMessage } from '../../src/modules/inbox/outbound.service';
import { processSend } from '../../src/modules/inbox/send.job';
import { sealSecret } from '../../src/modules/whatsapp/context';
import { createWhatsAppBillingHook } from '../../src/modules/whatsapp-billing/billing-hook';
import { createTestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { customerText, useInboxWorld } from '../helpers/inbox';

useTestDb();
const world = useInboxWorld({ PINNACLE_ENABLED: 'true' });
const { state } = world;

let superadmin: TestUser;
let conv: ConversationDoc;
let users: Awaited<ReturnType<typeof world.setup>>['users'];
let n = 0;

beforeAll(async () => {
  const platform = await createTestAccount({
    isPlatform: true,
    slug: `platform-pn-billing-${String(Date.now())}`,
    name: 'Platform',
  });
  superadmin = await platform.addUser('owner', { platformRole: 'superadmin' });
  // the real billing hook (holds go back on a failed send), as the server wires it
  state.ix.billing = createWhatsAppBillingHook();
});

/** A number turned into a managed one whose key starts with `keyPrefix`. */
const managed = async (keyPrefix: string = FAKE_PINNACLE_KEY_PREFIXES.valid) => {
  const setup = await world.setup();
  users = setup.users;
  n += 1;
  const from = `9190000${String(80_000 + n)}`;
  await world.deliver(customerText(state.channel, { from }));
  conv = (await ConversationModel.findOne({
    accountId: state.acc.account._id,
    waId: from,
  }).lean())!;
  const number = await world.w.pinnacle.seedManagedNumber({
    businessName: setup.signup.businessName,
    phone: setup.signup.phone,
    keyPrefix,
  });
  await WhatsAppChannelModel.updateOne(
    { _id: state.channel._id },
    {
      $set: {
        provider: 'pinnacle',
        tokenSealed: sealSecret(world.w.ctx, number.apiKey),
        creditLine: { status: 'partner_active', allocationConfigId: null, error: null, at: null },
        pinnacle: {
          webhookSecretSealed: null,
          webhookUrl: null,
          webhookSetAt: new Date(),
          keyLast4: number.apiKey.slice(-4),
          keyCheckedAt: new Date(),
          lastBalanceErrorAt: null,
          addedBy: null,
        },
      },
    },
  );
  state.channel = (await WhatsAppChannelModel.findById(state.channel._id)
    .select('+tokenSealed')
    .lean<WhatsAppChannelDoc>())!;
  world.jobs.sent.length = 0;
};

const send = () =>
  sendMessage(
    state.ix,
    { accountId: state.acc.account._id, userId: users.agent.user._id },
    conv._id.toString(),
    { clientId: randomUUID(), type: 'text', text: 'Hello' },
  );

/** One attempt per job, not the final one: a retryable error would throw. */
const runSends = async () => {
  const out = [];
  for (const job of world.jobs.sent.splice(0)) {
    if (job.name !== INBOX_JOBS.messageSend) continue;
    out.push(await processSend(state.ix, job.id, { finalAttempt: false, waits: 0 }));
  }
  return out;
};

beforeEach(async () => {
  await world.w.redis.del('wa:pinnacle:balance-alert');
});

describe('managed numbers: billing and partner balance (PN-T6)', () => {
  it('mapSendError: balance low is final, the channel untouched', () => {
    expect(mapSendError({ code: null, type: 'provider_balance_low', retryable: false })).toEqual({
      retryable: false,
      retryAfterSec: null,
      channelEffect: 'none',
      reason: 'The partner account balance is low — contact support.',
    });
    expect(mapSendError({ code: null, type: 'provider_error', retryable: false }).reason).toBe(
      'The WhatsApp partner refused the message',
    );
  });

  it('a successful send on a managed number holds the platform-pays charge', async () => {
    await managed();
    const { message } = await send();
    expect(await runSends()).toEqual([expect.objectContaining({ kind: 'accepted' })]);
    expect((await MessageModel.findById(message._id).lean())?.status).toBe('accepted');
    // managed numbers are platform-pays: the reply is held on the account's wallet
    expect(
      await LedgerEntryModel.countDocuments({
        accountId: state.acc.account._id,
        type: 'whatsapp_charge',
        status: 'held',
      }),
    ).toBeGreaterThanOrEqual(1);
  });

  it('partner balance low: failed with our reason, never retried, one bell an hour, channel connected', async () => {
    await managed(FAKE_PINNACLE_KEY_PREFIXES.balanceLow);
    const sent = [await send(), await send(), await send()];
    const outcomes = await runSends();
    expect(outcomes).toHaveLength(3);
    for (const o of outcomes) expect(o).toMatchObject({ kind: 'failed' });
    for (const { message } of sent) {
      const m = await MessageModel.findById(message._id).lean();
      expect(m?.status).toBe('failed');
      expect(m?.error?.reason).toContain('partner account balance is low');
    }
    // every hold went back to the wallet (a fresh account: only these three replies)
    expect(
      await LedgerEntryModel.countDocuments({
        accountId: state.acc.account._id,
        type: 'whatsapp_charge',
        status: 'held',
      }),
    ).toBe(0);
    expect(
      await LedgerEntryModel.countDocuments({
        accountId: state.acc.account._id,
        type: 'whatsapp_charge',
        status: 'released',
      }),
    ).toBe(3);
    expect(
      await NotificationModel.countDocuments({
        userId: superadmin.user._id,
        type: 'whatsapp.provider_balance_low',
      }),
    ).toBe(1);
    const ch = await WhatsAppChannelModel.findById(state.channel._id).lean();
    expect(ch?.status).toBe('connected');
    expect(ch?.pinnacle?.lastBalanceErrorAt).toBeInstanceOf(Date);
  });
});
