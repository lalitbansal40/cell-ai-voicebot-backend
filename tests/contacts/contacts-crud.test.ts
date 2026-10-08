import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { ContactListModel } from '../../src/db/models/contact-list.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { CustomFieldModel } from '../../src/db/models/custom-field.model';
import { DndEntryModel } from '../../src/db/models/dnd-entry.model';
import { createTestAccount, tokenFor, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const app = buildTestApp();
const auth = (u: TestUser | { token: string }) => ({ Authorization: `Bearer ${u.token}` });
const URL = '/api/v1/contacts';

let t: TestAccount;
let owner: TestUser;
let manager: TestUser;
let agent: TestUser;
let viewer: TestUser;
let listA: string;

beforeAll(async () => {
  t = await createTestAccount();
  owner = await t.addUser('owner');
  manager = await t.addUser('manager');
  agent = await t.addUser('agent');
  viewer = await t.addUser('viewer');
  await CustomFieldModel.insertMany([
    {
      accountId: t.account._id,
      key: 'loan_amount',
      label: 'Loan',
      type: 'currency',
      required: true,
      order: 1,
    },
    { accountId: t.account._id, key: 'due_date', label: 'Due', type: 'date', order: 2 },
    {
      accountId: t.account._id,
      key: 'branch',
      label: 'Branch',
      type: 'text',
      defaultValue: 'Pune',
      order: 3,
    },
    { accountId: t.account._id, key: 'days_past_due', label: 'DPD', type: 'number', order: 4 },
  ]);
  listA = (
    await ContactListModel.create({
      accountId: t.account._id,
      name: 'March',
      source: { type: 'manual' },
    })
  )._id.toString();
});
afterEach(() => vi.restoreAllMocks());

const create = (u: TestUser, body: object) => request(app).post(URL).set(auth(u)).send(body);

describe('POST /contacts', () => {
  it('normalises everything and applies defaults', async () => {
    const res = await create(manager, {
      phone: '098765 43210',
      name: ' Asha Verma ',
      email: 'Asha@Example.com',
      externalId: 'LN-1',
      variables: { loan_amount: '₹12,500.50', due_date: '05/10/2026', days_past_due: '45' },
      tags: ['VIP', 'vip', 'Overdue'],
      listIds: [listA],
      consent: { source: 'Loan agreement', at: '2026-10-01T00:00:00Z' },
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      phoneE164: '+919876543210',
      name: 'Asha Verma',
      email: 'asha@example.com',
      externalId: 'LN-1',
      variables: {
        loan_amount: 12_500_500_000,
        due_date: '2026-10-05',
        days_past_due: 45,
        branch: 'Pune',
      },
      tags: ['vip', 'overdue'],
      listIds: [listA],
      dnd: false,
      optedOutAt: null,
      consent: { source: 'Loan agreement', at: '2026-10-01T00:00:00.000Z' },
      source: { type: 'manual', importJobId: null },
      callCount: 0,
    });
    expect(res.body.data).not.toHaveProperty('searchText');
    const stored = await ContactModel.findById(res.body.data.id).lean();
    expect(stored?.searchText).toBe('asha verma asha@example.com 919876543210 ln-1');
  });

  it('answers 409 with the existing id for a live duplicate phone or external id', async () => {
    const existing = await ContactModel.findOne({
      accountId: t.account._id,
      phoneE164: '+919876543210',
    });
    const byPhone = await create(owner, {
      phone: '+91 98765-43210',
      variables: { loan_amount: 1 },
    });
    expect(byPhone.status).toBe(409);
    expect(byPhone.body.error.details[0]).toMatchObject({
      path: 'phone',
      existingId: existing?._id.toString(),
    });
    const byExt = await create(owner, {
      phone: '9876500001',
      externalId: 'LN-1',
      variables: { loan_amount: 1 },
    });
    expect(byExt.status).toBe(409);
    expect(byExt.body.error.details[0].path).toBe('externalId');
  });

  it('collects every validation error with paths', async () => {
    const res = await create(owner, {
      phone: '9.87654E+09',
      email: 'nope',
      tags: ['bad#'],
      variables: {
        loan_amount: 'lots',
        due_date: '31/02/2026',
        mystery: 1,
      },
    });
    expect(res.status).toBe(422);
    const paths = (res.body.error.details as { path: string; message: string }[]).map(
      (d) => d.path,
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        'phone',
        'email',
        'tags',
        'variables.loan_amount',
        'variables.due_date',
        'variables.mystery',
      ]),
    );
    expect(res.body.error.details[0].message).toContain('lost digits');
    const missing = await create(owner, { phone: '9876500002' });
    expect(missing.body.error.details).toEqual([
      { path: 'variables.loan_amount', message: 'Required' },
    ]);
    const badList = await create(owner, {
      phone: '9876500003',
      variables: { loan_amount: 1 },
      listIds: ['a'.repeat(24)],
    });
    expect(badList.status).toBe(422);
    expect(badList.body.error.details[0].path).toBe('listIds');
    const future = await create(owner, {
      phone: '9876500004',
      variables: { loan_amount: 1 },
      consent: { source: 'x', at: '2999-01-01T00:00:00Z' },
    });
    expect(future.status).toBe(422);
  });

  it('marks numbers on the DND list and revives a deleted phone', async () => {
    await DndEntryModel.create({
      accountId: t.account._id,
      phoneE164: '+919876500010',
      source: 'manual',
    });
    const onDnd = await create(owner, { phone: '9876500010', variables: { loan_amount: 1 } });
    expect(onDnd.body.data.dnd).toBe(true);

    const first = await create(owner, {
      phone: '9876500011',
      name: 'Old',
      tags: ['old'],
      listIds: [listA],
      variables: { loan_amount: 5 },
    });
    await request(app)
      .delete(`${URL}/${first.body.data.id as string}`)
      .set(auth(owner));
    const again = await create(owner, {
      phone: '9876500011',
      name: 'New',
      variables: { loan_amount: 7 },
    });
    expect(again.status).toBe(201);
    expect(again.body.data).toMatchObject({
      id: first.body.data.id,
      name: 'New',
      tags: [],
      listIds: [],
      variables: { loan_amount: 7_000_000, branch: 'Pune' },
    });
  });

  it('maps a lost duplicate race (E11000) to 409', async () => {
    vi.spyOn(ContactModel, 'create').mockRejectedValueOnce(
      Object.assign(new Error('dup'), { code: 11000 }),
    );
    const res = await create(owner, { phone: '9876500099', variables: { loan_amount: 1 } });
    expect(res.status).toBe(409);
    vi.spyOn(ContactModel, 'create').mockRejectedValueOnce(new Error('down'));
    expect(
      (await create(owner, { phone: '9876500098', variables: { loan_amount: 1 } })).status,
    ).toBe(500);
  });
});

describe('GET / PATCH / DELETE /contacts/:id', () => {
  it('returns the contact with list names', async () => {
    const c = await ContactModel.findOne({ accountId: t.account._id, phoneE164: '+919876543210' });
    const res = await request(app).get(`${URL}/${c?._id.toString()}`).set(auth(viewer));
    expect(res.status).toBe(200);
    expect(res.body.data.lists).toEqual([{ id: listA, name: 'March' }]);
  });

  it('merges variables, null clears, required cannot be cleared, lists / tags replace', async () => {
    const c = await create(owner, {
      phone: '9876500020',
      variables: { loan_amount: 100, due_date: '2026-10-05', days_past_due: 3 },
      tags: ['a'],
      listIds: [listA],
    });
    const id = c.body.data.id as string;
    const res = await request(app)
      .patch(`${URL}/${id}`)
      .set(auth(manager))
      .send({
        variables: { days_past_due: 4, due_date: null },
        tags: ['B'],
        listIds: [],
        name: '  ',
      });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      variables: { loan_amount: 100_000_000, days_past_due: 4, branch: 'Pune' },
      tags: ['b'],
      listIds: [],
      name: null,
      lists: [],
    });
    const blank = await request(app)
      .patch(`${URL}/${id}`)
      .set(auth(owner))
      .send({ variables: { days_past_due: ' ' } });
    expect(blank.body.data.variables).not.toHaveProperty('days_past_due');
    const cleared = await request(app)
      .patch(`${URL}/${id}`)
      .set(auth(owner))
      .send({ variables: { loan_amount: null } });
    expect(cleared.status).toBe(422);
    expect(cleared.body.error.details).toEqual([
      { path: 'variables.loan_amount', message: 'Required' },
    ]);
    expect((await request(app).patch(`${URL}/${id}`).set(auth(owner)).send({})).status).toBe(422);
    expect(
      (await request(app).patch(`${URL}/${id}`).set(auth(owner)).send({ consent: null })).body.data
        .consent,
    ).toBeNull();
  });

  it('changing the phone re-checks duplicates and DND and rebuilds search', async () => {
    const c = await create(owner, { phone: '9876500030', variables: { loan_amount: 1 } });
    const id = c.body.data.id as string;
    const dup = await request(app)
      .patch(`${URL}/${id}`)
      .set(auth(owner))
      .send({ phone: '9876543210' });
    expect(dup.status).toBe(409);
    const dupExt = await request(app)
      .patch(`${URL}/${id}`)
      .set(auth(owner))
      .send({ externalId: 'LN-1' });
    expect(dupExt.status).toBe(409);
    await DndEntryModel.create({
      accountId: t.account._id,
      phoneE164: '+919876500031',
      source: 'manual',
    });
    const moved = await request(app)
      .patch(`${URL}/${id}`)
      .set(auth(owner))
      .send({ phone: '9876500031', email: 'new@example.com', externalId: 'LN-9' });
    expect(moved.body.data).toMatchObject({ phoneE164: '+919876500031', dnd: true });
    const stored = await ContactModel.findById(id).lean();
    expect(stored?.searchText).toBe('new@example.com 919876500031 ln-9');
    const same = await request(app)
      .patch(`${URL}/${id}`)
      .set(auth(owner))
      .send({ phone: '+919876500031' });
    expect(same.status).toBe(200);
    const badPhone = await request(app)
      .patch(`${URL}/${id}`)
      .set(auth(owner))
      .send({ phone: 'abc' });
    expect(badPhone.body.error.details[0]).toMatchObject({ path: 'phone' });
    vi.spyOn(ContactModel, 'findOneAndUpdate').mockReturnValueOnce({
      lean: () => Promise.reject(Object.assign(new Error('d'), { code: 11000 })),
    } as never);
    expect(
      (await request(app).patch(`${URL}/${id}`).set(auth(owner)).send({ name: 'x' })).status,
    ).toBe(409);
  });

  it('soft-deletes (audited) and then 404s', async () => {
    const c = await create(owner, { phone: '9876500040', variables: { loan_amount: 1 } });
    const id = c.body.data.id as string;
    expect((await request(app).delete(`${URL}/${id}`).set(auth(manager))).status).toBe(204);
    expect((await request(app).get(`${URL}/${id}`).set(auth(owner))).status).toBe(404);
    expect((await request(app).delete(`${URL}/${id}`).set(auth(owner))).status).toBe(404);
    expect(
      (await ContactModel.findById(id).setOptions({ withDeleted: true }).lean())?.deletedAt,
    ).toBeTruthy();
    const audit = await AuditLogModel.findOne({
      accountId: t.account._id,
      action: 'contacts.deleted',
    }).lean();
    expect(audit?.meta).toEqual({ count: 1, mode: 'single' });
    expect(audit?.target).toMatchObject({ type: 'contact', id });
  });
});

describe('permissions, isolation, suspension, impersonation', () => {
  it('agents / viewers read only; anonymous 401', async () => {
    expect((await request(app).get(URL).set(auth(agent))).status).toBe(200);
    expect((await create(agent, { phone: '9876500050' })).status).toBe(403);
    expect((await create(viewer, { phone: '9876500050' })).status).toBe(403);
    const c = await ContactModel.findOne({ accountId: t.account._id }).lean();
    const id = c?._id.toString() ?? '';
    expect(
      (await request(app).patch(`${URL}/${id}`).set(auth(viewer)).send({ name: 'x' })).status,
    ).toBe(403);
    expect((await request(app).delete(`${URL}/${id}`).set(auth(agent))).status).toBe(403);
    expect((await request(app).get(URL)).status).toBe(401);
  });

  it("never reads or changes another account's contacts (404)", async () => {
    const other = await createTestAccount();
    const otherOwner = await other.addUser('owner');
    const mine = await ContactModel.findOne({ accountId: t.account._id }).lean();
    const id = mine?._id.toString() ?? '';
    expect((await request(app).get(`${URL}/${id}`).set(auth(otherOwner))).status).toBe(404);
    expect(
      (await request(app).patch(`${URL}/${id}`).set(auth(otherOwner)).send({ name: 'x' })).status,
    ).toBe(404);
    expect((await request(app).delete(`${URL}/${id}`).set(auth(otherOwner))).status).toBe(404);
    expect((await request(app).get(URL).set(auth(otherOwner))).body.meta.total).toBe(0);
    // Their list is unknown to us — and our phone is free in their account.
    const theirList = await ContactListModel.create({
      accountId: other.account._id,
      name: 'Theirs',
      source: { type: 'manual' },
    });
    const res = await create(owner, {
      phone: '9876500060',
      variables: { loan_amount: 1 },
      listIds: [theirList._id.toString()],
    });
    expect(res.status).toBe(422);
    expect((await create(otherOwner, { phone: '9876543210' })).status).toBe(201);
    expect((await request(app).get(`${URL}/not-an-id`).set(auth(owner))).status).toBe(422);
  });

  it('suspended accounts are read-only; impersonation can write', async () => {
    const s = await createTestAccount({ status: 'suspended' });
    const so = await s.addUser('owner');
    expect((await request(app).get(URL).set(auth(so))).status).toBe(200);
    expect((await create(so, { phone: '9876500070' })).status).toBe(403);
    const imp = { token: await tokenFor(owner.user, { imp: 'a'.repeat(24) }) };
    const res = await request(app)
      .post(URL)
      .set(auth(imp))
      .send({ phone: '9876500071', variables: { loan_amount: 1 } });
    expect(res.status).toBe(201);
  });
});

describe('GET /contact-tags', () => {
  it('counts tags of live contacts', async () => {
    const res = await request(app).get('/api/v1/contact-tags').set(auth(agent));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(
      expect.arrayContaining([
        { tag: 'vip', count: 1 },
        { tag: 'overdue', count: 1 },
      ]),
    );
    expect(res.body.data.find((r: { tag: string }) => r.tag === 'old')).toBeUndefined();
  });
});
