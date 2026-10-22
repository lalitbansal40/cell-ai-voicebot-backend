import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { buildSignedRequest } from '../../src/core/meta';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { MetaDeletionRequestModel } from '../../src/db/models/meta-deletion-request.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../src/db/models/whatsapp-channel.model';
import type { WhatsAppJobs } from '../../src/modules/whatsapp/jobs';
import { createTestAccount, type TestAccount } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { buildTestApp } from '../helpers/test-app';
import { codeFor, fakeSignup, idsFor, userActor, useWhatsAppWorld } from '../helpers/whatsapp';

useTestDb();
useCapturedEmail();
const w = useWhatsAppWorld();
const jobs: WhatsAppJobs = { enqueueEvent: () => Promise.resolve() };
const app = () => buildTestApp({}, { whatsapp: { ctx: w.ctx, jobs } });

let acc: TestAccount;
beforeEach(async () => {
  acc = await createTestAccount();
  await acc.addUser('owner');
});

const connect = async () => {
  const signup = fakeSignup();
  const r = await w.svc.connect({
    accountId: acc.account._id,
    actor: userActor(),
    mode: 'cloud_api',
    code: codeFor(signup),
  });
  return { id: r.channel.id, userId: idsFor(signup).userId };
};
const signed = (userId: string, over: Record<string, unknown> = {}, secret?: string) =>
  buildSignedRequest(
    {
      algorithm: 'HMAC-SHA256',
      user_id: userId,
      issued_at: Math.floor(Date.now() / 1000),
      ...over,
    },
    secret ?? w.env.FAKE_META_APP_SECRET ?? '',
  );
const post = (path: string, body: Record<string, string>) =>
  request(app()).post(`/api/v1/meta/${path}`).type('form').send(body);
const withSecrets = (id: string) =>
  WhatsAppChannelModel.findById(id)
    .select('+tokenSealed +registration.pinSealed')
    .lean<WhatsAppChannelDoc>();

describe('deauthorize callback', () => {
  it("marks that Meta user's active channels as needs reconnect (audited)", async () => {
    const a = await connect();
    const other = await connect();
    const res = await post('deauthorize', { signed_request: signed(a.userId) });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ channels: 1 });
    expect(await withSecrets(a.id)).toMatchObject({
      status: 'needs_reconnect',
      statusReason: { code: 'deauthorized' },
    });
    expect((await withSecrets(other.id))?.status).toBe('connected');
    expect(
      await AuditLogModel.findOne({
        accountId: acc.account._id,
        action: 'meta.deauthorized',
      }).lean(),
    ).toMatchObject({ actor: { type: 'system' }, meta: { channels: 1 } });
    expect((await post('deauthorize', { signed_request: signed('nobody') })).body.data).toEqual({
      channels: 0,
    });
  });

  it('bad / stale / missing signed_request', async () => {
    const bad = await post('deauthorize', { signed_request: signed('1', {}, 'wrong-secret') });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('META_SIGNATURE_INVALID');
    const stale = await post('deauthorize', {
      signed_request: signed('1', { issued_at: Math.floor(Date.now() / 1000) - 2 * 86_400 }),
    });
    expect(stale.status).toBe(422);
    expect(stale.body.error.details[0].message).toBe('Invalid (expired)');
    expect((await post('deauthorize', {})).status).toBe(422);
    expect((await post('data-deletion', { signed_request: 'garbage' })).status).toBe(422);
  });
});

describe('data deletion callback', () => {
  it('stores the request, clears tokens / PINs, answers Meta, status page', async () => {
    const a = await connect();
    await w.svc.disconnect(acc.account._id, (await connect()).id, userActor());
    const res = await post('data-deletion', { signed_request: signed(a.userId) });
    expect(res.status).toBe(200);
    const { url, confirmation_code: code } = res.body as { url: string; confirmation_code: string };
    expect(code).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(url).toBe(`${w.env.FRONTEND_URL.replace(/\/+$/, '')}/data-deletion?code=${code}`);
    const channel = await withSecrets(a.id);
    expect(channel).toMatchObject({
      status: 'needs_reconnect',
      tokenSealed: null,
      metaUserId: null,
      statusReason: { code: 'data_deleted' },
    });
    expect(channel?.registration.pinSealed).toBeNull();
    expect(await MetaDeletionRequestModel.findOne({ confirmationCode: code }).lean()).toMatchObject(
      {
        status: 'completed',
        channelsAffected: 1,
      },
    );
    expect(
      await AuditLogModel.countDocuments({
        accountId: acc.account._id,
        action: 'meta.data_deletion_requested',
      }),
    ).toBe(1);
    const status = await request(app()).get(`/api/v1/meta/data-deletion/${code}`);
    expect(status.status).toBe(200);
    expect(status.body.data).toMatchObject({ status: 'completed' });
    expect(status.body.data.completedAt).not.toBeNull();
    expect((await request(app()).get('/api/v1/meta/data-deletion/AAAAAAAAAAAAAAAA')).status).toBe(
      404,
    );
    expect((await request(app()).get('/api/v1/meta/data-deletion/short')).status).toBe(404);
  });

  it('a user without channels still gets a confirmation; a received request shows no completion', async () => {
    const res = await post('data-deletion', { signed_request: signed('2000000099') });
    const code = (res.body as { confirmation_code: string }).confirmation_code;
    await MetaDeletionRequestModel.updateOne(
      { confirmationCode: code },
      { $set: { status: 'received', completedAt: null } },
    );
    const status = await request(app()).get(`/api/v1/meta/data-deletion/${code}`);
    expect(status.body.data).toMatchObject({ status: 'received', completedAt: null });
  });

  it('not mounted when WhatsApp is off', async () => {
    expect((await request(buildTestApp()).post('/api/v1/meta/deauthorize')).status).toBe(404);
  });
});
