import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountModel } from '../../src/db/models/account.model';
import { ApiKeyModel } from '../../src/db/models/api-key.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { generateApiKey, PREFIX_LENGTH } from '../../src/modules/api-keys/api-keys.service';
import { sha256Hex } from '../../src/modules/auth/hmac';
import { clearApiLimitsCache } from '../../src/modules/public-api/key-limits';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
let a: TestAccount;
let superadmin: TestUser;
let owner: TestUser;
const header = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

const newKey = async (account: TestAccount) => {
  const key = generateApiKey(false);
  await ApiKeyModel.create({
    accountId: account.account._id,
    name: `k-${key.slice(-6)}`,
    prefix: key.slice(0, PREFIX_LENGTH),
    keyHash: sha256Hex(key),
    scopes: ['contacts:read'],
    createdBy: new Types.ObjectId(),
  });
  return key;
};

const limitSeen = async (app: ReturnType<typeof buildTestApp>, key: string) => {
  const res = await request(app).get('/api/v1/contacts').set('X-API-Key', key);
  return Number(res.headers['ratelimit-limit']);
};

beforeAll(async () => {
  a = await createTestAccount();
  owner = await a.addUser('owner');
  const platform = await createTestAccount({ isPlatform: true });
  superadmin = await platform.addUser('owner', { platformRole: 'superadmin' });
});
beforeEach(() => clearApiLimitsCache());

describe('per-account API key limits', () => {
  const url = () => `/api/v1/admin/accounts/${a.account._id.toString()}/api-limits`;
  const app = buildTestApp();

  it('default 600 / 60; raised value applies; other accounts stay at the default', async () => {
    const key = await newKey(a);
    expect(await limitSeen(app, key)).toBe(600);
    const res = await request(app)
      .patch(url())
      .set(header(superadmin))
      .send({ apiLimits: { readsPerMinute: 1000, writesPerMinute: 100 } });
    expect(res.status).toBe(200);
    clearApiLimitsCache();
    expect(await limitSeen(app, key)).toBe(1000);
    const other = await createTestAccount();
    expect(await limitSeen(app, await newKey(other))).toBe(600);
    expect(await AuditLogModel.countDocuments({ action: 'account.api_limits_changed' })).toBe(2);
    const reset = await request(app).patch(url()).set(header(superadmin)).send({ apiLimits: null });
    expect(reset.status).toBe(200);
    clearApiLimitsCache();
    expect(await limitSeen(app, key)).toBe(600);
  });

  it('a change is picked up within 30 seconds', async () => {
    const key = await newKey(a);
    expect(await limitSeen(app, key)).toBe(600);
    await AccountModel.updateOne(
      { _id: a.account._id },
      { $set: { apiLimits: { readsPerMinute: 900, writesPerMinute: 90 } } },
    );
    expect(await limitSeen(app, key)).toBe(600); // still cached
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    expect(await limitSeen(app, key)).toBe(900);
    spy.mockRestore();
    await AccountModel.updateOne({ _id: a.account._id }, { $set: { apiLimits: null } });
  });

  it('refuses above the ceiling, and anyone but a superadmin', async () => {
    const high = { apiLimits: { readsPerMinute: 6001, writesPerMinute: 10 } };
    expect((await request(app).patch(url()).set(header(superadmin)).send(high)).status).toBe(422);
    const write = { apiLimits: { readsPerMinute: 10, writesPerMinute: 601 } };
    expect((await request(app).patch(url()).set(header(superadmin)).send(write)).status).toBe(422);
    const ok = { apiLimits: { readsPerMinute: 6000, writesPerMinute: 600 } };
    expect((await request(app).patch(url()).set(header(owner)).send(ok)).status).toBe(403);
    await AccountModel.updateOne({ _id: a.account._id }, { $set: { apiLimits: null } });
  });
});
