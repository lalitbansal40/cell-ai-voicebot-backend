import type { Types } from 'mongoose';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { CustomFieldModel } from '../../src/db/models/custom-field.model';
import { deleteFieldValues } from '../../src/modules/custom-fields/custom-fields.jobs';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { recordingContactJobs } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const rec = recordingContactJobs();
const app = buildTestApp({}, { contactJobs: rec.jobs });
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
const URL = '/api/v1/custom-fields';

let t: TestAccount;
let owner: TestUser;
let manager: TestUser;
let agent: TestUser;
let viewer: TestUser;

beforeAll(async () => {
  t = await createTestAccount();
  owner = await t.addUser('owner');
  manager = await t.addUser('manager');
  agent = await t.addUser('agent');
  viewer = await t.addUser('viewer');
});

afterEach(() => vi.restoreAllMocks());

const create = (u: TestUser, body: object) => request(app).post(URL).set(auth(u)).send(body);
const addContact = (accountId: Types.ObjectId, phone: string, variables: Record<string, unknown>) =>
  ContactModel.create({ accountId, phoneE164: phone, source: { type: 'manual' }, variables });

describe('custom fields', () => {
  it('creates typed fields with parsed defaults, in order', async () => {
    const a = await create(manager, {
      key: 'loan_amount',
      label: 'Loan amount',
      type: 'currency',
      required: true,
      defaultValue: '₹1,000.50',
    });
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({
      key: 'loan_amount',
      type: 'currency',
      required: true,
      defaultValue: 1_000_500_000,
      order: 1,
    });
    const b = await create(owner, {
      key: 'due_date',
      label: 'Due date',
      type: 'date',
      defaultValue: '05/10/2026',
    });
    expect(b.body.data).toMatchObject({ defaultValue: '2026-10-05', order: 2, required: false });

    const list = await request(app).get(URL).set(auth(viewer));
    expect(list.status).toBe(200);
    expect(list.body.data.map((f: { key: string }) => f.key)).toEqual(['loan_amount', 'due_date']);
    expect(list.body.data[0]).not.toHaveProperty('usageCount');
    expect(
      await AuditLogModel.countDocuments({
        accountId: t.account._id,
        action: 'custom_field.created',
      }),
    ).toBe(2);
  });

  it('rejects bad / reserved keys, bad defaults and duplicates (with existing id)', async () => {
    for (const key of ['Loan', '1x', 'a-b', 'phone', 'external_id', 'x'.repeat(41)]) {
      const res = await create(owner, { key, label: 'x', type: 'text' });
      expect(res.status, key).toBe(422);
    }
    const bad = await create(owner, {
      key: 'emi',
      label: 'EMI',
      type: 'currency',
      defaultValue: 'ten',
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0].path).toBe('defaultValue');
    const dup = await create(owner, { key: 'loan_amount', label: 'x', type: 'text' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CONFLICT_DUPLICATE');
    expect(dup.body.error.details[0].existingId).toMatch(/^[a-f0-9]{24}$/);
    const extra = await create(owner, { key: 'x1', label: 'x', type: 'text', color: 'red' });
    expect(extra.status).toBe(422);
  });

  it('agents and viewers can read but not change fields', async () => {
    expect((await request(app).get(URL).set(auth(agent))).status).toBe(200);
    expect((await create(agent, { key: 'aa', label: 'x', type: 'text' })).status).toBe(403);
    expect((await create(viewer, { key: 'aa', label: 'x', type: 'text' })).status).toBe(403);
    expect((await request(app).get(URL)).status).toBe(401);
  });

  it('reports usage and changes the type only while unused', async () => {
    const field = await CustomFieldModel.findOne({ accountId: t.account._id, key: 'due_date' });
    const id = field?._id.toString() ?? '';
    const toText = await request(app)
      .patch(`${URL}/${id}`)
      .set(auth(owner))
      .send({ type: 'text', label: 'Due' });
    expect(toText.status).toBe(200);
    expect(toText.body.data).toMatchObject({ type: 'text', label: 'Due', defaultValue: null });

    await addContact(t.account._id, '+919000000101', { due_date: 'soon' });
    const withUsage = await request(app).get(`${URL}?withUsage=true`).set(auth(owner));
    expect(withUsage.body.data.find((f: { key: string }) => f.key === 'due_date').usageCount).toBe(
      1,
    );

    const blocked = await request(app)
      .patch(`${URL}/${id}`)
      .set(auth(owner))
      .send({ type: 'date' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain('1 contact');

    const same = await request(app)
      .patch(`${URL}/${id}`)
      .set(auth(owner))
      .send({ type: 'text', required: true, defaultValue: 'n/a' });
    expect(same.body.data).toMatchObject({ required: true, defaultValue: 'n/a' });
    expect((await request(app).patch(`${URL}/${id}`).set(auth(owner)).send({})).status).toBe(422);
    expect((await request(app).get(`${URL}?withUsage=maybe`).set(auth(owner))).status).toBe(422);
  });

  it('reorders with every id exactly once', async () => {
    const fields = await CustomFieldModel.find({ accountId: t.account._id })
      .sort({ order: 1 })
      .lean();
    const ids = fields.map((f) => f._id.toString()).reverse();
    const res = await request(app).put(`${URL}/order`).set(auth(owner)).send({ ids });
    expect(res.status).toBe(200);
    expect(res.body.data.map((f: { id: string }) => f.id)).toEqual(ids);
    const missing = await request(app)
      .put(`${URL}/order`)
      .set(auth(owner))
      .send({ ids: ids.slice(1) });
    expect(missing.status).toBe(422);
    const dupes = await request(app)
      .put(`${URL}/order`)
      .set(auth(owner))
      .send({ ids: [...ids.slice(1), ids[1]] });
    expect(dupes.status).toBe(422);
  });

  it('deletes a field and removes its values in the background', async () => {
    const field = await CustomFieldModel.findOne({ accountId: t.account._id, key: 'due_date' });
    rec.queued.length = 0;
    const res = await request(app).delete(`${URL}/${field?._id.toString()}`).set(auth(owner));
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ jobQueued: true });
    expect(rec.queued).toEqual([
      {
        name: 'field.delete_values',
        data: { accountId: t.account._id.toString(), key: 'due_date' },
      },
    ]);
    expect(
      await deleteFieldValues({ accountId: t.account._id.toString(), key: 'due_date' }),
    ).toEqual({ updated: 1 });
    const c = await ContactModel.findOne({
      accountId: t.account._id,
      phoneE164: '+919000000101',
    }).lean();
    expect(c?.variables).toEqual({});
    expect(
      await AuditLogModel.countDocuments({
        accountId: t.account._id,
        action: 'custom_field.deleted',
      }),
    ).toBe(1);
  });

  it('skips the value cleanup when the key was created again', async () => {
    await create(owner, { key: 'branch', label: 'Branch', type: 'text' });
    await addContact(t.account._id, '+919000000102', { branch: 'Pune' });
    expect(await deleteFieldValues({ accountId: t.account._id.toString(), key: 'branch' })).toEqual(
      {
        updated: 0,
        skipped: true,
      },
    );
  });

  it('enforces 50 fields per account', async () => {
    const x = await createTestAccount();
    const xo = await x.addUser('owner');
    await CustomFieldModel.insertMany(
      Array.from({ length: 50 }, (_, i) => ({
        accountId: x.account._id,
        key: `f${i}`,
        label: `F${i}`,
        type: 'text',
        order: i,
      })),
    );
    const res = await create(xo, { key: 'one_more', label: 'x', type: 'text' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT_INVALID_STATE');
  });

  it("never touches another account's fields (404) and is read-only when suspended", async () => {
    const other = await createTestAccount();
    const otherOwner = await other.addUser('owner');
    const mine = await CustomFieldModel.findOne({ accountId: t.account._id, key: 'loan_amount' });
    const id = mine?._id.toString() ?? '';
    expect(
      (await request(app).patch(`${URL}/${id}`).set(auth(otherOwner)).send({ label: 'x' })).status,
    ).toBe(404);
    expect((await request(app).delete(`${URL}/${id}`).set(auth(otherOwner))).status).toBe(404);
    expect((await request(app).delete(`${URL}/not-an-id`).set(auth(owner))).status).toBe(422);
    expect(
      (
        await request(app)
          .patch(`${URL}/${'a'.repeat(24)}`)
          .set(auth(owner))
          .send({ label: 'x' })
      ).status,
    ).toBe(404);
    expect((await request(app).get(URL).set(auth(otherOwner))).body.data).toEqual([]);

    const suspended = await createTestAccount({ status: 'suspended' });
    const so = await suspended.addUser('owner');
    expect((await request(app).get(URL).set(auth(so))).status).toBe(200);
    expect((await create(so, { key: 'k', label: 'x', type: 'text' })).status).toBe(403);
  });

  it('handles a create race (E11000), rethrows other errors, pluralises usage', async () => {
    vi.spyOn(CustomFieldModel, 'create').mockRejectedValueOnce(
      Object.assign(new Error('dup'), { code: 11000 }),
    );
    const race = await create(owner, { key: 'race_key', label: 'x', type: 'text' });
    expect(race.status).toBe(409);
    expect(race.body.error.code).toBe('CONFLICT_DUPLICATE');

    vi.spyOn(CustomFieldModel, 'create').mockRejectedValueOnce(new Error('db down'));
    expect((await create(owner, { key: 'boom_key', label: 'x', type: 'text' })).status).toBe(500);

    const f = await create(owner, { key: 'bucket', label: 'Bucket', type: 'text' });
    await addContact(t.account._id, '+919000000103', { bucket: 'B1' });
    await addContact(t.account._id, '+919000000104', { bucket: 'B2' });
    const blocked = await request(app)
      .patch(`${URL}/${f.body.data.id as string}`)
      .set(auth(owner))
      .send({ type: 'number' });
    expect(blocked.body.error.message).toContain('2 contacts');
  });

  it('cleanup with no values left does nothing', async () => {
    expect(
      await deleteFieldValues({ accountId: t.account._id.toString(), key: 'never_used' }),
    ).toEqual({ updated: 0 });
  });
});
