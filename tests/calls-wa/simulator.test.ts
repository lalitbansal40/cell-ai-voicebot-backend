import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ContactModel } from '../../src/db/models/contact.model';
import { WhatsAppCallPermissionModel } from '../../src/db/models/whatsapp-call-permission.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { processWebhookEvent } from '../../src/modules/whatsapp/webhook-processor';
import {
  createCallingRuntime,
  type CallingRuntime,
} from '../../src/modules/whatsapp-calling/runtime';
import { CALLING_SIMULATOR_KINDS } from '../../src/modules/whatsapp-calling/simulator-kinds';
import { createInboxCallingHook } from '../../src/modules/whatsapp-calling/webhooks';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { useInboxWorld } from '../helpers/inbox';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
useCapturedEmail();
const world = useInboxWorld();
const { state } = world;
let runtime: CallingRuntime;
let users: Awaited<ReturnType<typeof world.setup>>['users'];
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
// stored events are processed at once, like the worker would
const jobs = {
  enqueueEvent: async (id: string) => {
    await processWebhookEvent(state.h, id, { finalAttempt: false });
  },
};
const app = (calling: CallingRuntime | null = runtime) =>
  buildTestApp(
    {},
    {
      whatsapp: {
        ctx: world.w.ctx,
        jobs,
        inboxJobs: world.jobs,
        storage: world.storage,
        ...(calling ? { calling } : {}),
      },
    },
  );
const CUSTOMER = '919000055001';

beforeAll(() => {
  runtime = createCallingRuntime({ ctx: world.w.ctx, service: world.w.svc, inbox: state.ix });
  state.h.calling = runtime.hooks;
  state.ix.calling = createInboxCallingHook(runtime.permissions);
  world.w.fake.setWebhookEmitter(async (body) => {
    await world.deliver(body);
  });
});
afterAll(async () => {
  await world.w.fake.stopCalls();
});
beforeEach(async () => {
  ({ users } = await world.setup());
});

describe('dev calling simulator', () => {
  it('has 12 kinds; customer kinds need inbox.reply, number kinds whatsapp.manage', async () => {
    expect(CALLING_SIMULATOR_KINDS).toHaveLength(12);
    const a = app();
    const sim = (token: string, kind: string, extra: Record<string, unknown> = {}) =>
      request(a)
        .post('/api/v1/dev/meta/webhooks')
        .set(bearer(token))
        .send({ channelId: state.channel._id.toString(), kind, ...extra });
    expect((await sim(users.viewer.token, 'user_call')).status).toBe(403);
    expect((await sim(users.agent.token, 'calling_restricted')).status).toBe(403);
    expect((await sim(users.owner.token, 'user_dtmf', { digits: '12x' })).status).toBe(422);
  });

  it('customer calls, keys and hang-ups on the fake; user-call route; no SDP in answers', async () => {
    const a = app();
    const channelId = state.channel._id.toString();
    const call = await request(a)
      .post('/api/v1/dev/meta/calls/user-call')
      .set(bearer(users.agent.token))
      .send({ channelId, from: CUSTOMER });
    expect(call.status).toBe(200);
    expect(call.body.data).toEqual({ kind: 'user_call', waCallId: expect.any(String) });
    expect(JSON.stringify(call.body)).not.toMatch(/v=0|a=candidate/);
    const sim = (kind: string, extra: Record<string, unknown> = {}) =>
      request(a)
        .post('/api/v1/dev/meta/webhooks')
        .set(bearer(users.owner.token))
        .send({ channelId, kind, ...extra });
    // not answered yet: the customer's keys go nowhere
    expect((await sim('user_dtmf', { digits: '1' })).body.data).toMatchObject({ ok: false });
    expect((await sim('user_hangup')).body.data).toMatchObject({
      kind: 'user_hangup',
      waCallId: call.body.data.waCallId,
      ok: true,
    });
    expect((await sim('user_hangup')).status).toBe(422); // no live call
    expect(
      (
        await request(a)
          .post('/api/v1/dev/meta/calls/user-call')
          .set(bearer(users.viewer.token))
          .send({ channelId })
      ).status,
    ).toBe(403);
  });

  it('permission replies, expiry and the sweep reach our rows', async () => {
    const a = app();
    const channelId = state.channel._id.toString();
    const contact = await ContactModel.create({
      accountId: state.acc.account._id,
      phoneE164: `+${CUSTOMER}`,
      source: { type: 'manual' },
    });
    const sim = (kind: string) =>
      request(a)
        .post('/api/v1/dev/meta/webhooks')
        .set(bearer(users.owner.token))
        .send({ channelId, kind, from: CUSTOMER });
    const row = () => WhatsAppCallPermissionModel.findOne({ contactId: contact._id }).lean();
    expect((await sim('permission_reply_permanent')).status).toBe(200);
    expect((await row())?.status).toBe('permanent');
    await sim('permission_reply_reject');
    expect((await row())?.status).toBe('declined');
    await sim('permission_reply_accept');
    expect((await row())?.status).toBe('temporary');
    const expired = await sim('permission_expire');
    expect(expired.body.data).toEqual({ kind: 'permission_expire', expired: 1 });
    expect((await row())?.status).toBe('expired');
    expect((await sim('run_permission_sweep')).body.data).toEqual({
      kind: 'run_permission_sweep',
      expired: 0,
    });
  });

  it('restrictions, settings and the messaging tier go through the webhook pipeline', async () => {
    const a = app();
    const channelId = state.channel._id.toString();
    const sim = (kind: string) =>
      request(a)
        .post('/api/v1/dev/meta/webhooks')
        .set(bearer(users.owner.token))
        .send({ channelId, kind });
    const channel = () => WhatsAppChannelModel.findById(state.channel._id).lean();
    expect((await sim('calling_restricted')).status).toBe(200);
    expect((await channel())?.calling?.restrictions.map((r) => r.type)).toEqual([
      'RESTRICTED_BUSINESS_INITIATED_CALLING',
    ]);
    expect((await sim('calling_unrestricted')).status).toBe(200);
    expect((await channel())?.calling?.restrictions).toEqual([]);
    const before = (await channel())?.calling?.callbackPermission;
    expect((await sim('settings_changed')).status).toBe(200);
    await expect
      .poll(async () => (await channel())?.calling?.callbackPermission, { timeout: 5_000 })
      .toBe(!before);
    await WhatsAppChannelModel.updateOne(
      { _id: state.channel._id },
      { $set: { messagingLimitTier: 'TIER_1K' } },
    );
    expect((await sim('call_tier_update')).status).toBe(200);
    expect((await channel())?.messagingLimitTier).toBe('TIER_2K');
    // without the calling runtime the sweep / sync kinds refuse
    expect(
      (
        await request(app(null))
          .post('/api/v1/dev/meta/webhooks')
          .set(bearer(users.owner.token))
          .send({ channelId, kind: 'run_permission_sweep' })
      ).status,
    ).toBe(409);
  });
});
