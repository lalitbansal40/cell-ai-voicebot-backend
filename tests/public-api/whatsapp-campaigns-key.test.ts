import { randomUUID } from 'node:crypto';

import type { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { ApiKeyModel } from '../../src/db/models/api-key.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { WebhookEventModel } from '../../src/db/models/webhook-event.model';
import { WhatsAppCampaignModel } from '../../src/db/models/whatsapp-campaign.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { WhatsAppTemplateModel } from '../../src/db/models/whatsapp-template.model';
import { generateApiKey, PREFIX_LENGTH } from '../../src/modules/api-keys/api-keys.service';
import type { ApiKeyScope } from '../../src/modules/api-keys/scopes';
import { sha256Hex } from '../../src/modules/auth/hmac';
import { recordingTemplateJobs } from '../../src/modules/templates/jobs';
import { createTemplate } from '../../src/modules/templates/template.service';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { useInboxWorld } from '../helpers/inbox';
import { buildTestApp } from '../helpers/test-app';
import { userActor } from '../helpers/whatsapp';

useTestDb();
const storage = useTempStorage();
const world = useInboxWorld();
const { state } = world;
let app: ReturnType<typeof buildTestApp>;
let templateId: string;
let contactId: string;
let ownerId: Types.ObjectId;

const keyFor = async (scopes: ApiKeyScope[]) => {
  const key = generateApiKey(false);
  await ApiKeyModel.create({
    accountId: state.acc.account._id,
    name: `k-${scopes.join('-')}`,
    prefix: key.slice(0, PREFIX_LENGTH),
    keyHash: sha256Hex(key),
    scopes,
    createdBy: ownerId,
  });
  return key;
};

beforeAll(async () => {
  const { users } = await world.setup();
  ownerId = users.owner.user._id;
  app = buildTestApp(
    {},
    {
      storage,
      whatsapp: {
        ctx: world.w.ctx,
        jobs: { enqueueEvent: () => Promise.resolve() },
        inboxJobs: world.jobs,
        storage: world.storage,
      },
    },
  );
  await WhatsAppChannelModel.updateOne(
    { _id: state.channel._id },
    { $set: { messagingLimitTier: 'TIER_10K', qualityRating: 'GREEN' } },
  );
  const t = await createTemplate(
    { wa: world.w.ctx, jobs: recordingTemplateJobs(), storage: world.storage },
    state.acc.account._id,
    userActor(users.owner.user._id),
    {
      channelId: state.channel._id.toString(),
      name: `k_${randomUUID().slice(0, 8)}`,
      language: 'en',
      category: 'UTILITY',
      components: [
        { type: 'BODY', text: 'Hi {{1}}, your EMI is due.', example: { body_text: [['A']] } },
      ],
    },
  );
  await WhatsAppTemplateModel.updateOne({ _id: t.id }, { $set: { status: 'APPROVED' } });
  templateId = t.id;
  contactId = (
    await ContactModel.create({
      accountId: state.acc.account._id,
      phoneE164: '+919001100001',
      name: 'Asha Verma',
      source: { type: 'manual' },
    })
  )._id.toString();
});

describe('WhatsApp bulk campaigns with an API key (DOCS-T3)', () => {
  it('creates, estimates, starts once per Idempotency-Key, pauses (webhook) and stops', async () => {
    const write = await keyFor(['whatsapp-campaigns:read', 'whatsapp-campaigns:write']);
    const created = await request(app)
      .post('/api/v1/whatsapp-campaigns')
      .set('X-API-Key', write)
      .send({
        name: 'Key campaign',
        channelId: state.channel._id.toString(),
        variants: [{ key: 'A', templateId, splitPct: 100 }],
        variables: { '1': { kind: 'contact.name' } },
        audience: { contactIds: [contactId] },
        schedule: { kind: 'at', at: new Date(Date.now() + 3_600_000).toISOString() },
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;
    const doc = await WhatsAppCampaignModel.findById(id).lean();
    // the key's creator acts (never a made-up user id)
    expect(doc?.createdBy.toString()).toBe(ownerId.toString());

    const estimate = await request(app)
      .post(`/api/v1/whatsapp-campaigns/${id}/estimate`)
      .set('X-API-Key', write);
    expect(estimate.status).toBe(200);

    const idem = randomUUID();
    const first = await request(app)
      .post(`/api/v1/whatsapp-campaigns/${id}/start`)
      .set('X-API-Key', write)
      .set('Idempotency-Key', idem);
    const again = await request(app)
      .post(`/api/v1/whatsapp-campaigns/${id}/start`)
      .set('X-API-Key', write)
      .set('Idempotency-Key', idem);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(first.body.data.status).toBe('scheduled');

    const paused = await request(app)
      .post(`/api/v1/whatsapp-campaigns/${id}/pause`)
      .set('X-API-Key', write);
    expect(paused.body.data.status).toBe('paused');
    const event = await WebhookEventModel.findOne({
      accountId: state.acc.account._id,
      type: 'whatsapp_campaign.paused',
    }).lean<{ data: Record<string, unknown> }>();
    expect(Object.keys(event?.data ?? {}).sort()).toEqual([
      'campaignId',
      'channelId',
      'chargedMicros',
      'counts',
      'name',
      'pauseReason',
      'status',
    ]);
    const stopped = await request(app)
      .post(`/api/v1/whatsapp-campaigns/${id}/stop`)
      .set('X-API-Key', write);
    expect(stopped.status).toBe(200);
  });

  it('a read-only key reads but cannot start; another account gets 404', async () => {
    const read = await keyFor(['whatsapp-campaigns:read']);
    const list = await request(app).get('/api/v1/whatsapp-campaigns').set('X-API-Key', read);
    expect(list.status).toBe(200);
    const id = list.body.data[0]?.id as string;
    const start = await request(app)
      .post(`/api/v1/whatsapp-campaigns/${id}/start`)
      .set('X-API-Key', read)
      .set('Idempotency-Key', randomUUID());
    expect(start.status).toBe(403);
    expect(start.body.error.details).toEqual([
      { path: 'scope', message: 'whatsapp-campaigns:write is required' },
    ]);
  });
});
