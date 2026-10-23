import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { ContactModel } from '../../src/db/models/contact.model';
import { MessageModel } from '../../src/db/models/message.model';
import { RoleModel } from '../../src/db/models/role.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { recordingTemplateJobs } from '../../src/modules/templates/jobs';
import { createTemplate } from '../../src/modules/templates/template.service';
import { createTestAccount, tokenFor } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { useInboxWorld } from '../helpers/inbox';
import { buildTestApp } from '../helpers/test-app';
import { userActor } from '../helpers/whatsapp';

useTestDb();
useCapturedEmail();
const world = useInboxWorld();
const { state } = world;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const app = () =>
  buildTestApp(
    {},
    {
      whatsapp: {
        ctx: world.w.ctx,
        jobs: { enqueueEvent: () => Promise.resolve() },
        inboxJobs: world.jobs,
        storage: world.storage,
      },
    },
  );

let users: Awaited<ReturnType<typeof world.setup>>['users'];
let templateId: string;
let contactId: string;

beforeEach(async () => {
  ({ users } = await world.setup());
  const t = await createTemplate(
    { wa: world.w.ctx, jobs: recordingTemplateJobs(), storage: world.storage },
    state.acc.account._id,
    userActor(users.owner.user._id),
    {
      channelId: state.channel._id.toString(),
      name: `route_${randomUUID().slice(0, 6)}_instant`,
      language: 'en',
      category: 'UTILITY',
      components: [
        { type: 'BODY', text: 'Hi {{1}}, your EMI is due.', example: { body_text: [['A']] } },
      ],
    },
  );
  templateId = t.id;
  const contact = await ContactModel.create({
    accountId: state.acc.account._id,
    phoneE164: `+91900006${String(Date.now()).slice(-4)}`,
    name: 'Ravi Kumar',
    source: { type: 'manual' },
  });
  contactId = contact._id.toString();
});

describe('POST /inbox/conversations/start with a template', () => {
  it('creates the chat and sends the template in one request (clientId generated)', async () => {
    const res = await request(app())
      .post('/api/v1/inbox/conversations/start')
      .set(bearer(users.agent.token))
      .send({
        channelId: state.channel._id.toString(),
        contactId,
        template: { type: 'template', templateId, variables: { '1': 'Ravi' } },
      });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      created: true,
      clientId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      message: {
        type: 'template',
        text: 'Hi Ravi, your EMI is due.',
        template: { templateId, category: 'UTILITY' },
        billing: { status: 'held', category: 'utility', payer: 'platform' },
      },
    });
    // the same clientId again → the same message, 200
    const again = await request(app())
      .post('/api/v1/inbox/conversations/start')
      .set(bearer(users.agent.token))
      .send({
        channelId: state.channel._id.toString(),
        contactId,
        template: {
          type: 'template',
          templateId,
          variables: { '1': 'Ravi' },
          clientId: res.body.data.clientId,
        },
      });
    expect(again.status).toBe(200);
    expect(again.body.data.message.id).toBe(res.body.data.message.id);
    expect(
      await MessageModel.countDocuments({ accountId: state.acc.account._id, type: 'template' }),
    ).toBe(1);
  });

  it('template errors come back as their codes; viewers can’t send', async () => {
    const res = await request(app())
      .post('/api/v1/inbox/conversations/start')
      .set(bearer(users.agent.token))
      .send({
        channelId: state.channel._id.toString(),
        contactId,
        template: { type: 'template', templateId },
      });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({
      code: 'TEMPLATE_VARIABLES_MISSING',
      details: [{ path: '1' }],
    });
    const viewer = await request(app())
      .post('/api/v1/inbox/conversations/start')
      .set(bearer(users.viewer.token))
      .send({
        channelId: state.channel._id.toString(),
        contactId,
        template: { type: 'template', templateId },
      });
    expect(viewer.status).toBe(403);
  });
});

describe('POST /whatsapp/price-preview', () => {
  const preview = (token: string, body: Record<string, unknown>) =>
    request(app()).post('/api/v1/whatsapp/price-preview').set(bearer(token)).send(body);

  it('template / category / service, by contact or phone; notes per payer', async () => {
    const channelId = state.channel._id.toString();
    expect(
      (await preview(users.viewer.token, { channelId, contactId, templateId })).body.data,
    ).toEqual({
      payer: 'platform',
      market: 'IN',
      marketLabel: 'India',
      category: 'utility',
      priceMicros: 140_000,
      currency: 'INR',
      note: 'billed_when_delivered',
    });
    expect(
      (
        await preview(users.agent.token, {
          channelId,
          phone: '+44 7911 123456',
          category: 'marketing',
        })
      ).body.data,
    ).toMatchObject({
      market: 'OTHER',
      priceMicros: 1_000_000,
    });
    expect((await preview(users.agent.token, { channelId, contactId })).body.data).toMatchObject({
      category: 'service',
      note: 'free_tier_may_apply',
    });
    await WhatsAppChannelModel.updateOne(
      { _id: state.channel._id },
      { $set: { metaPayer: 'customer' } },
    );
    expect(
      (await preview(users.agent.token, { channelId, contactId, templateId })).body.data,
    ).toMatchObject({
      payer: 'customer',
      priceMicros: 0,
      note: 'customer_pays_meta',
    });
  });

  it('validation, another account’s ids → 404, no permission → 403', async () => {
    const channelId = state.channel._id.toString();
    expect((await preview(users.agent.token, { channelId })).status).toBe(422);
    expect(
      (await preview(users.agent.token, { channelId, contactId, phone: '+919000000000' })).status,
    ).toBe(422);
    expect(
      (await preview(users.agent.token, { channelId, contactId, templateId, category: 'service' }))
        .status,
    ).toBe(422);
    expect((await preview(users.agent.token, { channelId, phone: 'abc123' })).status).toBe(422);
    const other = await createTestAccount();
    const owner = await other.addUser('owner');
    expect((await preview(owner.token, { channelId, contactId })).status).toBe(404);
    const noPerm = await other.addUser('viewer');
    // a user whose role lost both permissions
    await RoleModel.updateOne(
      { _id: other.roles.viewer },
      { $pull: { permissions: { $in: ['inbox.read', 'templates.read'] } } },
    );
    expect((await preview(await tokenFor(noPerm.user), { channelId, contactId })).status).toBe(403);
  });
});
