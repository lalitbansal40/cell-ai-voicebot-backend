import { randomUUID } from 'node:crypto';

import type { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { graphError } from '../../src/core/meta';
import { ApiKeyModel } from '../../src/db/models/api-key.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { WebhookEventModel } from '../../src/db/models/webhook-event.model';
import { WhatsAppTemplateModel } from '../../src/db/models/whatsapp-template.model';
import { generateApiKey } from '../../src/modules/api-keys/api-keys.service';
import { sha256Hex } from '../../src/modules/auth/hmac';
import { recordingWebhookJobs, setWebhookJobs } from '../../src/modules/webhooks/jobs';
import { createTestAccount, type TestAccount } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { mediaFixture } from '../helpers/inbox';
import { useTemplateWorld } from '../helpers/templates';
import { buildTestApp } from '../helpers/test-app';

/** TPL: WhatsApp templates created, submitted, edited and deleted with an API key. */
useTestDb();
useCapturedEmail();
const t = useTemplateWorld();
const base = '/api/v1/whatsapp/templates';
const app = () =>
  buildTestApp(
    {},
    {
      whatsapp: {
        ctx: t.w.ctx,
        jobs: { enqueueEvent: () => Promise.resolve() },
        storage: t.storage,
        templateJobs: t.jobs,
      },
    },
  );

let users: Awaited<ReturnType<typeof t.setup>>['users'];
beforeEach(async () => {
  setWebhookJobs(recordingWebhookJobs());
  await WebhookEventModel.createIndexes();
  ({ users } = await t.setup());
});

const makeKey = async (account: TestAccount, scopes: string[], ownerId: Types.ObjectId) => {
  const key = generateApiKey(false);
  const row = await ApiKeyModel.create({
    accountId: account.account._id,
    name: `tpl ${scopes.join(' ')}`,
    prefix: key.slice(0, 13),
    keyHash: sha256Hex(key),
    scopes,
    createdBy: ownerId,
  });
  return { key, id: row._id.toString() };
};
const as = (key: string) => ({ 'X-API-Key': key });
const unique = (prefix: string) => `${prefix}_${randomUUID().slice(0, 6)}`;
const createBody = (name: string, over: Record<string, unknown> = {}) => ({
  channelId: t.state.channel._id.toString(),
  name,
  language: 'en',
  category: 'UTILITY',
  components: [
    { type: 'BODY', text: 'Hi {{1}}, your EMI is due — TPL-API.', example: { body_text: [['A']] } },
  ],
  ...over,
});
const writer = () => makeKey(t.state.acc, ['templates:write'], users.owner.user._id);

describe('templates by API key (TPL)', () => {
  it('needs a key with templates:write; a read key or no key is refused', async () => {
    const a = app();
    const none = await request(a)
      .post(base)
      .send(createBody(unique('nokey')));
    expect(none.status).toBe(401);
    const reader = await makeKey(t.state.acc, ['templates:read'], users.owner.user._id);
    const refused = await request(a)
      .post(base)
      .set(as(reader.key))
      .send(createBody(unique('reader')));
    expect(refused.status).toBe(403);
    expect(refused.body.error.details[0]).toMatchObject({ path: 'scope' });
    const w = await writer();
    const ok = await request(a)
      .post(base)
      .set(as(w.key))
      .send(createBody(unique('writer_slow')));
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ status: 'PENDING', createdByApiKeyId: w.id });
    const row = await WhatsAppTemplateModel.findById(ok.body.data.id).lean();
    expect(row).toMatchObject({ createdBy: null, updatedBy: null });
    const audit = await AuditLogModel.findOne({
      action: 'template.created',
      'target.id': ok.body.data.id,
    }).lean();
    expect(audit?.actor).toMatchObject({ type: 'api_key' });
    expect(JSON.stringify(audit)).not.toContain(w.key);
  });

  it('draft → media → submit → detail; the read scope reads it', async () => {
    const a = app();
    const w = await writer();
    const name = unique('banner_slow');
    const draft = await request(a)
      .post(base)
      .set(as(w.key))
      .send(
        createBody(name, {
          submit: false,
          category: 'MARKETING',
          components: [
            { type: 'HEADER', format: 'IMAGE' },
            { type: 'BODY', text: 'Hello {{1}}, new offers.', example: { body_text: [['A']] } },
          ],
        }),
      );
    expect(draft.status).toBe(201);
    expect(draft.body.data.status).toBe('DRAFT');
    const id = draft.body.data.id as string;
    const early = await request(a).post(`${base}/${id}/submit`).set(as(w.key)).send({});
    expect(early.status).toBe(422);
    const media = await request(a)
      .post(`${base}/${id}/media`)
      .set(as(w.key))
      .attach('file', mediaFixture('sample.png'), {
        filename: 'banner.png',
        contentType: 'image/png',
      });
    expect(media.status).toBe(200);
    expect(media.body.data.headerMedia).toMatchObject({ uploaded: true });
    const submitted = await request(a)
      .post(`${base}/${id}/submit`)
      .set(as(w.key))
      .set('Idempotency-Key', `tpl-submit-${id}`)
      .send({});
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.status).toBe('PENDING');
    const reader = await makeKey(t.state.acc, ['templates:read'], users.owner.user._id);
    const detail = await request(a).get(`${base}/${id}`).set(as(reader.key));
    expect(detail.status).toBe(200);
    expect(detail.body.data.components.length).toBeGreaterThan(0);
  });

  it('a submit Meta refuses after the save: 201 DRAFT with submitError (keys only)', async () => {
    const a = app();
    const w = await writer();
    t.w.fake.failNext(
      'createTemplate',
      graphError(400, {
        error: { code: 100, message: 'Invalid parameter', type: 'OAuthException' },
      }),
    );
    const res = await request(a)
      .post(base)
      .set(as(w.key))
      .send(createBody(unique('refused')));
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('DRAFT');
    expect(res.body.data.submitError).toMatchObject({ code: expect.any(String) });
    // a dashboard user still gets the error
    t.w.fake.failNext(
      'createTemplate',
      graphError(400, {
        error: { code: 100, message: 'Invalid parameter', type: 'OAuthException' },
      }),
    );
    const dash = await request(a)
      .post(base)
      .set({ Authorization: `Bearer ${users.owner.token}` })
      .send(createBody(unique('dash_refused')));
    expect(dash.status).toBeGreaterThanOrEqual(400);
  });

  it('the same Idempotency-Key returns the same template; another body is refused', async () => {
    const a = app();
    const w = await writer();
    const body = createBody(unique('idem_slow'));
    const first = await request(a)
      .post(base)
      .set(as(w.key))
      .set('Idempotency-Key', 'tpl-idem-1')
      .send(body);
    const again = await request(a)
      .post(base)
      .set(as(w.key))
      .set('Idempotency-Key', 'tpl-idem-1')
      .send(body);
    expect(again.status).toBe(201);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(again.headers['idempotent-replayed']).toBe('true');
    const other = await request(a)
      .post(base)
      .set(as(w.key))
      .set('Idempotency-Key', 'tpl-idem-1')
      .send(createBody(unique('idem_other')));
    expect(other.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await WhatsAppTemplateModel.countDocuments({ name: body.name })).toBe(1);
  });

  it('edit and delete by key; sync and the call-permission template stay dashboard-only', async () => {
    const a = app();
    const w = await writer();
    const draft = await request(a)
      .post(base)
      .set(as(w.key))
      .send(createBody(unique('edit_me'), { submit: false }));
    const id = draft.body.data.id as string;
    const edited = await request(a)
      .patch(`${base}/${id}`)
      .set(as(w.key))
      .send({
        components: [
          { type: 'BODY', text: 'Hi {{1}}, a new text.', example: { body_text: [['A']] } },
        ],
      });
    expect(edited.status).toBe(200);
    const deleted = await request(a).delete(`${base}/${id}`).set(as(w.key));
    expect(deleted.status).toBe(200);
    for (const [method, path] of [
      ['post', `${base}/sync`],
      ['post', `${base}/call-permission`],
    ] as const) {
      const res = await request(a)[method](path).set(as(w.key)).send({});
      expect([401, 403], path).toContain(res.status);
    }
  });

  it('a templates:read key sees approved only; templates:write may filter by status', async () => {
    const a = app();
    const w = await writer();
    const pending = await request(a)
      .post(base)
      .set(as(w.key))
      .send(createBody(unique('listed_slow')));
    expect(pending.body.data.status).toBe('PENDING');
    const reader = await makeKey(t.state.acc, ['templates:read'], users.owner.user._id);
    const readList = await request(a).get(`${base}?status=PENDING`).set(as(reader.key));
    expect(readList.body.data.every((r: { status: string }) => r.status === 'APPROVED')).toBe(true);
    const writeList = await request(a).get(`${base}?status=PENDING`).set(as(w.key));
    expect(writeList.body.data.map((r: { id: string }) => r.id)).toContain(pending.body.data.id);
  });

  it("another account's key can't read or change the template", async () => {
    const a = app();
    const w = await writer();
    const mine = await request(a)
      .post(base)
      .set(as(w.key))
      .send(createBody(unique('mine'), { submit: false }));
    const other = await createTestAccount();
    const owner = await other.addUser('owner');
    const stranger = await makeKey(other, ['templates:write'], owner.user._id);
    const read = await request(a).get(`${base}/${mine.body.data.id}`).set(as(stranger.key));
    expect(read.status).toBe(404);
    const del = await request(a).delete(`${base}/${mine.body.data.id}`).set(as(stranger.key));
    expect(del.status).toBe(404);
  });

  it('template.status_changed is published once per status change', async () => {
    const a = app();
    const w = await writer();
    const res = await request(a)
      .post(base)
      .set(as(w.key))
      .send(createBody(unique('review_slow')));
    const row = await WhatsAppTemplateModel.findById(res.body.data.id).lean();
    const status = (event: string) =>
      t.envelope('message_template_status_update', {
        event,
        message_template_id: row!.metaTemplateId,
        message_template_name: row!.name,
        message_template_language: row!.language,
        message_template_category: row!.category,
        reason: 'NONE',
      });
    await t.deliver(status('APPROVED'));
    await t.deliver(status('APPROVED'));
    const events = await WebhookEventModel.find({
      accountId: t.state.acc.account._id,
      type: 'template.status_changed',
    }).lean();
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({
      templateId: res.body.data.id,
      status: 'APPROVED',
      previousStatus: 'PENDING',
      reason: null,
    });
  });

  it('the create limit is per key (two keys never share it)', async () => {
    const a = app();
    const one = await writer();
    const two = await writer();
    let last = 0;
    for (let i = 0; i < 21; i += 1) {
      const r = await request(a)
        .post(base)
        .set(as(one.key))
        .send(createBody(unique(`rl_${String(i)}`), { submit: false }));
      last = r.status;
    }
    expect(last).toBe(429);
    const fresh = await request(a)
      .post(base)
      .set(as(two.key))
      .send(createBody(unique('rl_other'), { submit: false }));
    expect(fresh.status).toBe(201);
  });
});
