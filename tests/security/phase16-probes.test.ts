import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { AccountModel } from '../../src/db/models/account.model';
import { UserModel } from '../../src/db/models/user.model';
import { createTestAccount, TEST_PASSWORD, type TestAccount } from '../helpers/auth';
import { recordingContactJobs, useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const storage = useTempStorage();
let app: ReturnType<typeof buildTestApp>;
// production's setting (private hosts are allowed only in development)
let strictApp: ReturnType<typeof buildTestApp>;
let a: TestAccount;
let auth: string;

beforeAll(async () => {
  app = buildTestApp({}, { storage, contactJobs: recordingContactJobs().jobs });
  strictApp = buildTestApp(
    { AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS: 'false' },
    { storage, contactJobs: recordingContactJobs().jobs },
  );
  a = await createTestAccount();
  auth = `Bearer ${(await a.addUser('owner')).token}`;
});

describe('pen-test probes (local)', () => {
  it('NoSQL operators in a login are refused, not run', async () => {
    for (const body of [
      { email: { $ne: '' }, password: { $ne: '' } },
      { email: { $gt: '' }, password: TEST_PASSWORD },
    ]) {
      const res = await request(app).post('/api/v1/auth/login').send(body);
      expect(res.status).toBe(422);
    }
  });

  it('NoSQL operators in a list query are refused or treated as text', async () => {
    const res = await request(app)
      .get('/api/v1/contacts')
      .query({ 'search[$ne]': 'x', 'status[$gt]': '' })
      .set('Authorization', auth);
    expect(res.status).toBeLessThan(500);
    if (res.status === 200) expect((res.body as { data: unknown[] }).data).toEqual([]);
  });

  it('mass assignment: account limits and a role cannot be set through normal updates', async () => {
    const before = await AccountModel.findById(a.account._id).lean();
    const account = await request(app)
      .patch('/api/v1/account')
      .set('Authorization', auth)
      .send({ name: 'Changed', limits: { maxConcurrentCalls: 9999 }, status: 'active' });
    expect(account.status).toBe(422);
    const after = await AccountModel.findById(a.account._id).lean();
    expect(after?.limits).toEqual(before?.limits);
    expect(after?.name).toBe(before?.name);

    const { user } = await a.addUser('agent');
    const self = await request(app)
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${(await a.addUser('agent')).token}`)
      .send({ roleId: a.roles.owner.toString(), accountId: a.account._id.toString() });
    expect(self.status).toBeGreaterThanOrEqual(400);
    expect((await UserModel.findById(user._id).lean())?.roleId.toString()).toBe(
      a.roles.agent.toString(),
    );
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'https://127.0.0.1/hook',
    'https://10.0.0.5/hook',
    'http://hooks.example.com/plain-http',
  ])('SSRF: a webhook endpoint at %s is refused', async (url) => {
    const res = await request(strictApp)
      .post('/api/v1/webhook-endpoints')
      .set('Authorization', auth)
      .send({ url, events: ['call.completed'] });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('a line break in a value never reaches a response header', async () => {
    const res = await request(app)
      .get('/api/v1/contacts')
      .query({ search: 'x\r\nSet-Cookie: stolen=1' })
      .set('Authorization', auth);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});
