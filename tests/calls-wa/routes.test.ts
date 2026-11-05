import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountModel } from '../../src/db/models/account.model';
import { CallModel } from '../../src/db/models/call.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { UserModel } from '../../src/db/models/user.model';
import { WhatsAppCallPermissionModel } from '../../src/db/models/whatsapp-call-permission.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { WhatsAppTemplateModel } from '../../src/db/models/whatsapp-template.model';
import {
  CallingSettingsSchema,
  CallPermissionSchema,
} from '../../src/modules/whatsapp-calling/calling-api.schema';
import {
  createCallingRuntime,
  type CallingRuntime,
} from '../../src/modules/whatsapp-calling/runtime';
import { createTestAccount, tokenFor } from '../helpers/auth';
import { ensureRateCard } from '../helpers/calls';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { customerText, useInboxWorld } from '../helpers/inbox';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
useCapturedEmail();
const world = useInboxWorld();
const { state } = world;
let runtime: CallingRuntime;
let users: Awaited<ReturnType<typeof world.setup>>['users'];
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const app = () =>
  buildTestApp(
    {},
    {
      whatsapp: {
        ctx: world.w.ctx,
        jobs: { enqueueEvent: () => Promise.resolve() },
        inboxJobs: world.jobs,
        storage: world.storage,
        calling: runtime,
      },
    },
  );
const settingsPath = () => `/api/v1/whatsapp/channels/${state.channel._id.toString()}/calling`;

beforeAll(async () => {
  await ensureRateCard();
  runtime = createCallingRuntime({ ctx: world.w.ctx, service: world.w.svc, inbox: state.ix });
  state.h.calling = runtime.hooks;
});
beforeEach(async () => {
  ({ users } = await world.setup());
});

describe('WhatsApp calling HTTP API', () => {
  it('quotes selling prices for the selected sender/contact, including direct Meta payer and tenant guards', async () => {
    const a = app();
    const contact = await ContactModel.create({
      accountId: state.acc.account._id,
      name: 'Quote recipient',
      phoneE164: '+919000155555',
      source: { type: 'manual' },
    });
    const path = `${settingsPath()}/quote?contactId=${contact._id.toString()}`;
    const platform = await request(a).get(path).set(bearer(users.agent.token));
    expect(platform.status).toBe(200);
    expect(platform.body.data).toMatchObject({
      channelId: state.channel._id.toString(),
      contactId: contact._id.toString(),
      market: 'IN',
      pulseSec: 6,
    });
    expect(platform.body.data.callPerMinuteMicros).toBeGreaterThan(0);
    expect(platform.body.data.aiPerMinuteMicros).toBeGreaterThan(0);
    expect(JSON.stringify(platform.body.data)).not.toMatch(/tokenSealed|metaCost|markupBps/);
    const other = await WhatsAppChannelModel.create({
      ...state.channel,
      _id: new Types.ObjectId(),
      label: 'Own Meta',
      phoneNumberId: 'fake_quote_other',
      metaPayer: 'customer',
      displayPhoneNumber: null,
      phoneE164: null,
    });
    const own = await request(a)
      .get(
        `/api/v1/whatsapp/channels/${other._id.toString()}/calling/quote?contactId=${contact._id.toString()}`,
      )
      .set(bearer(users.owner.token));
    expect(own.status).toBe(200);
    expect(own.body.data).toMatchObject({
      callPerMinuteMicros: 0,
      senderLabel: 'Own Meta',
      senderPhone: null,
    });
    await ContactModel.updateOne({ _id: contact._id }, { $set: { phoneE164: '+442079460099' } });
    expect((await request(a).get(path).set(bearer(users.owner.token))).body.data.market).toBe(
      'OTHER',
    );
    expect((await request(a).get(path).set(bearer(users.viewer.token))).status).toBe(403);
    const stranger = await createTestAccount();
    const foreign = await stranger.addUser('owner');
    expect((await request(a).get(path).set(bearer(foreign.token))).status).toBe(404);
    expect(
      (
        await request(a)
          .get(`${settingsPath()}/quote?contactId=${new Types.ObjectId().toString()}`)
          .set(bearer(users.owner.token))
      ).status,
    ).toBe(404);
  });

  it('creates and reads a bulk permission run with a stable HTTP retry key and scopes history to its sender', async () => {
    await runtime.settings.updateCalling(
      { type: 'user', id: users.owner.user._id },
      state.acc.account._id,
      state.channel._id.toString(),
      { status: 'enabled' },
    );
    const contact = await ContactModel.create({
      accountId: state.acc.account._id,
      phoneE164: '+919000166666',
      source: { type: 'manual' },
    });
    const template = await WhatsAppTemplateModel.create({
      accountId: state.acc.account._id,
      wabaId: state.channel.wabaId,
      name: 'http_call_permission',
      language: 'en',
      category: 'UTILITY',
      purpose: 'call_permission',
      status: 'APPROVED',
    });
    const a = app();
    const path = '/api/v1/whatsapp/call-permissions/bulk';
    const body = {
      channelId: state.channel._id.toString(),
      templateId: template._id.toString(),
      target: { contactIds: [contact._id.toString()] },
    };
    const first = await request(a)
      .post(path)
      .set(bearer(users.owner.token))
      .set('Idempotency-Key', 'permission-http-retry')
      .send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    const replay = await request(a)
      .post(path)
      .set(bearer(users.owner.token))
      .set('Idempotency-Key', 'permission-http-retry')
      .send(body);
    expect(replay.body.data.runId).toBe(first.body.data.runId);
    const progress = await request(a)
      .get(`${path}/${first.body.data.runId as string}`)
      .set(bearer(users.viewer.token));
    expect(progress.status).toBe(200);
    expect(progress.body.data.total).toBe(1);
    await WhatsAppCallPermissionModel.create({
      accountId: state.acc.account._id,
      channelId: state.channel._id,
      contactId: contact._id,
      status: 'permanent',
      history: [{ status: 'permanent', at: new Date(), source: 'profile' }],
    });
    const history = await request(a)
      .get(
        `/api/v1/whatsapp/call-permissions?channelId=${state.channel._id.toString()}&contactId=${contact._id.toString()}`,
      )
      .set(bearer(users.owner.token));
    expect(history.status).toBe(200);
    expect(history.body.data.history).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'permanent', source: 'profile' })]),
    );
  });

  it('passes a single call to the selected transport once and returns only owned call data', async () => {
    const contact = await ContactModel.create({
      accountId: state.acc.account._id,
      phoneE164: '+919000177777',
      source: { type: 'manual' },
    });
    const previous = runtime.calls;
    const startOutbound = vi.fn<NonNullable<CallingRuntime['calls']>['startOutbound']>(
      async (actor, input) => {
        const call = await CallModel.create({
          accountId: actor.accountId,
          provider: 'whatsapp',
          direction: 'outbound',
          mode: input.mode,
          from: 'whatsapp',
          to: contact.phoneE164,
          contactId: contact._id,
          source: { kind: null },
          status: 'completed',
          timestamps: { queuedAt: new Date() },
        });
        return { callId: call._id.toString() };
      },
    );
    runtime.calls = { startOutbound } as unknown as NonNullable<CallingRuntime['calls']>;
    try {
      const a = app();
      const body = {
        channelId: state.channel._id.toString(),
        contactId: contact._id.toString(),
        mode: 'human',
      };
      const first = await request(a)
        .post('/api/v1/whatsapp/calls')
        .set(bearer(users.agent.token))
        .set('Idempotency-Key', 'http-single-call')
        .send(body);
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const replay = await request(a)
        .post('/api/v1/whatsapp/calls')
        .set(bearer(users.agent.token))
        .set('Idempotency-Key', 'http-single-call')
        .send(body);
      expect(replay.body.data.callId).toBe(first.body.data.callId);
      expect(startOutbound).toHaveBeenCalledOnce();
      expect(startOutbound.mock.calls[0]?.[1]).toMatchObject(body);
      expect(JSON.stringify(first.body.data)).not.toMatch(/tokenSealed|metaCostMicros/);
      expect(
        (
          await request(a)
            .post('/api/v1/whatsapp/calls')
            .set(bearer(users.viewer.token))
            .set('Idempotency-Key', 'viewer-call')
            .send(body)
        ).status,
      ).toBe(403);
    } finally {
      runtime.calls = previous;
    }
  });

  it('reads for every role; only owner/admin manage settings, with tenant and impersonation guards', async () => {
    const a = app();
    for (const role of ['owner', 'admin', 'manager', 'agent', 'viewer'] as const) {
      const read = await request(a).get(settingsPath()).set(bearer(users[role].token));
      expect(read.status).toBe(200);
      expect(CallingSettingsSchema.safeParse(read.body.data).success).toBe(true);
      const update = await request(a)
        .patch(settingsPath())
        .set(bearer(users[role].token))
        .send({ status: 'enabled' });
      expect(update.status, role).toBe(role === 'owner' || role === 'admin' ? 200 : 403);
    }
    const sync = await request(a).post(`${settingsPath()}/sync`).set(bearer(users.admin.token));
    expect(sync.status).toBe(200);
    const foreign = await createTestAccount();
    const stranger = await foreign.addUser('owner');
    expect((await request(a).get(settingsPath()).set(bearer(stranger.token))).status).toBe(404);
    const imp = await tokenFor(users.owner.user, { imp: new Types.ObjectId().toString() });
    expect(
      (await request(a).patch(settingsPath()).set(bearer(imp)).send({ status: 'disabled' })).status,
    ).toBe(403);
    expect(
      (await request(a).patch(settingsPath()).set(bearer(users.owner.token)).send({})).status,
    ).toBe(422);
    await AccountModel.updateOne({ _id: state.acc.account._id }, { $set: { status: 'suspended' } });
    expect(
      (
        await request(a)
          .patch(settingsPath())
          .set(bearer(users.owner.token))
          .send({ status: 'disabled' })
      ).status,
    ).toBe(403);
  });

  it('exposes permissions through both the API and inbox panel; requests require inbox.reply', async () => {
    await WhatsAppChannelModel.updateOne(
      { _id: state.channel._id },
      { $set: { 'calling.status': 'enabled' } },
    );
    await world.deliver(customerText(state.channel, { from: '9190000700023' }));
    const contact = await ContactModel.findOne({ accountId: state.acc.account._id }).lean();
    const ids = { contactId: contact!._id.toString(), channelId: state.channel._id.toString() };
    const a = app();
    const status = await request(a)
      .get('/api/v1/whatsapp/call-permissions')
      .query({ ...ids, refresh: 'true' })
      .set(bearer(users.viewer.token));
    expect(status.status).toBe(200);
    expect(CallPermissionSchema.safeParse(status.body.data).success).toBe(true);
    expect(status.body.data.canRequest).toBe(true);
    const denied = await request(a)
      .post('/api/v1/whatsapp/call-permissions/request')
      .set(bearer(users.viewer.token))
      .send(ids);
    expect(denied.status).toBe(403);
    const sent = await request(a)
      .post('/api/v1/whatsapp/call-permissions/request')
      .set(bearer(users.agent.token))
      .send(ids);
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body.data).toMatchObject({
      kind: 'interactive',
      messageId: expect.any(String) as string,
    });
    expect(
      (
        await request(a)
          .get('/api/v1/whatsapp/call-permissions')
          .query({ ...ids, contactId: new Types.ObjectId().toString() })
          .set(bearer(users.agent.token))
      ).status,
    ).toBe(404);
  });

  it('availability is self-only, blocks viewers and impersonation, and validates states', async () => {
    const a = app();
    const path = '/api/v1/users/me/call-availability';
    expect(
      (await request(a).patch(path).set(bearer(users.viewer.token)).send({ status: 'busy' }))
        .status,
    ).toBe(403);
    for (const status of ['busy', 'offline', 'available']) {
      const response = await request(a).patch(path).set(bearer(users.agent.token)).send({ status });
      expect(response.status).toBe(200);
      expect((await UserModel.findById(users.agent.user._id).lean())?.callAvailability).toBe(
        status,
      );
      expect((await UserModel.findById(users.manager.user._id).lean())?.callAvailability).toBe(
        'available',
      );
    }
    expect(
      (await request(a).patch(path).set(bearer(users.agent.token)).send({ status: 'away' })).status,
    ).toBe(422);
    // the session shows it (the header toggle reads it)
    await request(a).patch(path).set(bearer(users.agent.token)).send({ status: 'busy' });
    const me = await request(a).get('/api/v1/auth/me').set(bearer(users.agent.token));
    expect(me.body.data.user.callAvailability).toBe('busy');
  });

  it('call actions enforce permissions and tenant ownership before reaching media', async () => {
    const a = app();
    const id = new Types.ObjectId().toString();
    for (const action of ['answer', 'decline', 'hold', 'transfer']) {
      const path = `/api/v1/whatsapp/calls/${id}/${action}`;
      expect(
        (await request(a).post(path).set(bearer(users.viewer.token)).send({ on: true })).status,
      ).toBe(403);
      expect(
        (await request(a).post(path).set(bearer(users.owner.token)).send({ on: true })).status,
      ).toBe(404);
    }
    expect(
      (await request(a).post(`/api/v1/calls/${id}/media-ticket`).set(bearer(users.agent.token)))
        .status,
    ).toBe(404);
    expect(
      (await request(a).post('/api/v1/whatsapp/calls').set(bearer(users.viewer.token)).send({}))
        .status,
    ).toBe(403);
    expect(
      (
        await request(a)
          .post('/api/v1/whatsapp/calls')
          .set(bearer(users.agent.token))
          .set('Idempotency-Key', 'no-program')
          .send({ channelId: id, contactId: id, mode: 'ai' })
      ).status,
    ).toBe(422);
    const off = buildTestApp();
    expect((await request(off).get(settingsPath()).set(bearer(users.owner.token))).status).toBe(
      503,
    );
  });
});
