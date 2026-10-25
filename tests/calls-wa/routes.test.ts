import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AccountModel } from '../../src/db/models/account.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { UserModel } from '../../src/db/models/user.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import {
  CallingSettingsSchema,
  CallPermissionSchema,
} from '../../src/modules/whatsapp-calling/calling-api.schema';
import {
  createCallingRuntime,
  type CallingRuntime,
} from '../../src/modules/whatsapp-calling/runtime';
import { createTestAccount, tokenFor } from '../helpers/auth';
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

beforeAll(() => {
  runtime = createCallingRuntime({ ctx: world.w.ctx, service: world.w.svc, inbox: state.ix });
  state.h.calling = runtime.hooks;
});
beforeEach(async () => {
  ({ users } = await world.setup());
});

describe('WhatsApp calling HTTP API', () => {
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
