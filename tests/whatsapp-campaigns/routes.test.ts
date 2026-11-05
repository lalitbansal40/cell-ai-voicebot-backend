import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { ContactModel } from '../../src/db/models/contact.model';
import { WhatsAppCampaignRecipientModel } from '../../src/db/models/whatsapp-campaign-recipient.model';
import { WhatsAppCampaignModel } from '../../src/db/models/whatsapp-campaign.model';
import { WhatsAppTemplateModel } from '../../src/db/models/whatsapp-template.model';
import { createTestAccount, tokenFor } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { useInboxWorld } from '../helpers/inbox';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
useCapturedEmail();
const world = useInboxWorld();
const { state } = world;
let users: Awaited<ReturnType<typeof world.setup>>['users'];
let input: {
  name: string;
  channelId: string;
  variants: { key: 'A'; templateId: string; splitPct: number }[];
  audience: { contactIds: string[] };
};
const jobs = { enqueueDispatch: () => Promise.resolve() };
const app = () =>
  buildTestApp(
    {},
    {
      whatsapp: {
        ctx: world.w.ctx,
        jobs: { enqueueEvent: () => Promise.resolve() },
        inboxJobs: world.jobs,
        storage: world.storage,
        waCampaignJobs: jobs,
      },
    },
  );
const auth = (token = users.owner.token) => ({ Authorization: `Bearer ${token}` });
const base = '/api/v1/whatsapp-campaigns';
beforeEach(async () => {
  ({ users } = await world.setup());
  const template = await WhatsAppTemplateModel.create({
    accountId: state.acc.account._id,
    wabaId: state.channel.wabaId,
    name: 'route_notice',
    language: 'en',
    category: 'UTILITY',
    status: 'APPROVED',
    metaTemplateId: 'fake_template_route',
    components: [{ type: 'BODY', text: 'Account update ready.' }],
  });
  const contacts = await ContactModel.insertMany(
    [0, 1].map((i) => ({
      accountId: state.acc.account._id,
      name: i === 0 ? '=1+1' : 'Synthetic recipient',
      phoneE164: `+91900015${String(5000 + i)}`,
      source: { type: 'manual' },
    })),
  );
  input = {
    name: 'Route campaign',
    channelId: state.channel._id.toString(),
    variants: [{ key: 'A', templateId: template._id.toString(), splitPct: 100 }],
    audience: { contactIds: contacts.map((c) => c._id.toString()) },
  };
});

describe('WhatsApp campaign HTTP workflow and boundaries', () => {
  it('saves, estimates, starts idempotently, pauses/resumes/retries, reports/exports and stops', async () => {
    const api = app();
    const created = await request(api).post(base).set(auth()).send(input);
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    const path = `${base}/${id}`;
    expect((await request(api).get(base).set(auth())).body.data).toHaveLength(1);
    expect((await request(api).get(path).set(auth())).body.data.channelId).toBe(input.channelId);
    expect(
      (
        await request(api)
          .patch(path)
          .set(auth())
          .send({ ...input, name: 'Edited' })
      ).body.data.name,
    ).toBe('Edited');
    expect((await request(api).post(`${path}/estimate`).set(auth())).body.data.recipients).toBe(2);
    const key = randomUUID();
    const start = () =>
      request(api).post(`${path}/start`).set(auth()).set('Idempotency-Key', key).send({});
    expect((await start()).body.data.status).toBe('running');
    expect((await start()).headers['idempotent-replayed']).toBe('true');
    expect((await request(api).post(`${path}/pause`).set(auth())).body.data.status).toBe('paused');
    expect((await request(api).post(`${path}/resume`).set(auth())).body.data.status).toBe(
      'running',
    );
    await WhatsAppCampaignRecipientModel.updateOne(
      { campaignId: id },
      { $set: { status: 'failed', errorCode: 130429 } },
    );
    await WhatsAppCampaignModel.updateOne(
      { _id: id },
      { $set: { 'counters.failedTotal': 1, 'counters.failed.130429': 1 } },
    );
    expect((await request(api).post(`${path}/retry-failed`).set(auth())).body.data.retried).toBe(1);
    const recipients = await request(api).get(`${path}/recipients?page=1&limit=1`).set(auth());
    expect(recipients.body.meta.total).toBe(2);
    expect(recipients.body.data).toHaveLength(1);
    expect(
      (await request(api).get(`${path}/report`).set(auth())).body.data.cost.chargedMicros,
    ).toBe(0);
    const csv = await request(api).get(`${path}/export`).set(auth());
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain("'=1+1");
    const masked = await request(api).get(`${path}/export`).set(auth(users.agent.token));
    expect(masked.status).toBe(200);
    expect(masked.text).toContain('••••');
    expect((await request(api).post(`${path}/stop`).set(auth())).body.data.status).toBe('stopped');
    expect(
      await WhatsAppCampaignRecipientModel.countDocuments({
        campaignId: id,
        skipReason: 'stopped',
      }),
    ).toBe(2);
  });

  it('deletes only drafts and enforces tenant, role and view/act boundaries', async () => {
    const api = app();
    expect((await request(api).post(base).set(auth(users.agent.token)).send(input)).status).toBe(
      403,
    );
    const view = await tokenFor(users.owner.user, {
      imp: new Types.ObjectId().toString(),
      imm: 'view',
    });
    expect((await request(api).post(base).set(auth(view)).send(input)).status).toBe(403);
    const act = await tokenFor(users.owner.user, {
      imp: new Types.ObjectId().toString(),
      imm: 'act',
    });
    const created = await request(api).post(base).set(auth(act)).send(input);
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    const other = await createTestAccount();
    const foreign = await other.addUser('owner');
    expect((await request(api).get(`${base}/${id}`).set(auth(foreign.token))).status).toBe(404);
    expect((await request(api).get(base).set(auth(foreign.token))).body.data).toHaveLength(0);
    expect((await request(api).delete(`${base}/${id}`).set(auth())).status).toBe(204);
    expect((await request(api).get(`${base}/${id}`).set(auth())).status).toBe(404);
  });
});
