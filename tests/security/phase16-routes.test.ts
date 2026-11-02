import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { AccountExportModel } from '../../src/db/models/account-export.model';
import { ApiKeyModel } from '../../src/db/models/api-key.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { EraseJobModel } from '../../src/db/models/erase-job.model';
import { generateApiKey, PREFIX_LENGTH } from '../../src/modules/api-keys/api-keys.service';
import { API_KEY_SCOPES } from '../../src/modules/api-keys/scopes';
import { sha256Hex } from '../../src/modules/auth/hmac';
import { SYSTEM_ROLES } from '../../src/modules/rbac/system-roles';
import { createTestAccount, TEST_PASSWORD, type TestAccount } from '../helpers/auth';
import { recordingContactJobs, useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const storage = useTempStorage();
let app: ReturnType<typeof buildTestApp>;
let a: TestAccount;
let b: TestAccount;
const ids = {} as Record<'contact' | 'eraseJob' | 'accountExport', string>;

type Method = 'get' | 'post';
const ROUTES: [Method, string, object?][] = [
  [
    'post',
    '/api/v1/contacts/bulk-erase',
    { ids: [new Types.ObjectId().toString()], confirm: 'ERASE' },
  ],
  ['get', `/api/v1/contacts/erase-jobs/${new Types.ObjectId().toString()}`],
  ['post', `/api/v1/contacts/${new Types.ObjectId().toString()}/erase`, { confirm: 'ERASE' }],
  ['post', '/api/v1/account/export', { password: TEST_PASSWORD }],
  ['get', '/api/v1/account/exports'],
  ['get', `/api/v1/account/exports/${new Types.ObjectId().toString()}`],
  ['post', '/api/v1/account/delete', { password: TEST_PASSWORD, confirmName: 'x' }],
  ['post', '/api/v1/account/delete/cancel', {}],
  ['get', '/api/v1/auth/mfa/status'],
  ['post', '/api/v1/auth/mfa/setup', {}],
  ['post', '/api/v1/auth/mfa/confirm', { code: '000000' }],
  ['post', '/api/v1/auth/mfa/verify', { code: '000000' }],
  ['post', '/api/v1/auth/mfa/disable', { code: '000000' }],
];

beforeAll(async () => {
  app = buildTestApp({}, { storage, contactJobs: recordingContactJobs().jobs });
  a = await createTestAccount();
  b = await createTestAccount();
  const accountId = a.account._id;
  const requestedBy = new Types.ObjectId();
  ids.contact = (
    await ContactModel.create({
      accountId,
      phoneE164: '+919876500161',
      name: 'Iso Contact',
      searchText: 'iso contact',
      source: { type: 'manual', importJobId: null },
    })
  )._id.toString();
  ids.eraseJob = (
    await EraseJobModel.create({ accountId, requestedBy, expiresAt: new Date(Date.now() + 60_000) })
  )._id.toString();
  ids.accountExport = (await AccountExportModel.create({ accountId, requestedBy }))._id.toString();
});

describe('Phase 16 routes (security)', () => {
  it("another account's owner gets 404 for this account's records and changes nothing", async () => {
    const { token } = await b.addUser('owner');
    const auth = `Bearer ${token}`;
    const erase = await request(app)
      .post(`/api/v1/contacts/${ids.contact}/erase`)
      .set('Authorization', auth)
      .send({ confirm: 'ERASE' });
    const job = await request(app)
      .get(`/api/v1/contacts/erase-jobs/${ids.eraseJob}`)
      .set('Authorization', auth);
    const file = await request(app)
      .get(`/api/v1/account/exports/${ids.accountExport}`)
      .set('Authorization', auth);
    expect([erase.status, job.status, file.status]).toEqual([404, 404, 404]);
    expect((await ContactModel.findById(ids.contact).lean())?.name).toBe('Iso Contact');
  });

  it('an API key with every scope is refused on all privacy and MFA routes', async () => {
    const key = generateApiKey(false);
    await ApiKeyModel.create({
      accountId: a.account._id,
      name: 'all scopes',
      prefix: key.slice(0, PREFIX_LENGTH),
      keyHash: sha256Hex(key),
      scopes: [...API_KEY_SCOPES],
      createdBy: new Types.ObjectId(),
    });
    const reached: string[] = [];
    for (const [method, path, body] of ROUTES) {
      const req = request(app)[method](path).set('X-API-Key', key);
      const res = await (method === 'post' ? req.send(body ?? {}) : req);
      if (![401, 403].includes(res.status))
        reached.push(`${method} ${path} → ${String(res.status)}`);
    }
    expect(reached).toEqual([]);
  });

  it('only the owner holds export and delete; erase stays with owner and admin', () => {
    const holders = (permission: string) =>
      Object.entries(SYSTEM_ROLES)
        .filter(([, role]) => (role.permissions as readonly string[]).includes(permission))
        .map(([key]) => key)
        .sort();
    expect({
      erase: holders('contacts.erase'),
      export: holders('account.export'),
      delete: holders('account.delete'),
    }).toMatchSnapshot();
  });

  it.each(['manager', 'agent', 'viewer'] as const)(
    '%s is refused on erase, export and delete',
    async (roleKey) => {
      const { token } = await a.addUser(roleKey);
      const auth = `Bearer ${token}`;
      const statuses = [
        await request(app)
          .post(`/api/v1/contacts/${ids.contact}/erase`)
          .set('Authorization', auth)
          .send({ confirm: 'ERASE' }),
        await request(app)
          .post('/api/v1/account/export')
          .set('Authorization', auth)
          .send({ password: TEST_PASSWORD }),
        await request(app)
          .post('/api/v1/account/delete')
          .set('Authorization', auth)
          .send({ password: TEST_PASSWORD, confirmName: 'x' }),
      ].map((res) => res.status);
      expect(statuses).toEqual([403, 403, 403]);
    },
  );
});
