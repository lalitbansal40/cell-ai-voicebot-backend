import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resetEnvForTests } from '../../src/config/env';
import { AriClient } from '../../src/core/telephony/sip/ari-client';
import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { PhoneNumberModel } from '../../src/db/models/phone-number.model';
import {
  accountTrunkEndpoint,
  setTrunkLine,
} from '../../src/modules/sip-trunks/sip-trunks.service';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

import { FakeAri, waitFor } from './fake-ari';

/** An account's own SIP trunk from the admin screen: saved, connected, removed. */

useTestDb();
const saved = { provider: process.env.TELEPHONY_PROVIDER, ari: process.env.ARI_PASSWORD };
let app: ReturnType<typeof buildTestApp>;
let ari: FakeAri;
let client: AriClient;
let superadmin: TestUser;
let t: TestAccount;
const header = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
const path = () => `/api/v1/admin/accounts/${t.account._id.toString()}/sip-trunk`;
const BODY = {
  host: 'sip.carrier.in',
  port: 5060,
  transport: 'udp',
  auth: 'register',
  username: 'acme01',
  password: 'trunk-secret-55',
  trunkIps: [],
  callerId: '+911600000077',
  codecs: ['ulaw', 'alaw'],
};

beforeAll(async () => {
  process.env.TELEPHONY_PROVIDER = 'sip';
  process.env.ARI_PASSWORD = 'x'.repeat(24);
  resetEnvForTests();
  app = buildTestApp();
  ari = await new FakeAri().start();
  client = new AriClient({ url: ari.url, user: 'cav', password: 'x'.repeat(24), app: 'cav-api' });
  client.connect();
  await waitFor(() => client.connected);
  setTrunkLine(client);
  const platform = await createTestAccount({ isPlatform: true });
  superadmin = await platform.addUser('owner', { platformRole: 'superadmin' });
  t = await createTestAccount({ name: 'Trunk Co' });
});

afterAll(async () => {
  setTrunkLine(null);
  client.close();
  await ari.stop();
  for (const [k, v] of [
    ['TELEPHONY_PROVIDER', saved.provider],
    ['ARI_PASSWORD', saved.ari],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvForTests();
});

describe('account SIP trunk (admin)', () => {
  it('saves the carrier login, connects it, moves the account to the phone line', async () => {
    const bad = await request(app)
      .put(path())
      .set(header(superadmin))
      .send({ ...BODY, password: undefined });
    expect(bad.status).toBe(422);
    const res = await request(app).put(path()).set(header(superadmin)).send(BODY);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      configured: true,
      trunk: { host: 'sip.carrier.in', auth: 'register', username: 'acme01', passwordSet: true },
    });
    expect(JSON.stringify(res.body)).not.toContain('trunk-secret-55');
    const account = await AccountModel.findById(t.account._id).lean();
    expect(account?.voiceLine).toBe('sip');
    expect(JSON.stringify(account?.sipTrunk)).not.toContain('trunk-secret-55');
    const number = await PhoneNumberModel.findOne({ number: '+911600000077' }).lean();
    expect(number).toMatchObject({ purpose: 'both', status: 'active' });
    expect(number?.accountId?.toString()).toBe(t.account._id.toString());
    // pushed to Asterisk: the registration carries the login
    const reg = ari.calls.find((c) => c.method === 'PUT' && c.path.includes('/registration/'));
    expect(JSON.stringify(reg?.body)).toContain('sip:acme01@sip.carrier.in:5060');
    expect(await accountTrunkEndpoint(t.account._id)).toBe(`acc-${t.account._id.toString()}`);
    // an edit without a password keeps the saved one
    const edit = await request(app)
      .put(path())
      .set(header(superadmin))
      .send({ ...BODY, password: undefined, port: 5080 });
    expect(edit.body.data.trunk).toMatchObject({ port: 5080, passwordSet: true });
    const row = await AuditLogModel.findOne({ action: 'account.sip_trunk_changed' }).lean();
    expect(JSON.stringify(row)).not.toContain('trunk-secret-55');
  });

  it('removes the trunk (calls fall back to the server trunk)', async () => {
    const res = await request(app).delete(path()).set(header(superadmin));
    expect(res.body.data.configured).toBe(false);
    expect(await accountTrunkEndpoint(t.account._id)).toBeNull();
    expect(
      ari.calls.some(
        (c) =>
          c.method === 'DELETE' && c.path.endsWith(`/endpoint/acc-${t.account._id.toString()}`),
      ),
    ).toBe(true);
  });
});
