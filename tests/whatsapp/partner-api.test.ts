import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { buildPublicSpec } from '../../src/modules/docs/public-spec';
import { sealSecret } from '../../src/modules/whatsapp/context';
import { PARTNER_API_ENDPOINTS } from '../../src/modules/whatsapp/partner-api.catalogue';
import { maskPartnerBody } from '../../src/modules/whatsapp/partner-api.service';
import {
  createTestAccount,
  TEST_PASSWORD,
  tokenFor,
  type TestAccount,
  type TestUser,
} from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { buildTestApp } from '../helpers/test-app';
import { fakeSignup, insertChannel, useWhatsAppWorld } from '../helpers/whatsapp';

/** PIN: the Pinnacle partner API reference — superadmins only, with the number's key. */
useTestDb();
useCapturedEmail();
const w = useWhatsAppWorld({ PINNACLE_ENABLED: 'true' });

let acc: TestAccount;
let owner: TestUser;
let sa: TestUser;
let apiKey: string;
let channelId: string;
let ids: { wabaId: string; phoneNumberId: string };

const app = () =>
  buildTestApp({}, { whatsapp: { ctx: w.ctx, jobs: { enqueueEvent: () => Promise.resolve() } } });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeEach(async () => {
  acc = await createTestAccount();
  owner = await acc.addUser('owner');
  const platform = await createTestAccount({ isPlatform: true });
  sa = await platform.addUser('owner', { platformRole: 'superadmin' });
  const signup = fakeSignup();
  const number = await w.pinnacle.seedManagedNumber({
    businessName: signup.businessName,
    phone: signup.phone,
  });
  apiKey = number.apiKey;
  ids = { wabaId: number.wabaId, phoneNumberId: number.phoneNumberId };
  const ch = await insertChannel({
    accountId: acc.account._id,
    label: 'Managed',
    provider: 'pinnacle',
    wabaId: number.wabaId,
    phoneNumberId: number.phoneNumberId,
    displayPhoneNumber: signup.phone,
    tokenSealed: sealSecret(w.ctx, apiKey),
    pinnacle: {
      webhookUrl: 'https://example.test/hook',
      webhookSetAt: new Date(),
      keyLast4: apiKey.slice(-4),
      keyCheckedAt: new Date(),
      lastBalanceErrorAt: null,
      addedBy: null,
    },
  } as never);
  channelId = ch._id.toString();
});

const fullToken = (imm: 'full' | 'view' = 'full') =>
  tokenFor(owner.user, {
    sid: `imp_pin_${imm}_${new Types.ObjectId().toString()}`,
    imp: sa.user._id.toString(),
    imm,
    imk: 'superadmin' as const,
    ims: Math.floor(Date.now() / 1000),
  });

describe('partner API catalogue (PIN-T1)', () => {
  it('every entry is complete, Try it only on GETs, no real ids or keys inside', () => {
    for (const e of PARTNER_API_ENDPOINTS) {
      expect(e.id && e.group && e.path && e.summary, e.id).toBeTruthy();
      if (e.tryIt) expect(e.method, e.id).toBe('GET');
      if (e.group === 'Calling') expect(e.supported, e.id).toBe(false);
      expect(JSON.stringify(e), e.id).not.toMatch(/\d{12,}|pin_(test|live)_/);
    }
  });

  it('masks phone-like numbers and drops key fields', () => {
    expect(
      maskPartnerBody({ wanumber: '919000000010', apikey: 'x', nested: [{ token: 'y', a: 'b' }] }),
    ).toEqual({ wanumber: '…0010', nested: [{ a: 'b' }] });
  });
});

describe('who may see it (PIN-T2, D-P1)', () => {
  it('owner / admin / view login-as are refused; a superadmin and a full-access superadmin get it', async () => {
    const a = app();
    const admin = await acc.addUser('admin');
    for (const t of [owner.token, admin.token, await fullToken('view')]) {
      const res = await request(a).get('/api/v1/whatsapp/partner-api').set(bearer(t));
      expect(res.status).toBe(403);
    }
    for (const t of [owner.token, admin.token]) {
      const res = await request(a)
        .get(`/api/v1/admin/accounts/${acc.account._id.toString()}/partner-api`)
        .set(bearer(t));
      expect(res.status).toBe(403);
    }
    const viaAdmin = await request(a)
      .get(`/api/v1/admin/accounts/${acc.account._id.toString()}/partner-api`)
      .set(bearer(sa.token));
    expect(viaAdmin.status).toBe(200);
    expect(viaAdmin.body.data).toMatchObject({
      configured: true,
      authHeader: 'apikey',
      numbers: [{ channelId, keyConfigured: true, keyLast4: apiKey.slice(-4) }],
    });
    expect(viaAdmin.body.data.endpoints.length).toBe(PARTNER_API_ENDPOINTS.length);
    expect(JSON.stringify(viaAdmin.body)).not.toContain(apiKey);
    const full = await request(a)
      .get('/api/v1/whatsapp/partner-api')
      .set(bearer(await fullToken()));
    expect(full.status).toBe(200);
    expect(full.body.data.configured).toBe(true);
  });

  it('an account without a managed key: configured false', async () => {
    const other = await createTestAccount();
    const res = await request(app())
      .get(`/api/v1/admin/accounts/${other.account._id.toString()}/partner-api`)
      .set(bearer(sa.token));
    expect(res.body.data).toMatchObject({ configured: false, numbers: [] });
  });
});

describe('Reveal (PIN-T3)', () => {
  it('needs the superadmin password; then the key, no-store, audited without the key', async () => {
    const a = app();
    const url = `/api/v1/admin/whatsapp/channels/${channelId}/partner-api/reveal`;
    const wrong = await request(a).post(url).set(bearer(sa.token)).send({ password: 'nope-nope' });
    expect(wrong.body.error.code).toBe('REAUTH_FAILED');
    const res = await request(a).post(url).set(bearer(sa.token)).send({ password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ apiKey, keyLast4: apiKey.slice(-4), expiresInSec: 60 });
    expect(res.headers['cache-control']).toContain('no-store');
    const audit = await AuditLogModel.findOne({ action: 'whatsapp.managed_key_revealed' }).lean();
    expect(audit?.meta).toMatchObject({ keyLast4: apiKey.slice(-4) });
    expect(JSON.stringify(audit)).not.toContain(apiKey);
    // the owner can't, even with their own password
    const ownerTry = await request(a)
      .post(url)
      .set(bearer(owner.token))
      .send({ password: TEST_PASSWORD });
    expect(ownerTry.status).toBe(403);
  });

  it('5 reveals per hour; another account’s channel is 404', async () => {
    const a = app();
    const url = `/api/v1/whatsapp/channels/${channelId}/partner-api/reveal`;
    const token = await fullToken();
    let last = 0;
    for (let i = 0; i < 6; i += 1) {
      last = (await request(a).post(url).set(bearer(token)).send({ password: TEST_PASSWORD }))
        .status;
    }
    expect(last).toBe(429);
    const stranger = await insertChannel({ provider: 'pinnacle' });
    const res = await request(a)
      .post(`/api/v1/whatsapp/channels/${stranger._id.toString()}/partner-api/reveal`)
      .set(bearer(token))
      .send({ password: TEST_PASSWORD });
    expect(res.status).toBe(404);
  });
});

describe('Try it (PIN-T4)', () => {
  it('runs a read-only op with the key on our server; writes and unknown ids are refused', async () => {
    const a = app();
    const url = `/api/v1/admin/whatsapp/channels/${channelId}/partner-api/try`;
    const res = await request(a)
      .post(url)
      .set(bearer(sa.token))
      .send({ endpointId: 'key.details' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ endpointId: 'key.details', ok: true, httpStatus: 200 });
    expect(JSON.stringify(res.body.data.body)).toContain(ids.phoneNumberId);
    expect(JSON.stringify(res.body)).not.toContain(apiKey);
    expect(w.pinnacle.calls.map((c) => c.op)).toContain('partnerGet');
    for (const endpointId of ['messages.text', 'callback.set', 'nope']) {
      const bad = await request(a).post(url).set(bearer(sa.token)).send({ endpointId });
      expect(bad.body.error.code, endpointId).toBe('PARTNER_API_OP_NOT_ALLOWED');
    }
    expect(
      await AuditLogModel.countDocuments({
        action: 'whatsapp.partner_api_called',
        'meta.endpointId': 'key.details',
      }),
    ).toBe(1);
  });

  it('templates list and the webhook read work; 20 per 10 minutes', async () => {
    const a = app();
    const url = `/api/v1/whatsapp/channels/${channelId}/partner-api/try`;
    const token = await fullToken();
    for (const endpointId of ['templates.list', 'callback.get', 'number.get']) {
      const res = await request(a).post(url).set(bearer(token)).send({ endpointId });
      expect(res.status, endpointId).toBe(200);
    }
    let last = 0;
    for (let i = 0; i < 20; i += 1)
      last = (await request(a).post(url).set(bearer(token)).send({ endpointId: 'key.details' }))
        .status;
    expect(last).toBe(429);
  });
});

describe('never public (PIN-T7)', () => {
  it('the public OpenAPI has none of the partner API paths', () => {
    const full = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../openapi/openapi.json'), 'utf8'),
    ) as Parameters<typeof buildPublicSpec>[0];
    expect(Object.keys(full.paths).some((p) => p.includes('partner-api'))).toBe(true);
    expect(JSON.stringify(buildPublicSpec(full))).not.toContain('partner-api');
  });
});
