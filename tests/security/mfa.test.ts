import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { UserModel } from '../../src/db/models/user.model';
import {
  base32Decode,
  base32Encode,
  hotp,
  matchTotp,
  otpauthUrl,
  stepOf,
} from '../../src/modules/auth/totp';
import { createTestAccount, TEST_PASSWORD, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const enforced = buildTestApp({ MFA_ENFORCED_FOR_ADMINS: 'true' });
const app = buildTestApp();
let superadmin: TestUser;
let owner: TestUser;
let customerId: string;
const header = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

const codeAt = (secret: string, at = new Date()) => hotp(base32Decode(secret), stepOf(at));

/** RFC 6238 appendix B, truncated to 8 digits, for each hash. */
const RFC_VECTORS: [number, string, string, string][] = [
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
];

describe('totp', () => {
  it('matches the RFC 6238 vectors', () => {
    const sha1 = Buffer.from('12345678901234567890');
    const sha256 = Buffer.from('12345678901234567890123456789012');
    const sha512 = Buffer.from('1234567890123456789012345678901234567890123456789012345678901234');
    for (const [t, a, b, c] of RFC_VECTORS) {
      const counter = Math.floor(t / 30);
      expect(hotp(sha1, counter, 8, 'sha1')).toBe(a);
      expect(hotp(sha256, counter, 8, 'sha256')).toBe(b);
      expect(hotp(sha512, counter, 8, 'sha512')).toBe(c);
    }
  });

  it('round-trips base32 and refuses other text', () => {
    const data = Buffer.from('hello world!');
    expect(base32Decode(base32Encode(data))).toEqual(data);
    expect(() => base32Decode('not base32!')).toThrow();
  });

  it('allows one step of drift, and never a used step', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const at = new Date('2026-11-02T00:00:00Z');
    const step = stepOf(at);
    const code = hotp(base32Decode(secret), step);
    expect(matchTotp(secret, code, at, null)).toBe(step);
    expect(matchTotp(secret, code, at, step)).toBeNull();
    expect(matchTotp(secret, hotp(base32Decode(secret), step - 1), at, null)).toBe(step - 1);
    expect(matchTotp(secret, hotp(base32Decode(secret), step - 5), at, null)).toBeNull();
    expect(matchTotp(secret, 'abc', at, null)).toBeNull();
    expect(otpauthUrl(secret, 'a@b.c', 'App')).toContain(`secret=${secret}`);
  });
});

describe('superadmin two-step sign-in', () => {
  const post = (path: string, body: object = {}, u = superadmin, target = app) =>
    request(target).post(`/api/v1/auth/mfa/${path}`).set(header(u)).send(body);
  const impersonate = (target: ReturnType<typeof buildTestApp>) =>
    request(target)
      .post(`/api/v1/admin/accounts/${customerId}/impersonate`)
      .set(header(superadmin));

  beforeAll(async () => {
    const platform = await createTestAccount({ isPlatform: true });
    superadmin = await platform.addUser('owner', { platformRole: 'superadmin' });
    const customer = await createTestAccount();
    owner = await customer.addUser('owner');
    customerId = customer.account._id.toString();
    await AccountModel.updateOne(
      { _id: customer.account._id },
      { $set: { ownerId: owner.user._id } },
    );
  });
  beforeEach(async () => {
    await UserModel.updateOne({ _id: superadmin.user._id }, { $set: { mfa: null } });
  });

  it('is only for a superadmin', async () => {
    expect((await post('setup', {}, owner)).status).toBe(403);
    expect((await request(app).post('/api/v1/auth/mfa/setup')).status).toBe(401);
  });

  it('sets up with a sealed secret, confirms, and shows hashed recovery codes once', async () => {
    const setup = await post('setup');
    expect(setup.status).toBe(200);
    const { secret, otpauthUrl: link } = setup.body.data as { secret: string; otpauthUrl: string };
    expect(link).toMatch(/^otpauth:\/\/totp\//);
    const stored = await UserModel.findById(superadmin.user._id).select('+mfa').lean();
    expect(JSON.stringify(stored?.mfa)).not.toContain(secret);
    expect(stored?.mfa?.secretSealed).toMatch(/^v2:/);
    expect(stored?.mfa?.enabledAt).toBeNull();

    expect((await post('confirm', { code: '000000' })).status).toBe(422);
    const ok = await post('confirm', { code: codeAt(secret) });
    expect(ok.status).toBe(200);
    const codes = ok.body.data.recoveryCodes as string[];
    expect(codes).toHaveLength(10);
    const after = await UserModel.findById(superadmin.user._id).select('+mfa').lean();
    expect(JSON.stringify(after?.mfa)).not.toContain(codes[0]);
    expect((await post('setup')).status).toBe(409);
    expect((await post('confirm', { code: '123456' })).status).toBe(409);
    expect(await AuditLogModel.countDocuments({ action: 'mfa.enabled' })).toBeGreaterThanOrEqual(1);
    const me = await request(app).get('/api/v1/auth/me').set(header(superadmin));
    expect(JSON.stringify(me.body)).not.toContain('secretSealed');
    expect(JSON.stringify(me.body)).not.toContain('recoveryHashes');
  });

  it('refuses a code used twice; a recovery code works once', async () => {
    const secret = (await post('setup')).body.data.secret as string;
    const confirmed = await post('confirm', { code: codeAt(secret) });
    const code = codeAt(secret);
    const replay = await post('verify', { code });
    expect(replay.status).toBe(422);
    expect(replay.body.error.code).toBe('MFA_INVALID');
    const recovery = (confirmed.body.data.recoveryCodes as string[])[0] as string;
    expect((await post('verify', { code: recovery })).status).toBe(200);
    expect((await post('verify', { code: recovery })).status).toBe(422);
    expect(
      await AuditLogModel.countDocuments({ action: 'mfa.recovery_used' }),
    ).toBeGreaterThanOrEqual(1);
    const next = hotp(base32Decode(secret), stepOf(new Date()) + 1);
    expect((await post('verify', { code: next })).status).toBe(200);
  });

  it('turning enforcement on cannot lock out a superadmin who has not set it up', async () => {
    const res = await impersonate(enforced);
    expect(res.status).toBe(200);
  });

  it('when enforced, a big action needs a fresh code; off, nothing changes', async () => {
    const secret = (await post('setup')).body.data.secret as string;
    await post('confirm', { code: codeAt(secret) });
    expect((await impersonate(enforced)).status).toBe(200); // fresh from confirm
    await UserModel.updateOne(
      { _id: superadmin.user._id },
      { $set: { 'mfa.verifiedAt': new Date(Date.now() - 16 * 60 * 1000) } },
    );
    const stale = await impersonate(enforced);
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe('MFA_REQUIRED');
    const body = {
      businessName: 'Blocked Biz',
      ownerName: 'A',
      ownerEmail: 'blocked-mfa@example.com',
      ownerPassword: 'blue-tiger-river-42',
    };
    const create = await request(enforced)
      .post('/api/v1/admin/accounts')
      .set(header(superadmin))
      .send(body);
    expect(create.body.error.code).toBe('MFA_REQUIRED');
    const run = await request(enforced)
      .post(`/api/v1/admin/accounts/${customerId}/deletion/run`)
      .set(header(superadmin));
    expect(run.body.error.code).toBe('MFA_REQUIRED');
    expect((await impersonate(app)).status).toBe(200); // the setting is off here
    const code = hotp(base32Decode(secret), stepOf(new Date()) + 1);
    await post('verify', { code });
    expect((await impersonate(enforced)).status).toBe(200);
  });

  it('turns off with the password and a code', async () => {
    const secret = (await post('setup')).body.data.secret as string;
    const confirmed = await post('confirm', { code: codeAt(secret) });
    const codes = confirmed.body.data.recoveryCodes as string[];
    expect(
      (await post('disable', { password: 'wrong-password-1', code: codes[0] })).body.error.code,
    ).toBe('REAUTH_FAILED');
    expect((await post('disable', { password: TEST_PASSWORD, code: '000000' })).status).toBe(422);
    expect((await post('disable', { password: TEST_PASSWORD, code: codes[0] })).status).toBe(200);
    expect((await UserModel.findById(superadmin.user._id).select('+mfa').lean())?.mfa).toBeNull();
    expect((await post('verify', { code: '123456' })).status).toBe(409);
    expect((await post('confirm', { code: '123456' })).status).toBe(409);
  });
});
