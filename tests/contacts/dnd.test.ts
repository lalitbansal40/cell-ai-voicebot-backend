import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { DndEntryModel } from '../../src/db/models/dnd-entry.model';
import { addDndEntries } from '../../src/modules/dnd/dnd.service';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const app = buildTestApp();
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
const URL = '/api/v1/dnd-entries';

let t: TestAccount;
let owner: TestUser;
let admin: TestUser;
let manager: TestUser;
let agent: TestUser;

const contact = (phone: string, extra: Record<string, unknown> = {}) =>
  ContactModel.create({
    accountId: t.account._id,
    phoneE164: phone,
    source: { type: 'manual' },
    ...extra,
  });

beforeAll(async () => {
  t = await createTestAccount();
  owner = await t.addUser('owner');
  admin = await t.addUser('admin');
  manager = await t.addUser('manager');
  agent = await t.addUser('agent');
});

describe('do-not-call list', () => {
  it('adds a number (normalised), flags matching contacts, is idempotent and audited', async () => {
    const c = await contact('+919876543210');
    const res = await request(app)
      .post(URL)
      .set(auth(manager))
      .send({ phone: '098765 43210', reason: 'Asked' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      phoneE164: '+919876543210',
      reason: 'Asked',
      source: 'manual',
      addedBy: manager.user._id.toString(),
    });
    expect((await ContactModel.findById(c._id).lean())?.dnd).toBe(true);

    const again = await request(app).post(URL).set(auth(owner)).send({ phone: '+91 98765 43210' });
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(res.body.data.id);
    expect(
      await AuditLogModel.countDocuments({ accountId: t.account._id, action: 'dnd.added' }),
    ).toBe(1);

    expect((await request(app).post(URL).set(auth(owner)).send({ phone: '123' })).status).toBe(422);
  });

  it('a contact created later for a DND number is flagged', async () => {
    const res = await request(app)
      .post('/api/v1/contacts')
      .set(auth(owner))
      .send({ phone: '+91 98765 43210' });
    expect(res.status).toBe(409); // already exists (created above)
    await DndEntryModel.create({
      accountId: t.account._id,
      phoneE164: '+919876500001',
      source: 'manual',
    });
    const created = await request(app)
      .post('/api/v1/contacts')
      .set(auth(owner))
      .send({ phone: '9876500001' });
    expect(created.body.data.dnd).toBe(true);
  });

  it('lists and searches by phone digits', async () => {
    const all = await request(app).get(URL).set(auth(agent));
    expect(all.status).toBe(200);
    expect(all.body.meta.total).toBe(2);
    const found = await request(app).get(`${URL}?q=98765 43210`).set(auth(agent));
    expect(found.body.data.map((d: { phoneE164: string }) => d.phoneE164)).toEqual([
      '+919876543210',
    ]);
    expect((await request(app).get(`${URL}?q=abc`).set(auth(agent))).status).toBe(422);
  });

  it('only dnd.manage (owner / admin) can remove; removal clears the flag, not opt-outs', async () => {
    const entry = await DndEntryModel.findOne({
      accountId: t.account._id,
      phoneE164: '+919876543210',
    }).lean();
    const id = entry?._id.toString() ?? '';
    expect((await request(app).delete(`${URL}/${id}`).set(auth(manager))).status).toBe(403);
    expect((await request(app).delete(`${URL}/${id}`).set(auth(admin))).status).toBe(204);
    const c = await ContactModel.findOne({
      accountId: t.account._id,
      phoneE164: '+919876543210',
    }).lean();
    expect(c?.dnd).toBe(false);
    expect((await request(app).delete(`${URL}/${id}`).set(auth(owner))).status).toBe(404);
    const audit = await AuditLogModel.findOne({
      accountId: t.account._id,
      action: 'dnd.removed',
    }).lean();
    expect(audit?.meta).toEqual({ optOutCleared: false });

    const opted = await contact('+919876500002', { optedOutAt: new Date(), dnd: true });
    await DndEntryModel.create({
      accountId: t.account._id,
      phoneE164: '+919876500002',
      source: 'manual',
    });
    const e2 = await DndEntryModel.findOne({
      accountId: t.account._id,
      phoneE164: '+919876500002',
    }).lean();
    await request(app).delete(`${URL}/${e2?._id.toString()}`).set(auth(owner));
    expect((await ContactModel.findById(opted._id).lean())?.optedOutAt).toBeTruthy();
  });

  it('bulk helper upserts once and also flags soft-deleted contacts', async () => {
    const gone = await contact('+919876500003', { deletedAt: new Date() });
    const created = await addDndEntries(
      t.account._id,
      [{ phoneE164: '+919876500003' }, { phoneE164: '+919876500004', reason: 'list' }],
      'upload',
      null,
    );
    expect(created).toBe(2);
    expect(
      await addDndEntries(t.account._id, [{ phoneE164: '+919876500003' }], 'upload', null),
    ).toBe(0);
    expect(await addDndEntries(t.account._id, [], 'upload', null)).toBe(0);
    expect(
      (await ContactModel.findById(gone._id).setOptions({ withDeleted: true }).lean())?.dnd,
    ).toBe(true);
  });
});

describe('opt-out', () => {
  it('opting out sets optedOutAt and a DND entry; repeat is a no-op', async () => {
    const c = await contact('+919876500010');
    const res = await request(app)
      .post(`/api/v1/contacts/${c._id.toString()}/opt-out`)
      .set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.data.dnd).toBe(true);
    expect(res.body.data.optedOutAt).toBeTruthy();
    const entry = await DndEntryModel.findOne({
      accountId: t.account._id,
      phoneE164: '+919876500010',
    }).lean();
    expect(entry).toMatchObject({ reason: 'Opted out', source: 'manual' });
    const again = await request(app)
      .post(`/api/v1/contacts/${c._id.toString()}/opt-out`)
      .set(auth(manager));
    expect(again.body.data.optedOutAt).toBe(res.body.data.optedOutAt);
    expect(
      await AuditLogModel.countDocuments({ accountId: t.account._id, action: 'contact.opted_out' }),
    ).toBe(1);
  });

  it('undo needs dnd.manage and clears both', async () => {
    const c = await ContactModel.findOne({
      accountId: t.account._id,
      phoneE164: '+919876500010',
    }).lean();
    const url = `/api/v1/contacts/${c?._id.toString()}/opt-out`;
    expect((await request(app).delete(url).set(auth(manager))).status).toBe(403);
    const res = await request(app).delete(url).set(auth(owner));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ optedOutAt: null, dnd: false });
    expect(
      await DndEntryModel.exists({ accountId: t.account._id, phoneE164: '+919876500010' }),
    ).toBeNull();
    const audit = await AuditLogModel.findOne({
      accountId: t.account._id,
      action: 'dnd.removed',
      'meta.optOutCleared': true,
    }).lean();
    expect(audit?.target).toMatchObject({ type: 'contact' });
  });

  it('agents cannot opt out; other accounts get 404', async () => {
    const c = await contact('+919876500011');
    const url = `/api/v1/contacts/${c._id.toString()}/opt-out`;
    expect((await request(app).post(url).set(auth(agent))).status).toBe(403);
    const other = await createTestAccount();
    const otherOwner = await other.addUser('owner');
    expect((await request(app).post(url).set(auth(otherOwner))).status).toBe(404);
    expect((await request(app).delete(url).set(auth(otherOwner))).status).toBe(404);
    const theirEntry = await DndEntryModel.findOne({ accountId: t.account._id }).lean();
    expect(
      (await request(app).delete(`${URL}/${theirEntry?._id.toString()}`).set(auth(otherOwner)))
        .status,
    ).toBe(404);
    expect((await request(app).get(URL).set(auth(otherOwner))).body.meta.total).toBe(0);
  });

  it('suspended accounts cannot change the list', async () => {
    const s = await createTestAccount({ status: 'suspended' });
    const so = await s.addUser('owner');
    expect((await request(app).post(URL).set(auth(so)).send({ phone: '9876500099' })).status).toBe(
      403,
    );
    expect((await request(app).get(URL).set(auth(so))).status).toBe(200);
  });
});
