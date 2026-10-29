import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { PUBLIC_API_LIMITS } from '../../src/config/limits';
import { ApiKeyModel } from '../../src/db/models/api-key.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { ConversationModel } from '../../src/db/models/conversation.model';
import { MessageModel } from '../../src/db/models/message.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { WhatsAppTemplateModel } from '../../src/db/models/whatsapp-template.model';
import { generateApiKey } from '../../src/modules/api-keys/api-keys.service';
import { sha256Hex } from '../../src/modules/auth/hmac';
import { recordingTemplateJobs } from '../../src/modules/templates/jobs';
import { createTemplate } from '../../src/modules/templates/template.service';
import { createTestAccount, type TestAccount } from '../helpers/auth';
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
let templateName: string;

const makeKey = async (account: TestAccount, scopes: string[], ownerId: Types.ObjectId) => {
  const key = generateApiKey(false);
  await ApiKeyModel.create({
    accountId: account.account._id,
    name: 'send test',
    prefix: key.slice(0, 13),
    keyHash: sha256Hex(key),
    scopes,
    createdBy: ownerId,
  });
  return key;
};

let n = 0;
const phone = () => {
  n += 1;
  return `+9190007${String(Date.now()).slice(-3)}${String(n).padStart(2, '0')}`;
};

beforeEach(async () => {
  ({ users } = await world.setup());
  templateName = `api_${randomUUID().slice(0, 6)}_instant`;
  await createTemplate(
    { wa: world.w.ctx, jobs: recordingTemplateJobs(), storage: world.storage },
    state.acc.account._id,
    userActor(users.owner.user._id),
    {
      channelId: state.channel._id.toString(),
      name: templateName,
      language: 'en',
      category: 'UTILITY',
      components: [
        { type: 'BODY', text: 'Hi {{1}}, your EMI is due.', example: { body_text: [['A']] } },
      ],
    },
  );
});

const sendTemplate = (key: string, body: object, idem: string | null = randomUUID()) => {
  const r = request(app()).post('/api/v1/messages/template').set('X-API-Key', key);
  return (idem ? r.set('Idempotency-Key', idem) : r).send(body);
};

describe('POST /messages/template', () => {
  it('creates the contact and chat, sends the approved template (origin api, charged), replays on retry', async () => {
    const key = await makeKey(state.acc, ['messages:write', 'messages:read'], users.owner.user._id);
    const to = phone();
    const idem = randomUUID();
    const body = {
      to,
      template: { name: templateName, language: 'en' },
      variables: { '1': 'Ravi' },
      externalRef: 'loan-77',
    };
    const res = await sendTemplate(key, body, idem);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      type: 'template',
      origin: 'api',
      status: 'queued',
      externalRef: 'loan-77',
      template: { name: templateName, language: 'en' },
      charge: { category: 'utility' },
    });
    const contact = await ContactModel.findOne({
      accountId: state.acc.account._id,
      phoneE164: to,
    }).lean();
    expect(contact?.source.type).toBe('api');
    expect(await ConversationModel.countDocuments({ contactId: contact?._id })).toBe(1);
    // the view never carries the phone or the text
    expect(JSON.stringify(res.body)).not.toContain(to);
    expect(JSON.stringify(res.body)).not.toContain('Ravi');

    const again = await sendTemplate(key, body, idem);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.data.id).toBe(res.body.data.id);
    expect(await MessageModel.countDocuments({ contactId: contact?._id })).toBe(1);

    const got = await request(app())
      .get(`/api/v1/messages/${String(res.body.data.id)}`)
      .set('X-API-Key', key);
    expect(got.status).toBe(200);
    expect(got.body.data).toMatchObject({ id: res.body.data.id, externalRef: 'loan-77' });
  });

  it('sends to an existing contact by id and reuses its chat', async () => {
    const key = await makeKey(state.acc, ['messages:write'], users.owner.user._id);
    const contact = await ContactModel.create({
      accountId: state.acc.account._id,
      phoneE164: phone(),
      source: { type: 'manual' },
    });
    for (let i = 0; i < 2; i += 1) {
      const res = await sendTemplate(key, {
        contactId: contact._id.toString(),
        channelId: state.channel._id.toString(),
        template: { name: templateName, language: 'en' },
        variables: { '1': 'A' },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    expect(await ConversationModel.countDocuments({ contactId: contact._id })).toBe(1);
    expect(await MessageModel.countDocuments({ contactId: contact._id })).toBe(2);
  });

  it.each([
    ['no Idempotency-Key', null, {}],
    [
      'both to and contactId',
      'k',
      { to: '+919000000001', contactId: new Types.ObjectId().toString() },
    ],
    ['neither recipient', 'k', {}],
  ])('rejects %s (422)', async (_name, idem, extra) => {
    const key = await makeKey(state.acc, ['messages:write'], users.owner.user._id);
    const res = await sendTemplate(
      key,
      {
        template: { name: templateName, language: 'en' },
        ...(idem === null ? { to: phone() } : {}),
        ...extra,
      },
      idem === null ? null : randomUUID(),
    );
    expect(res.status).toBe(422);
  });

  it('refuses an unknown template, a DND contact and an empty wallet — nothing charged', async () => {
    const key = await makeKey(state.acc, ['messages:write'], users.owner.user._id);
    const unknown = await sendTemplate(key, {
      to: phone(),
      template: { name: 'no_such_template', language: 'en' },
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('TEMPLATE_NOT_FOUND');

    const dnd = await ContactModel.create({
      accountId: state.acc.account._id,
      phoneE164: phone(),
      dnd: true,
      source: { type: 'manual' },
    });
    const blocked = await sendTemplate(key, {
      contactId: dnd._id.toString(),
      template: { name: templateName, language: 'en' },
      variables: { '1': 'A' },
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('TEMPLATE_MARKETING_BLOCKED');

    await WalletModel.updateOne(
      { accountId: state.acc.account._id },
      { $set: { balanceMicros: 0 } },
    );
    const poor = await sendTemplate(key, {
      to: phone(),
      template: { name: templateName, language: 'en' },
      variables: { '1': 'A' },
    });
    expect(poor.status).toBe(422);
    expect(poor.body.error.code).toBe('WALLET_INSUFFICIENT_BALANCE');
    expect(await MessageModel.countDocuments({ accountId: state.acc.account._id })).toBe(0);
  });

  it('needs messages:write for keys and inbox.reply for people', async () => {
    const readOnly = await makeKey(state.acc, ['messages:read'], users.owner.user._id);
    const res = await sendTemplate(readOnly, {
      to: phone(),
      template: { name: templateName, language: 'en' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.details).toEqual([
      { path: 'scope', message: 'messages:write is required' },
    ]);
    const viewer = await request(app())
      .post('/api/v1/messages/template')
      .set(bearer(users.viewer.token))
      .set('Idempotency-Key', randomUUID())
      .send({ to: phone(), template: { name: templateName, language: 'en' } });
    expect(viewer.status).toBe(403);
    // the dashboard can use the same route (origin agent)
    const owner = await request(app())
      .post('/api/v1/messages/template')
      .set(bearer(users.owner.token))
      .set('Idempotency-Key', randomUUID())
      .send({
        to: phone(),
        template: { name: templateName, language: 'en' },
        variables: { '1': 'A' },
      });
    expect(owner.status, JSON.stringify(owner.body)).toBe(201);
    expect(owner.body.data.origin).toBe('agent');
  });
});

describe('POST /messages/text', () => {
  it('refuses free text outside the 24-hour window (409 WHATSAPP_WINDOW_CLOSED)', async () => {
    const key = await makeKey(state.acc, ['messages:write'], users.owner.user._id);
    const res = await request(app())
      .post('/api/v1/messages/text')
      .set('X-API-Key', key)
      .set('Idempotency-Key', randomUUID())
      .send({ to: phone(), text: 'Your payment link is ready' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WHATSAPP_WINDOW_CLOSED');
  });

  it('sends inside the window', async () => {
    const key = await makeKey(state.acc, ['messages:write'], users.owner.user._id);
    const contact = await ContactModel.create({
      accountId: state.acc.account._id,
      phoneE164: phone(),
      source: { type: 'manual' },
    });
    const start = await request(app())
      .post('/api/v1/messages/template')
      .set('X-API-Key', key)
      .set('Idempotency-Key', randomUUID())
      .send({
        contactId: contact._id.toString(),
        template: { name: templateName, language: 'en' },
        variables: { '1': 'A' },
      });
    expect(start.status).toBe(201);
    await ConversationModel.updateOne(
      { contactId: contact._id },
      { $set: { windowExpiresAt: new Date(Date.now() + 3_600_000) } },
    );
    const res = await request(app())
      .post('/api/v1/messages/text')
      .set('X-API-Key', key)
      .set('Idempotency-Key', randomUUID())
      .send({ contactId: contact._id.toString(), text: 'Thanks!', externalRef: 'ticket-9' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ type: 'text', origin: 'api', externalRef: 'ticket-9' });
  });
});

describe('GET /messages/:id', () => {
  it('is tenant scoped and needs messages:read', async () => {
    const key = await makeKey(state.acc, ['messages:write'], users.owner.user._id);
    const sent = await sendTemplate(key, {
      to: phone(),
      template: { name: templateName, language: 'en' },
      variables: { '1': 'A' },
    });
    const id = String(sent.body.data.id);
    expect((await request(app()).get(`/api/v1/messages/${id}`).set('X-API-Key', key)).status).toBe(
      403,
    );
    const other = await createTestAccount();
    const otherOwner = await other.addUser('owner');
    const theirs = await makeKey(other, ['messages:read'], otherOwner.user._id);
    expect(
      (await request(app()).get(`/api/v1/messages/${id}`).set('X-API-Key', theirs)).status,
    ).toBe(404);
  });
});

describe('GET /whatsapp/templates with a key', () => {
  it('lists approved templates only', async () => {
    await WhatsAppTemplateModel.updateOne(
      { accountId: state.acc.account._id, name: templateName },
      { $set: { status: 'APPROVED' } },
    );
    await createTemplate(
      { wa: world.w.ctx, jobs: recordingTemplateJobs(), storage: world.storage },
      state.acc.account._id,
      userActor(users.owner.user._id),
      {
        channelId: state.channel._id.toString(),
        name: `draft_${randomUUID().slice(0, 6)}`,
        language: 'en',
        category: 'UTILITY',
        components: [{ type: 'BODY', text: 'Draft only' }],
      },
    );
    const key = await makeKey(state.acc, ['templates:read'], users.owner.user._id);
    const res = await request(app())
      .get('/api/v1/whatsapp/templates?status=DRAFT')
      .set('X-API-Key', key);
    expect(res.status).toBe(200);
    const names = (res.body.data as { name: string; status: string }[]).map((t) => t.status);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names)).toEqual(new Set(['APPROVED']));
    // the dashboard keeps its filters
    const dash = await request(app())
      .get('/api/v1/whatsapp/templates?status=DRAFT')
      .set(bearer(users.owner.token));
    expect((dash.body.data as { status: string }[]).every((t) => t.status === 'DRAFT')).toBe(true);
  });
});

describe('contacts upsert', () => {
  const upsert = (key: string, body: object, by: 'phone' | 'externalId' = 'phone') =>
    request(app()).post(`/api/v1/contacts?upsert=${by}`).set('X-API-Key', key).send(body);

  it('creates (201) then updates (200) by phone, never clearing opt-out', async () => {
    const key = await makeKey(state.acc, ['contacts:write'], users.owner.user._id);
    const p = phone();
    const first = await upsert(key, { phone: p, name: 'Asha' });
    expect(first.status).toBe(201);
    await ContactModel.updateOne({ _id: first.body.data.id }, { $set: { optedOutAt: new Date() } });
    const second = await upsert(key, {
      phone: p,
      name: 'Asha Verma',
      consent: { source: 'LMS', at: new Date().toISOString() },
    });
    expect(second.status).toBe(200);
    expect(second.body.data.id).toBe(first.body.data.id);
    const stored = await ContactModel.findById(first.body.data.id).lean();
    expect(stored?.name).toBe('Asha Verma');
    expect(stored?.optedOutAt).not.toBeNull();
    // without ?upsert a duplicate is still a 409
    expect(
      (await request(app()).post('/api/v1/contacts').set('X-API-Key', key).send({ phone: p }))
        .status,
    ).toBe(409);
  });

  it('upserts by externalId (phone may change) and needs the externalId', async () => {
    const key = await makeKey(state.acc, ['contacts:write'], users.owner.user._id);
    const ext = `lms-${randomUUID().slice(0, 8)}`;
    const a = await upsert(key, { phone: phone(), externalId: ext }, 'externalId');
    expect(a.status).toBe(201);
    const newPhone = phone();
    const b = await upsert(key, { phone: newPhone, externalId: ext }, 'externalId');
    expect(b.status).toBe(200);
    expect(b.body.data.id).toBe(a.body.data.id);
    expect((await ContactModel.findById(a.body.data.id).lean())?.phoneE164).toBe(newPhone);
    expect((await upsert(key, { phone: phone() }, 'externalId')).status).toBe(422);
  });

  it('never creates duplicates on concurrent upserts', async () => {
    const key = await makeKey(state.acc, ['contacts:write'], users.owner.user._id);
    const p = phone();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => upsert(key, { phone: p, name: `N${String(i)}` })),
    );
    expect(results.map((r) => r.status).filter((s) => s === 201)).toHaveLength(1);
    expect(results.every((r) => [200, 201].includes(r.status))).toBe(true);
    expect(
      await ContactModel.countDocuments({ accountId: state.acc.account._id, phoneE164: p }),
    ).toBe(1);
  });

  it('bulk-upserts with a result per row (partial failures)', async () => {
    const key = await makeKey(state.acc, ['contacts:write'], users.owner.user._id);
    const existing = phone();
    await upsert(key, { phone: existing });
    const res = await request(app())
      .post('/api/v1/contacts/bulk-upsert')
      .set('X-API-Key', key)
      .send({
        rows: [{ phone: phone(), name: 'New' }, { phone: existing, name: 'Old' }, { phone: '12' }],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ created: 1, updated: 1, failed: 1 });
    expect(res.body.data.results[2]).toMatchObject({
      index: 2,
      status: 'failed',
      error: { code: 'VALIDATION_FAILED' },
    });
    const tooMany = await request(app())
      .post('/api/v1/contacts/bulk-upsert')
      .set('X-API-Key', key)
      .send({
        rows: Array.from({ length: PUBLIC_API_LIMITS.bulkUpsertMax + 1 }, () => ({ phone: '1' })),
      });
    expect(tooMany.status).toBe(422);
  });

  it('keeps accounts apart', async () => {
    const other = await createTestAccount();
    const otherOwner = await other.addUser('owner');
    const p = phone();
    const mine = await makeKey(state.acc, ['contacts:write'], users.owner.user._id);
    const theirs = await makeKey(other, ['contacts:write'], otherOwner.user._id);
    expect((await upsert(mine, { phone: p })).status).toBe(201);
    expect((await upsert(theirs, { phone: p })).status).toBe(201);
    expect(await ContactModel.countDocuments({ phoneE164: p })).toBe(2);
  });
});
