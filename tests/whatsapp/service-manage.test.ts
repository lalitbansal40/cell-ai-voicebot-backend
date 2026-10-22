import { Writable } from 'node:stream';

import { Types } from 'mongoose';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { open } from '../../src/core/ai/secret-box';
import { graphError } from '../../src/core/meta';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { MetaWebhookEventModel } from '../../src/db/models/meta-webhook-event.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../src/db/models/whatsapp-channel.model';
import { SYSTEM_ACTOR } from '../../src/modules/whatsapp/channel-status';
import { createWhatsAppService } from '../../src/modules/whatsapp/whatsapp.service';
import type { AppError } from '../../src/shared/errors/app-error';
import { createLogger, setLogger } from '../../src/shared/logger';
import { createTestAccount, type TestAccount } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import {
  codeFor,
  fakeSignup,
  idsFor,
  insertChannel,
  userActor,
  useWhatsAppWorld,
} from '../helpers/whatsapp';

useTestDb();
const emails = useCapturedEmail();
const w = useWhatsAppWorld();

const logLines: string[] = [];
setLogger(
  createLogger(
    { NODE_ENV: 'test', LOG_LEVEL: 'trace' },
    new Writable({
      write(chunk: Buffer, _enc, done) {
        logLines.push(chunk.toString());
        done();
      },
    }),
  ),
);
afterAll(() => setLogger(undefined));

let acc: TestAccount;
let ownerId: Types.ObjectId;
let ownerEmail: string;
let adminEmail: string;
beforeEach(async () => {
  acc = await createTestAccount();
  const owner = (await acc.addUser('owner')).user;
  ownerId = owner._id;
  ownerEmail = owner.email;
  adminEmail = (await acc.addUser('admin')).user.email;
  await acc.addUser('viewer');
});

const actor = () => userActor(ownerId);
const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as AppError,
  );
const connected = async (signup = fakeSignup()) => {
  const r = await w.svc.connect({
    accountId: acc.account._id,
    actor: actor(),
    mode: signup.mode,
    code: codeFor(signup),
  });
  return { ...r, signup, ids: idsFor(signup), id: r.channel.id };
};
const tokenOf = async (id: string) => (await w.svc.getChannelToken(id)).token;
const stored = (id: string) =>
  WhatsAppChannelModel.findById(id)
    .select('+tokenSealed +registration.pinSealed')
    .lean<WhatsAppChannelDoc>();

describe('sync', () => {
  it('refreshes details; rate limited to once a minute', async () => {
    const { id, ids } = await connected();
    await w.fake.patchPhone(ids.phoneNumberId, {
      quality_rating: 'YELLOW',
      messaging_limit_tier: 'TIER_10K',
    });
    const r = await w.svc.sync(acc.account._id, id, actor());
    expect(r).toMatchObject({
      outcome: 'connected',
      channel: { qualityRating: 'YELLOW', messagingLimitTier: 'TIER_10K' },
    });
    expect(r.channel.syncedAt).not.toBeNull();
    expect(await failure(w.svc.sync(acc.account._id, id, actor()))).toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('revoked token → needs reconnect, owners + admins notified (in-app + email) once', async () => {
    const { id } = await connected();
    await w.fake.revokeToken(await tokenOf(id));
    const r = await w.svc.syncChannel((await stored(id)) as WhatsAppChannelDoc, SYSTEM_ACTOR);
    expect(r.status).toBe('needs_reconnect');
    expect(r.statusReason?.code).toBe('token_invalid');
    const notes = await NotificationModel.find({
      accountId: acc.account._id,
      type: 'whatsapp.channel_needs_reconnect',
    }).lean();
    expect(notes).toHaveLength(2); // owner + admin, not the viewer
    expect(notes[0]?.link).toBe('/whatsapp/numbers');
    const sent = emails.filter((e) => e.template === 'whatsapp.needs_reconnect');
    expect(sent.map((e) => e.to).sort()).toEqual([adminEmail, ownerEmail].sort());
    expect(sent[0]?.vars).toMatchObject({ label: 'Test Business' });
    expect(
      await AuditLogModel.countDocuments({
        action: 'whatsapp.channel_status_changed',
        'target.id': id,
      }),
    ).toBe(1);
    // a second pass doesn't notify again
    await w.svc.syncChannel((await stored(id)) as WhatsAppChannelDoc, SYSTEM_ACTOR);
    expect(
      await NotificationModel.countDocuments({
        accountId: acc.account._id,
        type: 'whatsapp.channel_needs_reconnect',
      }),
    ).toBe(2);
    expect(await failure(w.svc.getChannelToken(id))).toMatchObject({
      code: 'WHATSAPP_CHANNEL_NOT_READY',
    });
    expect(await failure(w.svc.retrySetup(acc.account._id, id, actor()))).toMatchObject({
      code: 'CONFLICT_INVALID_STATE',
    });
  });

  it('190 from a details call, WABA access removed, missing token → needs reconnect', async () => {
    const a = await connected();
    w.fake.failNext('getWaba', graphError(401, { error: { code: 190 } }));
    expect((await w.svc.syncChannel((await stored(a.id))!, SYSTEM_ACTOR)).status).toBe(
      'needs_reconnect',
    );
    const b = await connected();
    const removed = {
      ...w.ctx,
      meta: {
        ...w.fake,
        debugToken: async (t: string) => ({
          ...(await w.fake.debugToken(t)),
          grantedWabaIds: ['999'],
        }),
      },
    };
    const r = await createWhatsAppService(removed).syncChannel((await stored(b.id))!, SYSTEM_ACTOR);
    expect(r.statusReason?.code).toBe('access_removed');
    const c = await connected();
    await WhatsAppChannelModel.updateOne(
      { _id: c.id },
      { $set: { tokenSealed: 'v1:bad:bad:bad' } },
    );
    expect((await w.svc.syncChannel((await stored(c.id))!, SYSTEM_ACTOR)).status).toBe(
      'needs_reconnect',
    );
    expect(logLines.join('')).toContain('token could not be opened');
  });

  it('needs reconnect heals when Meta confirms access again', async () => {
    const { id } = await connected();
    await WhatsAppChannelModel.updateOne({ _id: id }, { $set: { status: 'needs_reconnect' } });
    expect((await w.svc.syncChannel((await stored(id))!, SYSTEM_ACTOR)).status).toBe('connected');
  });

  it('banned / restricted numbers → restricted; lifted → connected', async () => {
    const { id, ids } = await connected();
    await w.fake.patchPhone(ids.phoneNumberId, { status: 'BANNED' });
    const r = await w.svc.syncChannel((await stored(id))!, SYSTEM_ACTOR);
    expect(r).toMatchObject({ status: 'restricted', restriction: { type: 'BANNED' } });
    expect(
      await NotificationModel.countDocuments({
        accountId: acc.account._id,
        type: 'whatsapp.channel_restricted',
      }),
    ).toBe(2);
    expect(emails.some((e) => e.template === 'whatsapp.restricted')).toBe(true);
    // a restriction with a future end date stays while Meta reports the number fine
    await WhatsAppChannelModel.updateOne(
      { _id: id },
      { $set: { restriction: { type: 'X', until: new Date(Date.now() + 86_400_000) } } },
    );
    await w.fake.patchPhone(ids.phoneNumberId, { status: 'CONNECTED' });
    expect((await w.svc.syncChannel((await stored(id))!, SYSTEM_ACTOR)).status).toBe('restricted');
    await WhatsAppChannelModel.updateOne(
      { _id: id },
      { $set: { restriction: { type: 'X', until: new Date(Date.now() - 1000) } } },
    );
    const lifted = await w.svc.syncChannel((await stored(id))!, SYSTEM_ACTOR);
    expect(lifted).toMatchObject({ status: 'connected', restriction: null });
  });

  it('other Meta errors → 502; disconnected → not ready; a stuck connecting channel resumes', async () => {
    const { id } = await connected();
    w.fake.failNext(
      'getWaba',
      graphError(400, { error: { code: 100, type: 'GraphMethodException' } }),
    );
    expect((await failure(w.svc.syncChannel((await stored(id))!, SYSTEM_ACTOR)))?.code).toBe(
      'META_API_ERROR',
    );
    w.fake.failNext('getWaba', new Error('oops') as never);
    await expect(w.svc.syncChannel((await stored(id))!, SYSTEM_ACTOR)).rejects.toThrow('oops');
    await WhatsAppChannelModel.updateOne({ _id: id }, { $set: { status: 'connecting' } });
    expect((await w.svc.syncChannel((await stored(id))!, SYSTEM_ACTOR)).status).toBe('connected');
    await w.svc.disconnect(acc.account._id, id, actor());
    expect((await failure(w.svc.syncChannel((await stored(id))!, SYSTEM_ACTOR)))?.code).toBe(
      'WHATSAPP_CHANNEL_NOT_READY',
    );
  });
});

describe('coexistence retry', () => {
  it('retries failed syncs; nothing to retry → 409; tokens gone → not ready', async () => {
    w.fake.failNext('requestCoexistenceSync');
    w.fake.failNext('requestCoexistenceSync');
    const { id } = await connected(fakeSignup({ mode: 'coexistence' }));
    expect((await stored(id))?.coexistence).toMatchObject({
      contactsSync: 'failed',
      historySync: 'failed',
    });
    const r = await w.svc.retryCoexistenceSync(acc.account._id, id, actor());
    expect(r.channel.coexistence).toMatchObject({
      contactsSync: 'requested',
      historySync: 'requested',
    });
    expect((await failure(w.svc.retryCoexistenceSync(acc.account._id, id, actor())))?.code).toBe(
      'CONFLICT_INVALID_STATE',
    );
    const cloud = await connected();
    expect(
      (await failure(w.svc.retryCoexistenceSync(acc.account._id, cloud.id, actor())))?.code,
    ).toBe('CONFLICT_INVALID_STATE');
    // rate limit + token error
    w.fake.failNext('requestCoexistenceSync');
    const two = await connected(fakeSignup({ mode: 'coexistence' }));
    w.fake.failNext('requestCoexistenceSync', graphError(401, { error: { code: 190 } }));
    expect(
      (await failure(w.svc.retryCoexistenceSync(acc.account._id, two.id, actor())))?.code,
    ).toBe('WHATSAPP_CHANNEL_NOT_READY');
    expect((await stored(two.id))?.status).toBe('needs_reconnect');
    w.fake.failNext('requestCoexistenceSync');
    const three = await connected(fakeSignup({ mode: 'coexistence' }));
    w.fake.failNext('requestCoexistenceSync', new Error('bug') as never);
    await expect(w.svc.retryCoexistenceSync(acc.account._id, three.id, actor())).rejects.toThrow(
      'bug',
    );
    expect(
      (await failure(w.svc.retryCoexistenceSync(acc.account._id, three.id, actor())))?.code,
    ).toBe('RATE_LIMITED');
  });

  it('a channel without a token cannot retry', async () => {
    w.fake.failNext('requestCoexistenceSync');
    const { id } = await connected(fakeSignup({ mode: 'coexistence' }));
    await WhatsAppChannelModel.updateOne({ _id: id }, { $set: { tokenSealed: null } });
    expect((await failure(w.svc.retryCoexistenceSync(acc.account._id, id, actor())))?.code).toBe(
      'WHATSAPP_CHANNEL_NOT_READY',
    );
  });
});

describe('rename / disconnect', () => {
  it('rename audits only real changes', async () => {
    const { id } = await connected();
    expect((await w.svc.rename(acc.account._id, id, 'Support line', actor())).label).toBe(
      'Support line',
    );
    await w.svc.rename(acc.account._id, id, 'Support line', actor());
    expect(
      await AuditLogModel.countDocuments({ action: 'whatsapp.channel_renamed', 'target.id': id }),
    ).toBe(1);
  });

  it('disconnect: unsubscribes when last on the WABA, clears secrets, never deregisters, idempotent', async () => {
    const { id, ids } = await connected();
    w.fake.calls.length = 0;
    const r = await w.svc.disconnect(acc.account._id, id, actor());
    expect(r.status).toBe('disconnected');
    expect(await w.fake.isSubscribed(ids.wabaId)).toBe(false);
    expect(await w.fake.isRegistered(ids.phoneNumberId)).toBe(true);
    expect(w.fake.calls.map((c) => c.op)).toEqual(['unsubscribeApp']);
    const s = await stored(id);
    expect(s?.tokenSealed).toBeNull();
    expect(s?.registration.pinSealed).toBeNull();
    expect(s?.disconnectedBy).toEqual(ownerId);
    const audit = await AuditLogModel.findOne({
      action: 'whatsapp.channel_disconnected',
      'target.id': id,
    }).lean();
    expect(audit?.meta).toMatchObject({ unsubscribed: true });
    w.fake.calls.length = 0;
    expect((await w.svc.disconnect(acc.account._id, id, actor())).status).toBe('disconnected');
    expect(w.fake.calls).toHaveLength(0);
  });

  it('keeps the subscription while another active channel uses the WABA; unsubscribe errors are ignored', async () => {
    const a = await connected();
    await insertChannel({ wabaId: a.ids.wabaId });
    await w.svc.disconnect(acc.account._id, a.id, actor());
    expect(await w.fake.isSubscribed(a.ids.wabaId)).toBe(true);
    const b = await connected();
    w.fake.failNext('unsubscribeApp');
    expect((await w.svc.disconnect(acc.account._id, b.id, actor())).status).toBe('disconnected');
    expect(logLines.join('')).toContain('unsubscribe failed');
  });

  it('disconnect by the platform team notifies owners / admins with an email', async () => {
    const { id } = await connected();
    await w.svc.disconnect(acc.account._id, id, actor(), { byAdminReason: 'Spam reports' });
    expect(
      await NotificationModel.countDocuments({
        accountId: acc.account._id,
        type: 'whatsapp.channel_disconnected_by_admin',
      }),
    ).toBe(2);
    const mail = emails.find((e) => e.template === 'whatsapp.admin_disconnected');
    expect(mail?.vars).toMatchObject({ reason: 'Spam reports' });
    expect((await stored(id))?.statusReason?.code).toBe('disconnected_by_admin');
  });
});

describe('views and isolation', () => {
  it('list with counts, detail with events / history, other accounts → 404', async () => {
    const a = await connected();
    await connected();
    await w.svc.disconnect(acc.account._id, a.id, actor());
    const list = await w.svc.listChannels(acc.account._id);
    expect(list.items).toHaveLength(2);
    expect(list.counts).toEqual({ connected: 1, disconnected: 1 });
    expect(list.limit).toBe(10);
    expect((await w.svc.listChannels(acc.account._id, 'connected')).items).toHaveLength(1);
    const channelId = new Types.ObjectId(a.id);
    const base = {
      object: 'whatsapp_business_account',
      payloadSealed: 'x',
      channelId,
      accountId: acc.account._id,
      expiresAt: new Date(Date.now() + 86_400_000),
    };
    await MetaWebhookEventModel.create([
      { ...base, key: `k1-${a.id}`, field: 'messages', receivedAt: new Date() },
      { ...base, key: `k2-${a.id}`, field: 'messages', receivedAt: new Date() },
      { ...base, key: `k3-${a.id}`, field: 'account_update', receivedAt: new Date() },
      {
        ...base,
        key: `k4-${a.id}`,
        field: 'messages',
        receivedAt: new Date(Date.now() - 2 * 86_400_000),
      },
    ]);
    const detail = await w.svc.getChannel(acc.account._id, a.id);
    expect(detail.events24h).toEqual({ total: 3, byField: { messages: 2, account_update: 1 } });
    expect(detail.history[0]?.status).toBe('disconnected');
    expect(detail).toMatchObject({ businessId: a.ids.businessId, wabaCurrency: 'INR' });
    expect(JSON.stringify(detail)).not.toMatch(/tokenSealed|pinSealed|fake_tok_/);
    const other = await createTestAccount();
    expect((await failure(w.svc.getChannel(other.account._id, a.id)))?.code).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect((await failure(w.svc.getChannel(acc.account._id, 'nope')))?.code).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect((await failure(w.svc.rename(other.account._id, a.id, 'x', actor())))?.code).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect((await failure(w.svc.disconnect(other.account._id, a.id, actor())))?.code).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect((await w.svc.listChannels(other.account._id)).items).toHaveLength(0);
  });

  it('getChannelToken: connected / action needed only', async () => {
    const { id } = await connected();
    const { token, channel } = await w.svc.getChannelToken(id);
    expect(token).toMatch(/^fake_tok_/);
    expect(channel._id.toString()).toBe(id);
    expect(await failure(w.svc.getChannelToken(new Types.ObjectId()))).toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    await WhatsAppChannelModel.updateOne({ _id: id }, { $set: { tokenSealed: null } });
    expect((await failure(w.svc.getChannelToken(id)))?.code).toBe('WHATSAPP_CHANNEL_NOT_READY');
  });

  it('retry setup / PIN on a channel without a token → needs reconnect', async () => {
    w.fake.failNext('subscribeApp');
    const { id } = await connected();
    await WhatsAppChannelModel.updateOne({ _id: id }, { $set: { tokenSealed: null } });
    expect((await failure(w.svc.retrySetup(acc.account._id, id, actor())))?.code).toBe(
      'WHATSAPP_CHANNEL_NOT_READY',
    );
    expect((await stored(id))?.status).toBe('needs_reconnect');
  });

  it('manual connect with an existing token is audited as manual', async () => {
    const signup = fakeSignup();
    const { accessToken } = await w.fake.exchangeCode(codeFor(signup));
    const r = await w.svc.connect({
      accountId: acc.account._id,
      actor: { type: 'user', id: new Types.ObjectId(), platform: true },
      mode: 'cloud_api',
      accessToken,
      manual: true,
      sessionInfo: { wabaId: idsFor(signup).wabaId, phoneNumberId: idsFor(signup).phoneNumberId },
    });
    expect(r.outcome).toBe('connected');
    const audit = await AuditLogModel.findOne({
      action: 'whatsapp.channel_connected',
      'target.id': r.channel.id,
    }).lean();
    expect(audit?.meta).toMatchObject({ manual: true });
    expect(audit?.actor.platform).toBe(true);
  });
});

describe('logs', () => {
  it('never contain tokens, PINs, codes or the full number', async () => {
    logLines.length = 0;
    const signup = fakeSignup({
      phone: '+91 90000 00001',
      businessName: `Log Co ${String(Date.now())}`,
    });
    const code = codeFor(signup);
    const r = await w.svc.connect({
      accountId: acc.account._id,
      actor: actor(),
      mode: 'cloud_api',
      code,
    });
    await w.svc.submitPin(acc.account._id, r.channel.id, '123456', actor());
    const token = await tokenOf(r.channel.id);
    const pin = open(w.ctx.key, (await stored(r.channel.id))?.registration.pinSealed ?? '');
    w.fake.failNext('unsubscribeApp');
    await w.svc.disconnect(acc.account._id, r.channel.id, actor());
    const text = logLines.join('\n');
    expect(logLines.length).toBeGreaterThan(0);
    for (const secret of [token, code, pin, signup.phone.replace(/\D/g, '')]) {
      expect(text).not.toContain(secret);
    }
  });
});
