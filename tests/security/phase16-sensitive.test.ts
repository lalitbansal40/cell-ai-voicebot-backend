import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createTestAccount, type TestAccount } from '../helpers/auth';
import { recordingContactJobs, useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const storage = useTempStorage();
let app: ReturnType<typeof buildTestApp>;
let a: TestAccount;

beforeAll(async () => {
  app = buildTestApp({}, { storage, contactJobs: recordingContactJobs().jobs });
  a = await createTestAccount();
});

describe('a sensitive field on the contact page', () => {
  it('shows the value to the owner and the mask to a viewer', async () => {
    const owner = `Bearer ${(await a.addUser('owner')).token}`;
    const field = await request(app)
      .post('/api/v1/custom-fields')
      .set('Authorization', owner)
      .send({ key: 'loan_number', label: 'Loan number', type: 'text' });
    expect(field.status).toBe(201);
    const { id, key } = (field.body as { data: { id: string; key: string } }).data;
    const marked = await request(app)
      .patch(`/api/v1/custom-fields/${id}`)
      .set('Authorization', owner)
      .send({ sensitive: true });
    expect(marked.status).toBe(200);
    const created = await request(app)
      .post('/api/v1/contacts')
      .set('Authorization', owner)
      .send({ phone: '+919000160011', name: 'Sensitive', variables: { [key]: 'SECRET-1602' } });
    expect(created.status).toBe(201);
    const contactId = (created.body as { data: { id: string } }).data.id;
    const read = async (auth: string) =>
      (
        (await request(app).get(`/api/v1/contacts/${contactId}`).set('Authorization', auth))
          .body as { data: { variables: Record<string, unknown> } }
      ).data.variables[key];
    expect(await read(owner)).toBe('SECRET-1602');
    expect(await read(`Bearer ${(await a.addUser('viewer')).token}`)).toBe('••••');
  });
});
