import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { AccountModel, DEFAULT_INBOX_SETTINGS } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { DndEntryModel } from '../../src/db/models/dnd-entry.model';
import { platformSettingProblems } from '../../src/db/models/platform-settings.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { matchKeyword } from '../../src/modules/inbox/keywords';
import { assertCanSend, consentWarnings } from '../../src/modules/inbox/outbound.service';
import { applyVoiceOptOut } from '../../src/modules/post-call/evaluate';
import { scheduledAtFor } from '../../src/modules/post-call/timing';
import { recordSuppression } from '../../src/modules/privacy/suppression';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const app = buildTestApp();
let a: TestAccount;
let owner: TestUser;
let viewer: TestUser;
let superadmin: TestUser;
const header = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
const lists = DEFAULT_INBOX_SETTINGS;

beforeAll(async () => {
  a = await createTestAccount();
  owner = await a.addUser('owner');
  viewer = await a.addUser('viewer');
  const platform = await createTestAccount({ isPlatform: true });
  superadmin = await platform.addUser('owner', { platformRole: 'superadmin' });
});

describe('opt-out words', () => {
  it.each([
    'STOP',
    'stop',
    '  Stop!! ',
    'band karo',
    'BAND  KARO.',
    'mat bhejo',
    'unsubscribe',
    'बंद करो।',
  ])('"%s" opts out', (text) => {
    expect(matchKeyword(text, lists)).toBe('opt_out');
  });

  it('a sentence holding the word is not an opt-out; START opts in', () => {
    expect(matchKeyword('please do not stop my loan', lists)).toBeNull();
    expect(matchKeyword('mera order band karo mat', lists)).toBeNull();
    expect(matchKeyword('', lists)).toBeNull();
    expect(matchKeyword(null, lists)).toBeNull();
    expect(matchKeyword('START', lists)).toBe('opt_in');
  });
});

describe('voice opt-out', () => {
  it('"do not call" puts the number on the list; other results and no contact do not', async () => {
    const accountId = a.account._id;
    const contact = await ContactModel.collection.insertOne({
      accountId,
      phoneE164: '+919600000001',
      deletedAt: null,
    });
    const call = { accountId, contactId: contact.insertedId, disposition: 'do_not_call' };
    expect(await applyVoiceOptOut(call as never)).toBe(true);
    const entry = await DndEntryModel.findOne({ accountId, phoneE164: '+919600000001' }).lean();
    expect(entry?.source).toBe('voice');
    expect(await applyVoiceOptOut({ ...call, disposition: 'paid' })).toBe(false);
    expect(await applyVoiceOptOut({ ...call, contactId: null })).toBe(false);
    expect(await applyVoiceOptOut({ ...call, contactId: new Types.ObjectId() })).toBe(false);
  });
});

describe('marketing consent', () => {
  const none = { consent: null };

  it('warns with no_consent by default; refuses with requireOptInForMarketing', async () => {
    const id = a.account._id;
    expect(await consentWarnings(id, none as never, 'MARKETING')).toEqual(['no_consent']);
    expect(await consentWarnings(id, none as never, 'UTILITY')).toEqual([]);
    const given = { consent: { source: 'form', at: new Date() } };
    expect(await consentWarnings(id, given as never, 'MARKETING')).toEqual([]);
    await AccountModel.updateOne(
      { _id: id },
      { $set: { 'settings.requireOptInForMarketing': true } },
    );
    await expect(consentWarnings(id, none as never, 'MARKETING')).rejects.toMatchObject({
      code: 'TEMPLATE_MARKETING_BLOCKED',
    });
    await AccountModel.updateOne(
      { _id: id },
      { $set: { 'settings.requireOptInForMarketing': false } },
    );
  });
});

describe('business-initiated sends', () => {
  it('a suppressed number gets no template; a reply in the open window still goes', async () => {
    const channel = await WhatsAppChannelModel.collection.insertOne({
      accountId: a.account._id,
      status: 'connected',
    });
    const conversation = {
      accountId: a.account._id,
      channelId: channel.insertedId,
      phoneE164: '+919600000002',
      blocked: false,
      windowExpiresAt: new Date(Date.now() + 3_600_000),
    };
    await recordSuppression(a.account._id, '+919600000002', 'opted_out');
    await expect(
      assertCanSend(conversation as never, new Date(), { window: false }),
    ).rejects.toMatchObject({ code: 'WHATSAPP_RECIPIENT_BLOCKED' });
    await expect(assertCanSend(conversation as never, new Date())).resolves.toBeTruthy();
  });
});

describe('calling window ceiling', () => {
  const save = (u: TestUser, start: string, end: string) =>
    request(app)
      .patch('/api/v1/account')
      .set(header(u))
      .send({ settings: { callingWindow: { start, end, days: [1, 2, 3] } } });
  const ceiling = '/api/v1/admin/compliance/ceiling';

  it('stops a window outside the default 08:00–19:00', async () => {
    expect((await save(owner, '08:00', '19:00')).status).toBe(200);
    expect((await save(owner, '07:59', '19:00')).status).toBe(422);
    const late = await save(owner, '09:00', '19:30');
    expect(late.status).toBe(422);
    expect(late.body.error.details[0].message).toContain('08:00');
  });

  it('a superadmin can change it, audited; others cannot', async () => {
    const get = await request(app).get(ceiling).set(header(superadmin));
    expect(get.body.data).toEqual({ start: '08:00', end: '19:00' });
    expect(
      (await request(app).put(ceiling).set(header(owner)).send({ start: '08:00', end: '20:00' }))
        .status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .put(ceiling)
          .set(header(superadmin))
          .send({ start: '20:00', end: '08:00' })
      ).status,
    ).toBe(422);
    expect(
      (await request(app).put(ceiling).set(header(superadmin)).send({ start: '9', end: '20:00' }))
        .status,
    ).toBe(422);
    const put = await request(app)
      .put(ceiling)
      .set(header(superadmin))
      .send({ start: '08:00', end: '20:00' });
    expect(put.status).toBe(200);
    expect((await save(owner, '09:00', '19:30')).status).toBe(200);
    expect(await AuditLogModel.countDocuments({ action: 'compliance.ceiling_changed' })).toBe(1);
    await request(app).put(ceiling).set(header(superadmin)).send({ start: '08:00', end: '19:00' });
    await save(owner, '09:00', '19:00');
  });

  it('checks the stored value', () => {
    expect(
      platformSettingProblems('callingWindowCeiling', { start: '08:00', end: '19:00' }),
    ).toEqual([]);
    expect(platformSettingProblems('callingWindowCeiling', null)).toHaveLength(1);
  });

  it('the after-call send waits for the window with next_window_hour', () => {
    const window = { start: '09:00', end: '19:00', days: [1, 2, 3, 4, 5, 6] };
    const at = scheduledAtFor(
      { mode: 'next_window_hour', delayMinutes: 0 },
      new Date('2026-11-02T20:00:00+05:30'),
      window,
      'Asia/Kolkata',
    );
    expect(at.toISOString()).toBe('2026-11-03T03:30:00.000Z');
  });
});

describe('GET /account/compliance', () => {
  it('shows rules and counts, for any account reader', async () => {
    const accountId = a.account._id;
    await DndEntryModel.create({ accountId, phoneE164: '+919600000010', source: 'manual' });
    await ContactModel.collection.insertOne({
      accountId,
      phoneE164: '+919600000011',
      optedOutAt: new Date('2026-11-01T00:00:00Z'),
      consent: { source: 'form', at: new Date() },
      deletedAt: null,
    });
    const res = await request(app).get('/api/v1/account/compliance').set(header(viewer));
    expect(res.status).toBe(200);
    expect(res.body.data.ceiling).toEqual({ start: '08:00', end: '19:00' });
    expect(res.body.data.counts.withConsent).toBeGreaterThanOrEqual(1);
    expect(res.body.data.counts.optedOut).toBeGreaterThanOrEqual(1);
    expect(res.body.data.optOutKeywords).toContain('STOP');
    expect(JSON.stringify(res.body)).not.toContain('+9196');
  });

  it('CSV: full phones with contacts.export, masked without; audited with a count', async () => {
    const full = await request(app).get('/api/v1/account/compliance/export').set(header(owner));
    expect(full.status).toBe(200);
    expect(full.headers['content-type']).toContain('text/csv');
    expect(full.text).toContain('+919600000010');
    expect(full.text).toContain('opt_out,+919600000011');
    const masked = await request(app).get('/api/v1/account/compliance/export').set(header(viewer));
    expect(masked.text).not.toContain('+919600000010');
    const audit = await AuditLogModel.findOne({ action: 'compliance.exported' }).lean();
    expect(JSON.stringify(audit)).not.toContain('+9196');
  });

  it('another account sees only its own', async () => {
    const other = await createTestAccount();
    const u = await other.addUser('owner');
    const res = await request(app).get('/api/v1/account/compliance/export').set(header(u));
    expect(res.text).not.toContain('+9196');
    expect((await request(app).get('/api/v1/account/compliance')).status).toBe(401);
  });
});
