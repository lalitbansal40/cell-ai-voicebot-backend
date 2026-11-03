import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { PhoneNumberModel } from '../../src/db/models/phone-number.model';
import {
  accountFacts,
  defaultSettings,
  validateSettings,
} from '../../src/modules/campaigns/campaigns.service';
import { resolveCallerId } from '../../src/modules/phone-numbers/phone-numbers.service';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
let a: TestAccount;
let b: TestAccount;
let owner: TestUser;
let superadmin: TestUser;
const header = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
const app = buildTestApp();
const ADMIN = '/api/v1/admin/phone-numbers';

beforeAll(async () => {
  await PhoneNumberModel.createIndexes();
  a = await createTestAccount({ name: 'Acme' });
  b = await createTestAccount({ name: 'Beta' });
  owner = await a.addUser('owner');
  const platform = await createTestAccount({ isPlatform: true });
  superadmin = await platform.addUser('owner', { platformRole: 'superadmin' });
});

const add = (number: string, kind = '1600') =>
  request(app).post(ADMIN).set(header(superadmin)).send({ number, kind, label: 'Main' });

describe('phone numbers (T18.7)', () => {
  it('a superadmin adds numbers; duplicates and bad numbers are refused; 1600 hint', async () => {
    const res = await add('+911600123456');
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      number: '+911600123456',
      kind: '1600',
      accountId: null,
      status: 'active',
      purpose: 'outbound',
      warnings: [],
    });
    expect((await add('+911600123456')).body.error.code).toBe('PHONE_NUMBER_EXISTS');
    expect((await add('1600123456')).status).toBe(422);
    const odd = await add('+912240001234');
    expect(odd.body.data.warnings).toEqual(['not_1600_series']);
    const row = await AuditLogModel.findOne({ action: 'phone_number.created' }).lean();
    expect(row?.meta).toMatchObject({ kind: '1600', numberLast4: '3456' });
    expect(JSON.stringify(row)).not.toContain('+911600123456');
  });

  it('assigns, lists by account, moves, releases and disables, audited on both sides', async () => {
    const n = (await add('+911600200001')).body.data as { id: string };
    const assign = await request(app)
      .post(`${ADMIN}/${n.id}/assign`)
      .set(header(superadmin))
      .send({ accountId: a.account._id.toString() });
    expect(assign.status).toBe(200);
    expect(assign.body.data).toMatchObject({
      accountId: a.account._id.toString(),
      accountName: 'Acme',
    });
    const list = await request(app)
      .get(ADMIN)
      .query({ accountId: a.account._id.toString() })
      .set(header(superadmin));
    expect(list.body.data.map((x: { id: string }) => x.id)).toEqual([n.id]);
    const line = await request(app).get('/api/v1/phone-line').set(header(owner));
    expect(line.body.data).toMatchObject({
      line: 'dryrun',
      numbers: [{ number: '+911600200001' }],
    });
    const own = await request(app).get('/api/v1/phone-numbers').set(header(owner));
    expect(own.body.data.map((x: { number: string }) => x.number)).toEqual(['+911600200001']);
    expect(
      await AuditLogModel.countDocuments({
        action: 'phone_number.assigned',
        accountId: a.account._id,
      }),
    ).toBe(1);
    // moved to another account: released from the first, assigned to the second
    await request(app)
      .post(`${ADMIN}/${n.id}/assign`)
      .set(header(superadmin))
      .send({ accountId: b.account._id.toString() });
    expect(
      await AuditLogModel.countDocuments({
        action: 'phone_number.released',
        accountId: a.account._id,
      }),
    ).toBe(1);
    const off = await request(app)
      .patch(`${ADMIN}/${n.id}`)
      .set(header(superadmin))
      .send({ status: 'disabled' });
    expect(off.body.data.status).toBe('disabled');
    const refused = await request(app)
      .post(`${ADMIN}/${n.id}/assign`)
      .set(header(superadmin))
      .send({ accountId: a.account._id.toString() });
    expect(refused.status).toBe(409);
    const released = await request(app).post(`${ADMIN}/${n.id}/release`).set(header(superadmin));
    expect(released.body.data.accountId).toBeNull();
    expect(
      (await request(app).patch(`${ADMIN}/${n.id}`).set(header(superadmin)).send({})).status,
    ).toBe(422);
    const filtered = await request(app)
      .get(ADMIN)
      .query({ status: 'disabled' })
      .set(header(superadmin));
    expect(filtered.body.data.map((x: { id: string }) => x.id)).toContain(n.id);
  });

  it('refuses unknown numbers and accounts, and account users', async () => {
    const n = (await add('+911600200002')).body.data as { id: string };
    expect(
      (
        await request(app)
          .post(`${ADMIN}/${'0'.repeat(24)}/release`)
          .set(header(superadmin))
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post(`${ADMIN}/${n.id}/assign`)
          .set(header(superadmin))
          .send({ accountId: '0'.repeat(24) })
      ).status,
    ).toBe(404);
    expect((await request(app).get(ADMIN).set(header(owner))).status).toBe(403);
  });

  it('caller id: the chosen number, else the first active one, else the line default', async () => {
    const c = await createTestAccount({ name: 'Gamma' });
    expect(await resolveCallerId(c.account._id, null)).toBeNull();
    const first = await PhoneNumberModel.create({
      number: '+911600300001',
      kind: '1600',
      accountId: c.account._id,
    });
    const second = await PhoneNumberModel.create({
      number: '+911600300002',
      kind: '1600',
      accountId: c.account._id,
    });
    expect((await resolveCallerId(c.account._id, null))?.number).toBe('+911600300001');
    expect((await resolveCallerId(c.account._id, second._id))?.number).toBe('+911600300002');
    await PhoneNumberModel.updateOne({ _id: second._id }, { status: 'disabled' });
    await expect(resolveCallerId(c.account._id, second._id)).rejects.toMatchObject({
      code: 'CALLER_NUMBER_INVALID',
    });
    await expect(resolveCallerId(a.account._id, first._id)).rejects.toMatchObject({
      code: 'CALLER_NUMBER_INVALID',
    });
  });

  it("campaign settings: a caller number must be the account's; leave_message needs a text", async () => {
    const facts = await accountFacts(a.account._id);
    const base = defaultSettings(facts, {
      name: 'X',
      flowId: new Types.ObjectId(),
      mode: 'dry_run',
    });
    const theirs = await PhoneNumberModel.create({
      number: '+911600400001',
      kind: '1600',
      accountId: b.account._id,
    });
    const settings = {
      ...base,
      phoneLine: { callerNumberId: theirs._id, amd: 'leave_message' as const, voicemailText: null },
    };
    const err = await validateSettings(a.account._id, settings, facts, new Date()).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 'VALIDATION_FAILED' });
    const paths = (err as { details: { path: string }[] }).details.map((d) => d.path);
    expect(paths).toEqual(
      expect.arrayContaining(['phoneLine.voicemailText', 'phoneLine.callerNumberId']),
    );
  });
});
