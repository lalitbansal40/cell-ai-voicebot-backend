import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
useCapturedEmail();
const storage = useTempStorage();

describe('/dev/jobs (DEV / E2E only)', () => {
  it('runs the retention purges and report e-mails now or "later"', async () => {
    const app = buildTestApp({ MOCK_APIS_ENABLED: 'true' }, { storage });
    const calls = await request(app).post('/api/v1/dev/jobs/calls-purge').send({ daysAhead: 30 });
    expect([calls.status, calls.body.data]).toEqual([200, { calls: 0, recordings: 0 }]);
    const inbox = await request(app).post('/api/v1/dev/jobs/inbox-retention').send({});
    expect(inbox.body.data).toMatchObject({ messages: 0 });
    const reports = await request(app)
      .post('/api/v1/dev/jobs/reports-email')
      .send({ hoursAhead: 2 });
    expect(reports.body.data).toMatchObject({ sent: 0 });
    expect((await request(app).post('/api/v1/dev/jobs/audit-purge').send({})).status).toBe(422);
    expect(
      (await request(app).post('/api/v1/dev/jobs/calls-purge').send({ daysAhead: 401 })).status,
    ).toBe(422);
  });

  it('is not mounted without MOCK_APIS_ENABLED', async () => {
    const app = buildTestApp({ MOCK_APIS_ENABLED: 'false' }, { storage });
    expect((await request(app).post('/api/v1/dev/jobs/calls-purge').send({})).status).toBe(404);
  });
});
