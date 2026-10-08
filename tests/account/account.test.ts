import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const app = buildTestApp();
let t: TestAccount;
let owner: TestUser;

beforeAll(async () => {
  t = await createTestAccount();
  owner = await t.addUser('owner');
});

const patch = (token: string, body: object) =>
  request(app).patch('/api/v1/account').set('Authorization', `Bearer ${token}`).send(body);

describe('GET /api/v1/account', () => {
  it('returns the caller account for every role', async () => {
    for (const role of ['owner', 'admin', 'manager', 'agent', 'viewer'] as const) {
      const { token } = await t.addUser(role);
      const res = await request(app).get('/api/v1/account').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: t.account._id.toString(),
        timezone: 'Asia/Kolkata',
        status: 'active',
      });
      expect(res.body.data.settings.callingWindow).toEqual({
        start: '09:00',
        end: '19:00',
        days: [1, 2, 3, 4, 5, 6],
      });
    }
    expect((await request(app).get('/api/v1/account')).status).toBe(401);
  });
});

describe('PATCH /api/v1/account', () => {
  it('updates top-level fields and merges nested settings', async () => {
    const res = await patch(owner.token, {
      name: 'Renamed Finance',
      timezone: 'Asia/Dubai',
      country: 'AE',
      defaultLanguage: 'en',
      settings: { recordingEnabled: false },
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: 'Renamed Finance',
      timezone: 'Asia/Dubai',
      country: 'AE',
      defaultLanguage: 'en',
    });
    expect(res.body.data.settings).toEqual({
      callingWindow: { start: '09:00', end: '19:00', days: [1, 2, 3, 4, 5, 6] },
      recordingEnabled: false,
      aiDisclosureEnabled: true,
    });
    const second = await patch(owner.token, {
      settings: { callingWindow: { start: '10:00', end: '18:30', days: [1, 2, 3] } },
    });
    expect(second.body.data.settings).toEqual({
      callingWindow: { start: '10:00', end: '18:30', days: [1, 2, 3] },
      recordingEnabled: false,
      aiDisclosureEnabled: true,
    });
    expect(second.body.data.name).toBe('Renamed Finance');
  });

  it('records an audit entry with the changed field names', async () => {
    await patch(owner.token, { defaultLanguage: 'hi' });
    const entry = await AuditLogModel.findOne({
      accountId: t.account._id,
      action: 'account.updated',
    })
      .sort({ at: -1 })
      .lean();
    expect(entry?.meta).toEqual({ fields: ['defaultLanguage'] });
    expect(entry?.actor.id?.toString()).toBe(owner.user._id.toString());
  });

  it.each([
    ['empty body', {}],
    ['unknown field', { slug: 'hack' }],
    ['status change', { status: 'active' }],
    ['owner change', { ownerId: '66f1c2a9e4b0c1d2e3f4a5b6' }],
    ['short name', { name: 'A' }],
    ['bad timezone', { timezone: 'Nowhere/Land' }],
    ['lowercase country', { country: 'in' }],
    ['bad language', { defaultLanguage: 'fr' }],
    ['bad time', { settings: { callingWindow: { start: '9:00', end: '19:00', days: [1] } } }],
    [
      'start after end',
      { settings: { callingWindow: { start: '19:00', end: '09:00', days: [1] } } },
    ],
    ['no days', { settings: { callingWindow: { start: '09:00', end: '19:00', days: [] } } }],
    [
      'duplicate days',
      { settings: { callingWindow: { start: '09:00', end: '19:00', days: [1, 1] } } },
    ],
    [
      'day out of range',
      { settings: { callingWindow: { start: '09:00', end: '19:00', days: [7] } } },
    ],
    ['unknown setting', { settings: { foo: true } }],
  ])('rejects %s with 422', async (_name, body) => {
    const res = await patch(owner.token, body);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('allows owner/admin only', async () => {
    const admin = await t.addUser('admin');
    expect((await patch(admin.token, { name: 'By Admin Co' })).status).toBe(200);
    for (const role of ['manager', 'agent', 'viewer'] as const) {
      const { token } = await t.addUser(role);
      const res = await patch(token, { name: 'Nope Co' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('AUTH_FORBIDDEN');
    }
  });

  it('is read-only for suspended accounts', async () => {
    const s = await createTestAccount({ status: 'suspended' });
    const o = await s.addUser('owner');
    expect(
      (await request(app).get('/api/v1/account').set('Authorization', `Bearer ${o.token}`)).status,
    ).toBe(200);
    expect((await patch(o.token, { name: 'Changed Co' })).body.error.code).toBe(
      'AUTH_ACCOUNT_SUSPENDED',
    );
  });

  it('only ever touches the caller account', async () => {
    const other = await createTestAccount({ name: 'Other Co' });
    await patch(owner.token, { name: 'Mine Only Co' });
    expect((await AccountModel.findById(other.account._id).lean())?.name).toBe('Other Co');
  });
});
