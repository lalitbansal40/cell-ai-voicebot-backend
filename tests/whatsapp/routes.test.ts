import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { AccountModel } from '../../src/db/models/account.model';
import type { WhatsAppJobs } from '../../src/modules/whatsapp/jobs';
import { whatsappConfig } from '../../src/modules/whatsapp/whatsapp.routes';
import { createTestAccount, tokenFor, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { buildTestApp } from '../helpers/test-app';
import { codeFor, fakeSignup, idsFor, useWhatsAppWorld } from '../helpers/whatsapp';

useTestDb();
useCapturedEmail();
const w = useWhatsAppWorld();
const jobs: WhatsAppJobs = { enqueueEvent: () => Promise.resolve() };
const app = () => buildTestApp({}, { whatsapp: { ctx: w.ctx, jobs } });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const base = '/api/v1/whatsapp';

let acc: TestAccount;
const users = {} as Record<'owner' | 'admin' | 'manager' | 'agent' | 'viewer', TestUser>;
beforeEach(async () => {
  acc = await createTestAccount();
  for (const role of ['owner', 'admin', 'manager', 'agent', 'viewer'] as const) {
    users[role] = await acc.addUser(role);
  }
});

const signupBody = (signup = fakeSignup()) => ({
  code: codeFor(signup),
  mode: signup.mode,
  sessionInfo: { wabaId: idsFor(signup).wabaId, phoneNumberId: idsFor(signup).phoneNumberId },
});
const connect = async (token = users.owner.token, target = app()) => {
  const res = await request(target)
    .post(`${base}/channels/embedded-signup`)
    .set(bearer(token))
    .send(signupBody());
  return res;
};

describe('/whatsapp API', () => {
  it('config: public values only', async () => {
    const res = await request(app()).get(`${base}/config`).set(bearer(users.viewer.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      enabled: true,
      provider: 'fake',
      appId: null,
      configId: null,
      graphVersion: w.env.META_GRAPH_VERSION,
    });
    expect(
      whatsappConfig({
        ...w.ctx,
        env: { ...w.env, META_PROVIDER: 'meta', META_APP_ID: '123', META_ES_CONFIG_ID: '456' },
      }),
    ).toMatchObject({ provider: 'meta', appId: '123', configId: '456' });
    expect(whatsappConfig({ ...w.ctx, env: { ...w.env, META_PROVIDER: 'meta' } })).toMatchObject({
      appId: null,
      configId: null,
    });
    expect((await request(app()).get(`${base}/config`)).status).toBe(401);
  });

  it('owner connects; every role reads; only owner / admin change', async () => {
    const created = await connect();
    expect(created.status).toBe(200);
    expect(created.body.data).toMatchObject({ outcome: 'connected', reconnected: false });
    const id = created.body.data.channel.id as string;
    for (const role of ['owner', 'admin', 'manager', 'agent', 'viewer'] as const) {
      const list = await request(app()).get(`${base}/channels`).set(bearer(users[role].token));
      expect(list.status, role).toBe(200);
      expect(list.body.data.items).toHaveLength(1);
      expect(list.body.data.counts).toEqual({ connected: 1 });
      expect(
        (await request(app()).get(`${base}/channels/${id}`).set(bearer(users[role].token))).status,
      ).toBe(200);
    }
    for (const role of ['manager', 'agent', 'viewer'] as const) {
      const t = users[role].token;
      expect((await connect(t)).status, role).toBe(403);
      expect(
        (await request(app()).patch(`${base}/channels/${id}`).set(bearer(t)).send({ label: 'x' }))
          .status,
      ).toBe(403);
      for (const action of ['sync', 'retry-setup', 'coexistence-sync', 'disconnect']) {
        expect(
          (await request(app()).post(`${base}/channels/${id}/${action}`).set(bearer(t))).status,
        ).toBe(403);
      }
      expect(
        (
          await request(app())
            .post(`${base}/channels/${id}/register`)
            .set(bearer(t))
            .send({ pin: '123456' })
        ).status,
      ).toBe(403);
    }
    const admin = users.admin.token;
    const renamed = await request(app())
      .patch(`${base}/channels/${id}`)
      .set(bearer(admin))
      .send({ label: 'Sales' });
    expect(renamed.body.data.label).toBe('Sales');
    expect(
      (await request(app()).post(`${base}/channels/${id}/sync`).set(bearer(admin))).body.data
        .outcome,
    ).toBe('connected');
    expect(
      (await request(app()).post(`${base}/channels/${id}/sync`).set(bearer(admin))).status,
    ).toBe(429);
    expect(
      (await request(app()).post(`${base}/channels/${id}/retry-setup`).set(bearer(admin))).status,
    ).toBe(409);
    expect(
      (
        await request(app())
          .post(`${base}/channels/${id}/register`)
          .set(bearer(admin))
          .send({ pin: '123456' })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app())
          .post(`${base}/channels/${id}/register`)
          .set(bearer(admin))
          .send({ pin: '12' })
      ).status,
    ).toBe(422);
    expect(
      (await request(app()).post(`${base}/channels/${id}/coexistence-sync`).set(bearer(admin)))
        .status,
    ).toBe(409);
    const detail = await request(app()).get(`${base}/channels/${id}`).set(bearer(admin));
    expect(detail.body.data.history.length).toBeGreaterThan(0);
    expect(JSON.stringify(detail.body)).not.toMatch(/tokenSealed|pinSealed|fake_tok_/);
    const gone = await request(app()).post(`${base}/channels/${id}/disconnect`).set(bearer(admin));
    expect(gone.body.data.status).toBe('disconnected');
    const filtered = await request(app())
      .get(`${base}/channels`)
      .query({ status: 'connected' })
      .set(bearer(admin));
    expect(filtered.body.data.items).toHaveLength(0);
  });

  it('signup errors surface as API errors', async () => {
    const res = await request(app())
      .post(`${base}/channels/embedded-signup`)
      .set(bearer(users.owner.token))
      .send({ ...signupBody(fakeSignup({ outcome: 'error' })) });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({
      code: 'WHATSAPP_SIGNUP_FAILED',
      details: [{ path: 'step', message: 'exchange' }],
    });
    const bad = await request(app())
      .post(`${base}/channels/embedded-signup`)
      .set(bearer(users.owner.token))
      .send({ code: 'x', mode: 'cloud_api', sessionInfo: { wabaId: 'drop table' } });
    expect(bad.status).toBe(422);
  });

  it("another account's number → 404 on every route, never listed", async () => {
    const id = (await connect()).body.data.channel.id as string;
    const other = await createTestAccount();
    const stranger = await other.addUser('owner');
    const t = stranger.token;
    expect(
      (await request(app()).get(`${base}/channels`).set(bearer(t))).body.data.items,
    ).toHaveLength(0);
    expect((await request(app()).get(`${base}/channels/${id}`).set(bearer(t))).status).toBe(404);
    expect(
      (await request(app()).patch(`${base}/channels/${id}`).set(bearer(t)).send({ label: 'x' }))
        .status,
    ).toBe(404);
    for (const action of ['sync', 'retry-setup', 'coexistence-sync', 'disconnect']) {
      expect(
        (await request(app()).post(`${base}/channels/${id}/${action}`).set(bearer(t))).status,
        action,
      ).toBe(404);
    }
    expect(
      (
        await request(app())
          .post(`${base}/channels/${id}/register`)
          .set(bearer(t))
          .send({ pin: '123456' })
      ).status,
    ).toBe(404);
    expect((await request(app()).get(`${base}/channels/nope`).set(bearer(t))).status).toBe(422);
  });

  it('impersonators read only; suspended accounts read only', async () => {
    const id = (await connect()).body.data.channel.id as string;
    const platform = await createTestAccount({
      isPlatform: true,
      slug: `p-wa-${Date.now()}`,
      name: 'P',
    });
    const superadmin = await platform.addUser('owner', { platformRole: 'superadmin' });
    const imp = await tokenFor(users.owner.user, { imp: superadmin.user._id.toString() });
    expect((await request(app()).get(`${base}/channels/${id}`).set(bearer(imp))).status).toBe(200);
    const blocked = await connect(imp);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('AUTH_IMPERSONATION_BLOCKED');
    expect(
      (await request(app()).post(`${base}/channels/${id}/disconnect`).set(bearer(imp))).status,
    ).toBe(403);
    await AccountModel.updateOne({ _id: acc.account._id }, { $set: { status: 'suspended' } });
    expect(
      (await request(app()).get(`${base}/channels`).set(bearer(users.owner.token))).status,
    ).toBe(200);
    expect((await connect()).status).toBe(403);
    expect(
      (await request(app()).post(`${base}/channels/${id}/sync`).set(bearer(users.owner.token)))
        .status,
    ).toBe(403);
  });

  it('WhatsApp off → 503 on every /whatsapp route', async () => {
    const off = buildTestApp({ WHATSAPP_ENABLED: 'false' });
    for (const [method, url] of [
      ['get', `${base}/config`],
      ['get', `${base}/channels`],
      ['post', `${base}/channels/embedded-signup`],
    ] as const) {
      const res = await request(off)[method](url).set(bearer(users.owner.token));
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('WHATSAPP_NOT_CONFIGURED');
    }
    expect((await request(off).get(`${base}/channels`)).status).toBe(401);
  });

  it('connects are rate limited per account (10 / hour)', async () => {
    const target = app();
    for (let i = 0; i < 10; i += 1) {
      const res = await request(target)
        .post(`${base}/channels/embedded-signup`)
        .set(bearer(users.owner.token))
        .send({ code: 'x', mode: 'cloud_api' });
      expect(res.status).toBe(422);
    }
    const limited = await request(target)
      .post(`${base}/channels/embedded-signup`)
      .set(bearer(users.admin.token))
      .send({ code: 'x', mode: 'cloud_api' });
    expect(limited.status).toBe(429);
  });
});
