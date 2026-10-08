import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { ContactListModel } from '../../src/db/models/contact-list.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { CustomFieldModel } from '../../src/db/models/custom-field.model';
import { SegmentModel } from '../../src/db/models/segment.model';
import { deleteListMembers } from '../../src/modules/contact-lists/contact-lists.jobs';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { recordingContactJobs } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const rec = recordingContactJobs();
const app = buildTestApp({}, { contactJobs: rec.jobs });
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
const LISTS = '/api/v1/contact-lists';
const SEGMENTS = '/api/v1/segments';

let t: TestAccount;
let owner: TestUser;
let manager: TestUser;
let agent: TestUser;

const addContact = (phone: string, extra: Record<string, unknown> = {}) =>
  ContactModel.create({
    accountId: t.account._id,
    phoneE164: phone,
    source: { type: 'manual' },
    ...extra,
  });

beforeAll(async () => {
  t = await createTestAccount();
  owner = await t.addUser('owner');
  manager = await t.addUser('manager');
  agent = await t.addUser('agent');
  await CustomFieldModel.create({
    accountId: t.account._id,
    key: 'days_past_due',
    label: 'DPD',
    type: 'number',
    order: 1,
  });
});
afterEach(() => vi.restoreAllMocks());

describe('contact lists', () => {
  it('creates, counts live members, renames and searches', async () => {
    const res = await request(app)
      .post(LISTS)
      .set(auth(manager))
      .send({ name: 'March', description: 'Batch 1' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'March',
      description: 'Batch 1',
      source: { type: 'manual', fileName: null },
      contactCount: 0,
    });
    const id = res.body.data.id as string;
    const other = (await request(app).post(LISTS).set(auth(owner)).send({ name: 'April' })).body
      .data.id as string;
    await addContact('+919000000001', { listIds: [id] });
    await addContact('+919000000002', { listIds: [id, other] });
    await addContact('+919000000003', { listIds: [id], deletedAt: new Date() });

    const list = await request(app).get(LISTS).set(auth(agent));
    expect(list.body.meta).toMatchObject({ total: 2 });
    const counts = Object.fromEntries(
      (list.body.data as { name: string; contactCount: number }[]).map((l) => [
        l.name,
        l.contactCount,
      ]),
    );
    expect(counts).toEqual({ March: 2, April: 1 });
    expect((await request(app).get(`${LISTS}?q=mar`).set(auth(agent))).body.data).toHaveLength(1);
    expect((await request(app).get(`${LISTS}/${id}`).set(auth(agent))).body.data.contactCount).toBe(
      2,
    );

    const renamed = await request(app)
      .patch(`${LISTS}/${id}`)
      .set(auth(owner))
      .send({ name: 'March 2026', description: null });
    expect(renamed.body.data).toMatchObject({
      name: 'March 2026',
      description: null,
      contactCount: 2,
    });
  });

  it('names are unique case-insensitively (409 with existing id)', async () => {
    const april = await ContactListModel.findOne({
      accountId: t.account._id,
      name: 'April',
    }).lean();
    const dup = await request(app).post(LISTS).set(auth(owner)).send({ name: 'APRIL' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details[0].existingId).toBe(april?._id.toString());
    const march = await ContactListModel.findOne({
      accountId: t.account._id,
      name: 'March 2026',
    }).lean();
    const rename = await request(app)
      .patch(`${LISTS}/${march?._id.toString()}`)
      .set(auth(owner))
      .send({ name: 'april' });
    expect(rename.status).toBe(409);
    expect(
      (await request(app).patch(`${LISTS}/${march?._id.toString()}`).set(auth(owner)).send({}))
        .status,
    ).toBe(422);
  });

  it('maps E11000 races to 409 and rethrows other errors', async () => {
    vi.spyOn(ContactListModel, 'create').mockRejectedValueOnce(
      Object.assign(new Error('d'), { code: 11000 }),
    );
    expect((await request(app).post(LISTS).set(auth(owner)).send({ name: 'Race' })).status).toBe(
      409,
    );
    vi.spyOn(ContactListModel, 'create').mockRejectedValueOnce(new Error('down'));
    expect((await request(app).post(LISTS).set(auth(owner)).send({ name: 'Boom' })).status).toBe(
      500,
    );
    const march = await ContactListModel.findOne({
      accountId: t.account._id,
      name: 'March 2026',
    }).lean();
    vi.spyOn(ContactListModel, 'findOneAndUpdate').mockReturnValueOnce({
      lean: () => Promise.reject(Object.assign(new Error('d'), { code: 11000 })),
    } as never);
    expect(
      (
        await request(app)
          .patch(`${LISTS}/${march?._id.toString()}`)
          .set(auth(owner))
          .send({ name: 'Z' })
      ).status,
    ).toBe(409);
    vi.spyOn(ContactListModel, 'findOneAndUpdate').mockReturnValueOnce({
      lean: () => Promise.reject(new Error('down')),
    } as never);
    expect(
      (
        await request(app)
          .patch(`${LISTS}/${march?._id.toString()}`)
          .set(auth(owner))
          .send({ name: 'Z' })
      ).status,
    ).toBe(500);
  });

  it('deleting a list keeps the contacts and removes membership in the background', async () => {
    const april = await ContactListModel.findOne({
      accountId: t.account._id,
      name: 'April',
    }).lean();
    const id = april?._id.toString() ?? '';
    rec.queued.length = 0;
    const res = await request(app).delete(`${LISTS}/${id}`).set(auth(manager));
    expect(res.status).toBe(202);
    expect(rec.queued).toEqual([
      { name: 'list.delete_members', data: { accountId: t.account._id.toString(), listId: id } },
    ]);
    expect(await deleteListMembers({ accountId: t.account._id.toString(), listId: id })).toEqual({
      updated: 1,
    });
    expect(await deleteListMembers({ accountId: t.account._id.toString(), listId: id })).toEqual({
      updated: 0,
    });
    expect(await ContactModel.countDocuments({ accountId: t.account._id })).toBe(2);
    expect((await request(app).get(`${LISTS}/${id}`).set(auth(owner))).status).toBe(404);
    // the name is free again
    expect((await request(app).post(LISTS).set(auth(owner)).send({ name: 'April' })).status).toBe(
      201,
    );
    expect(
      await AuditLogModel.countDocuments({
        accountId: t.account._id,
        action: 'contact_list.deleted',
      }),
    ).toBe(1);
  });

  it('enforces 500 lists, permissions and isolation', async () => {
    const x = await createTestAccount();
    const xo = await x.addUser('owner');
    await ContactListModel.insertMany(
      Array.from({ length: 500 }, (_, i) => ({
        accountId: x.account._id,
        name: `L${i}`,
        source: { type: 'manual' },
      })),
    );
    const full = await request(app).post(LISTS).set(auth(xo)).send({ name: 'one more' });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('CONFLICT_INVALID_STATE');

    expect((await request(app).post(LISTS).set(auth(agent)).send({ name: 'x' })).status).toBe(403);
    const mine = await ContactListModel.findOne({ accountId: t.account._id }).lean();
    const id = mine?._id.toString() ?? '';
    expect((await request(app).get(`${LISTS}/${id}`).set(auth(xo))).status).toBe(404);
    expect(
      (await request(app).patch(`${LISTS}/${id}`).set(auth(xo)).send({ name: 'x' })).status,
    ).toBe(404);
    expect((await request(app).delete(`${LISTS}/${id}`).set(auth(xo))).status).toBe(404);
    expect((await request(app).get(`${LISTS}?unknown=1`).set(auth(owner))).status).toBe(422);
  });
});

describe('segments', () => {
  const overdue = { conditions: [{ key: 'days_past_due', op: 'gt', value: 30 }] };

  it('previews, creates with counts, lists and gets', async () => {
    await addContact('+919000000010', { variables: { days_past_due: 45 } });
    await addContact('+919000000011', { variables: { days_past_due: 5 } });
    const preview = await request(app)
      .post(`${SEGMENTS}/preview`)
      .set(auth(agent))
      .send({ filter: overdue });
    expect(preview.status).toBe(200);
    expect(preview.body.data.count).toBe(1);
    expect(preview.body.data.sample[0].phoneE164).toBe('+919000000010');

    const res = await request(app)
      .post(SEGMENTS)
      .set(auth(manager))
      .send({ name: 'Overdue', filter: overdue });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'Overdue',
      filter: overdue,
      invalidConditions: [],
      contactCount: 1,
    });
    const id = res.body.data.id as string;

    const list = await request(app).get(`${SEGMENTS}?withCounts=true`).set(auth(agent));
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].contactCount).toBe(1);
    expect((await request(app).get(SEGMENTS).set(auth(agent))).body.data[0]).not.toHaveProperty(
      'contactCount',
    );
    expect(
      (await request(app).get(`${SEGMENTS}/${id}`).set(auth(agent))).body.data.contactCount,
    ).toBe(1);
  });

  it('validates filters, unique names, updates and deletes (audited)', async () => {
    const bad = await request(app)
      .post(SEGMENTS)
      .set(auth(owner))
      .send({ name: 'Bad', filter: { conditions: [{ key: 'nope', op: 'eq', value: 1 }] } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0].path).toBe('filter.conditions.0.key');
    const dup = await request(app)
      .post(SEGMENTS)
      .set(auth(owner))
      .send({ name: 'overdue', filter: {} });
    expect(dup.status).toBe(409);

    const seg = await SegmentModel.findOne({ accountId: t.account._id, name: 'Overdue' }).lean();
    const id = seg?._id.toString() ?? '';
    const updated = await request(app)
      .patch(`${SEGMENTS}/${id}`)
      .set(auth(owner))
      .send({
        name: 'Overdue 4+',
        filter: { conditions: [{ key: 'days_past_due', op: 'gte', value: 4 }] },
      });
    expect(updated.body.data).toMatchObject({ name: 'Overdue 4+', contactCount: 2 });
    await request(app).post(SEGMENTS).set(auth(owner)).send({ name: 'Other', filter: {} });
    expect(
      (await request(app).patch(`${SEGMENTS}/${id}`).set(auth(owner)).send({ name: 'other' }))
        .status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .patch(`${SEGMENTS}/${id}`)
          .set(auth(owner))
          .send({ filter: { conditions: [{ key: 'x', op: 'eq', value: 1 }] } })
      ).status,
    ).toBe(422);
    expect((await request(app).patch(`${SEGMENTS}/${id}`).set(auth(owner)).send({})).status).toBe(
      422,
    );

    expect((await request(app).delete(`${SEGMENTS}/${id}`).set(auth(manager))).status).toBe(204);
    expect((await request(app).get(`${SEGMENTS}/${id}`).set(auth(owner))).status).toBe(404);
    expect(
      await AuditLogModel.countDocuments({ accountId: t.account._id, action: 'segment.deleted' }),
    ).toBe(1);
  });

  it('reports conditions broken by a deleted field and matches nothing', async () => {
    await CustomFieldModel.create({
      accountId: t.account._id,
      key: 'bucket',
      label: 'B',
      type: 'text',
      order: 2,
    });
    const res = await request(app)
      .post(SEGMENTS)
      .set(auth(owner))
      .send({
        name: 'Bucket',
        filter: {
          conditions: [
            { key: 'bucket', op: 'exists' },
            { key: 'bucket', op: 'eq', value: 'B1' },
          ],
        },
      });
    expect(res.status).toBe(201);
    await CustomFieldModel.deleteOne({ accountId: t.account._id, key: 'bucket' });
    const got = await request(app)
      .get(`${SEGMENTS}/${res.body.data.id as string}`)
      .set(auth(owner));
    expect(got.body.data).toMatchObject({ invalidConditions: [0, 1], contactCount: 0 });
  });

  it('maps E11000 races, enforces 100 segments, permissions and isolation', async () => {
    vi.spyOn(SegmentModel, 'create').mockRejectedValueOnce(
      Object.assign(new Error('d'), { code: 11000 }),
    );
    expect(
      (await request(app).post(SEGMENTS).set(auth(owner)).send({ name: 'Race', filter: {} }))
        .status,
    ).toBe(409);
    const seg = await SegmentModel.findOne({ accountId: t.account._id, name: 'Other' }).lean();
    const id = seg?._id.toString() ?? '';
    vi.spyOn(SegmentModel, 'findOneAndUpdate').mockReturnValueOnce({
      lean: () => Promise.reject(Object.assign(new Error('d'), { code: 11000 })),
    } as never);
    expect(
      (await request(app).patch(`${SEGMENTS}/${id}`).set(auth(owner)).send({ name: 'Q' })).status,
    ).toBe(409);
    vi.spyOn(SegmentModel, 'findOneAndUpdate').mockReturnValueOnce({
      lean: () => Promise.reject(new Error('down')),
    } as never);
    expect(
      (await request(app).patch(`${SEGMENTS}/${id}`).set(auth(owner)).send({ name: 'Q' })).status,
    ).toBe(500);

    const x = await createTestAccount();
    const xo = await x.addUser('owner');
    await SegmentModel.insertMany(
      Array.from({ length: 100 }, (_, i) => ({
        accountId: x.account._id,
        name: `S${i}`,
        filter: {},
        createdBy: xo.user._id,
      })),
    );
    expect(
      (await request(app).post(SEGMENTS).set(auth(xo)).send({ name: 'more', filter: {} })).status,
    ).toBe(409);

    expect(
      (await request(app).post(SEGMENTS).set(auth(agent)).send({ name: 'x', filter: {} })).status,
    ).toBe(403);
    expect((await request(app).get(`${SEGMENTS}/${id}`).set(auth(xo))).status).toBe(404);
    expect(
      (await request(app).patch(`${SEGMENTS}/${id}`).set(auth(xo)).send({ name: 'x' })).status,
    ).toBe(404);
    expect((await request(app).delete(`${SEGMENTS}/${id}`).set(auth(xo))).status).toBe(404);
    const preview = await request(app)
      .post(`${SEGMENTS}/preview`)
      .set(auth(xo))
      .send({ filter: {} });
    expect(preview.body.data.count).toBe(0);
  });
});
