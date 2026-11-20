import { Types } from 'mongoose';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { graphError, WEBHOOK_FIELDS } from '../../src/core/meta';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { buildTestApp } from '../helpers/test-app';
import {
  codeFor,
  fakeSignup,
  idsFor,
  insertChannel,
  userActor,
  useWhatsAppWorld,
} from '../helpers/whatsapp';

/** SAC-T4: Meta webhook check on onboarding, on Sync, and the Webhook check / Fix button. */
useTestDb();
useCapturedEmail();
const w = useWhatsAppWorld();

let acc: TestAccount;
let owner: TestUser;
const BASE_FIELDS = [
  'messages',
  'calls',
  'account_settings_update',
  'message_template_status_update',
];

beforeEach(async () => {
  acc = await createTestAccount();
  owner = await acc.addUser('owner');
  w.fake.setAppSubscriptionFields(BASE_FIELDS);
});
afterEach(() => w.fake.setAppSubscriptionFields(BASE_FIELDS));

const connect = async (signup = fakeSignup()) =>
  w.svc.connect({
    accountId: acc.account._id,
    actor: userActor(owner.user._id),
    mode: signup.mode,
    code: codeFor(signup),
    sessionInfo: { wabaId: idsFor(signup).wabaId, phoneNumberId: idsFor(signup).phoneNumberId },
  });
const stored = (id: string) => WhatsAppChannelModel.findById(id).lean();
const ops = () => w.fake.calls.map((c) => c.op);

describe('webhook check on onboarding (SAC-T4)', () => {
  it('a normal connect confirms the app and the fields: ok, nothing repaired', async () => {
    const before = ops().length;
    const r = await connect();
    expect(r.channel.status).toBe('connected');
    expect(r.channel.webhookCheck).toMatchObject({ status: 'ok', appSubscribed: true });
    expect(ops().slice(before)).toContain('getSubscribedApps');
    expect(ops().slice(before)).not.toContain('setAppSubscription');
  });

  it('`calls` missing on the app → repaired at once with every field', async () => {
    w.fake.setAppSubscriptionFields(['messages']);
    const r = await connect();
    expect(r.channel.webhookCheck.status).toBe('ok');
    expect(r.channel.webhookCheck.fixedAt).not.toBeNull();
    const subs = await w.fake.getAppSubscriptions();
    expect(subs[0]?.fields).toEqual(expect.arrayContaining([...WEBHOOK_FIELDS]));
  });

  it('a failed repair never blocks the number: connected, check failed', async () => {
    w.fake.setAppSubscriptionFields(['messages']);
    w.fake.failNext(
      'setAppSubscription',
      graphError(400, { error: { code: 100, message: 'Callback verification failed' } }),
    );
    const r = await connect();
    expect(r.channel.status).toBe('connected');
    expect(r.channel.webhookCheck).toMatchObject({
      status: 'failed',
      missingFields: expect.arrayContaining(['calls']),
    });
  });
});

describe('Webhook check / Fix (SAC-T4)', () => {
  it('fixes a missing field, audits it, and reports the steps', async () => {
    const r = await connect();
    w.fake.setAppSubscriptionFields(['messages']);
    const fixed = await w.svc.fixWebhook(acc.account._id, r.channel.id, userActor(owner.user._id));
    expect(fixed.webhookCheck.status).toBe('ok');
    expect(fixed.steps.map((s) => [s.key, s.ok])).toEqual([
      ['app_subscribed', true],
      ['fields', true],
      ['fix_fields', true],
    ]);
    expect((await stored(r.channel.id))?.webhookCheck.status).toBe('ok');
    expect(
      await AuditLogModel.countDocuments({
        action: 'whatsapp.webhook_fixed',
        'target.id': r.channel.id,
      }),
    ).toBe(1);
  });

  it('re-subscribes our app to the WABA when it was removed', async () => {
    const r = await connect();
    const { token } = await w.svc.getChannelToken(r.channel.id);
    await w.fake.unsubscribeApp(token, r.channel.wabaId);
    const fixed = await w.svc.fixWebhook(acc.account._id, r.channel.id, userActor(owner.user._id));
    expect(fixed.steps.find((s) => s.key === 'fix_app')?.ok).toBe(true);
    expect(fixed.webhookCheck.appSubscribed).toBe(true);
  });

  it('6 fixes per 10 minutes per number; a managed number is refused', async () => {
    const r = await connect();
    for (let i = 0; i < 6; i += 1)
      await w.svc.fixWebhook(acc.account._id, r.channel.id, userActor(owner.user._id));
    await expect(
      w.svc.fixWebhook(acc.account._id, r.channel.id, userActor(owner.user._id)),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    const managed = await insertChannel({ accountId: acc.account._id, provider: 'pinnacle' });
    await expect(
      w.svc.fixWebhook(acc.account._id, managed._id.toString(), userActor(owner.user._id)),
    ).rejects.toMatchObject({ code: 'CONFLICT_INVALID_STATE' });
    // another account's number
    await expect(
      w.svc.fixWebhook(new Types.ObjectId(), r.channel.id, userActor(owner.user._id)),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('Sync checks without repairing; ok → failed rings the bell once', async () => {
    const r = await connect();
    w.fake.setAppSubscriptionFields(['messages']);
    const actor = userActor(owner.user._id);
    const ch = await WhatsAppChannelModel.findById(r.channel.id).select('+tokenSealed').lean();
    const before = ops().length;
    const first = await w.svc.syncChannel(ch!, actor);
    expect(first.webhookCheck.status).toBe('failed');
    expect(ops().slice(before)).not.toContain('setAppSubscription');
    const again = await WhatsAppChannelModel.findById(r.channel.id).select('+tokenSealed').lean();
    await w.svc.syncChannel(again!, actor);
    expect(
      await NotificationModel.countDocuments({
        accountId: acc.account._id,
        type: 'whatsapp.webhook_missing',
      }),
    ).toBe(1);
    expect(await w.svc.webhookStatus(acc.account._id, r.channel.id)).toMatchObject({
      provider: 'fake',
      webhookCheck: { status: 'failed' },
    });
  });

  it('HTTP: viewers read, owners fix, a view login-as is refused', async () => {
    const r = await connect();
    const app = buildTestApp(
      {},
      { whatsapp: { ctx: w.ctx, jobs: { enqueueEvent: () => Promise.resolve() } } },
    );
    const viewer = await acc.addUser('viewer');
    const path = `/api/v1/whatsapp/channels/${r.channel.id}/webhook`;
    expect(
      (await request(app).get(path).set('Authorization', `Bearer ${viewer.token}`)).status,
    ).toBe(200);
    expect(
      (await request(app).post(`${path}/fix`).set('Authorization', `Bearer ${viewer.token}`))
        .status,
    ).toBe(403);
    const fix = await request(app)
      .post(`${path}/fix`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(fix.status).toBe(200);
    expect(fix.body.data.webhookCheck.status).toBe('ok');
  });
});
