import type { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { ContactListModel } from '../../src/db/models/contact-list.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { CustomFieldModel } from '../../src/db/models/custom-field.model';
import { SegmentModel } from '../../src/db/models/segment.model';
import { isoDay } from '../../src/modules/contacts/filter/compile';
import { buildSearchText } from '../../src/modules/contacts/normalize';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const app = buildTestApp();
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
const URL = '/api/v1/contacts';

let t: TestAccount;
let viewer: TestUser;
let listA: Types.ObjectId;
const today = isoDay(new Date(), 'Asia/Kolkata');
const dayOffset = (n: number) => isoDay(new Date(), 'Asia/Kolkata', n);

const seed = async (
  accountId: Types.ObjectId,
  phone: string,
  extra: {
    name?: string;
    email?: string;
    tags?: string[];
    listIds?: Types.ObjectId[];
    variables?: Record<string, string | number>;
    dnd?: boolean;
    optedOutAt?: Date;
    createdAt?: Date;
    deletedAt?: Date;
  } = {},
) => {
  const doc = await ContactModel.create({
    accountId,
    phoneE164: phone,
    source: { type: 'manual' },
    searchText: buildSearchText({ name: extra.name, email: extra.email, phoneE164: phone }),
    ...extra,
  });
  if (extra.createdAt) {
    await ContactModel.collection.updateOne(
      { _id: doc._id },
      { $set: { createdAt: extra.createdAt } },
    );
  }
  return doc;
};

const names = (res: request.Response) =>
  (res.body.data as { name: string | null }[]).map((c) => c.name);

beforeAll(async () => {
  t = await createTestAccount();
  viewer = await t.addUser('viewer');
  const a = t.account._id;
  await CustomFieldModel.insertMany([
    { accountId: a, key: 'days_past_due', label: 'DPD', type: 'number', order: 1 },
    { accountId: a, key: 'due_date', label: 'Due', type: 'date', order: 2 },
    { accountId: a, key: 'loan_amount', label: 'Loan', type: 'currency', order: 3 },
  ]);
  listA = (
    await ContactListModel.create({ accountId: a, name: 'March', source: { type: 'manual' } })
  )._id;
  await seed(a, '+919876543210', {
    name: 'Asha Verma',
    email: 'asha@example.com',
    tags: ['vip', 'overdue'],
    listIds: [listA],
    variables: { days_past_due: 45, due_date: dayOffset(-45), loan_amount: 12_500_000_000 },
    createdAt: new Date('2026-09-01T00:00:00Z'),
  });
  await seed(a, '+919876500001', {
    name: 'bharat singh',
    tags: ['vip'],
    variables: { days_past_due: 10, due_date: dayOffset(3), loan_amount: 5_000_000_000 },
    dnd: true,
    createdAt: new Date('2026-10-01T00:00:00Z'),
  });
  await seed(a, '+919876500002', {
    name: 'आशा देवी',
    tags: ['overdue'],
    listIds: [listA],
    variables: { days_past_due: 0, due_date: today },
    optedOutAt: new Date(),
    createdAt: new Date('2026-10-05T00:00:00Z'),
  });
  await seed(a, '+919876500003', { name: 'Chetan', createdAt: new Date('2026-10-06T00:00:00Z') });
  await seed(a, '+919876500004', { name: 'Deleted Person', deletedAt: new Date() });
});

describe('GET /contacts', () => {
  it('lists live contacts newest first with offset meta', async () => {
    const res = await request(app).get(`${URL}?limit=2`).set(auth(viewer));
    expect(res.status).toBe(200);
    expect(names(res)).toEqual(['Chetan', 'आशा देवी']);
    expect(res.body.meta).toEqual({ page: 1, limit: 2, total: 4, totalPages: 2 });
    const page2 = await request(app).get(`${URL}?limit=2&page=2`).set(auth(viewer));
    expect(names(page2)).toEqual(['bharat singh', 'Asha Verma']);
  });

  it('sorts by name case-insensitively and by other allowlisted fields', async () => {
    const res = await request(app).get(`${URL}?sort=name`).set(auth(viewer));
    expect(names(res).slice(0, 3)).toEqual(['Asha Verma', 'bharat singh', 'Chetan']);
    expect(
      (await request(app).get(`${URL}?sort=-updatedAt,createdAt`).set(auth(viewer))).status,
    ).toBe(200);
    expect((await request(app).get(`${URL}?sort=phoneE164`).set(auth(viewer))).status).toBe(422);
  });

  it.each([
    ['q=asha', ['Asha Verma']],
    ['q=ASHA@example', ['Asha Verma']],
    ['q=98765 43210', ['Asha Verma']],
    ['q=%2B91-98765-00001', ['bharat singh']],
    ['q=0987650000', ['bharat singh', 'आशा देवी', 'Chetan'].reverse()],
    ['q=आशा', ['आशा देवी']],
    ['tag=vip', ['bharat singh', 'Asha Verma']],
    ['tag=vip,overdue', ['आशा देवी', 'bharat singh', 'Asha Verma']],
    ['tagsAll=vip,overdue', ['Asha Verma']],
    ['dnd=true', ['bharat singh']],
    ['dnd=false', ['Chetan', 'आशा देवी', 'Asha Verma']],
    ['optedOut=true', ['आशा देवी']],
    ['createdFrom=2026-10-01&createdTo=2026-10-06', ['आशा देवी', 'bharat singh']],
  ])('%s', async (qs, expected) => {
    const res = await request(app).get(`${URL}?${qs}`).set(auth(viewer));
    expect(res.status).toBe(200);
    expect(names(res)).toEqual(expected);
  });

  it('filters by list', async () => {
    const res = await request(app).get(`${URL}?listId=${listA.toString()}`).set(auth(viewer));
    expect(names(res)).toEqual(['आशा देवी', 'Asha Verma']);
  });

  it('rejects unknown params, tag + tagsAll together and bad values', async () => {
    for (const qs of [
      'color=red',
      'tag=a&tagsAll=b',
      'dnd=yes',
      'limit=101',
      'listId=x',
      'tag=bad%23',
    ]) {
      expect((await request(app).get(`${URL}?${qs}`).set(auth(viewer))).status, qs).toBe(422);
    }
  });

  it('applies a saved segment; a segment of another account is 404', async () => {
    const segment = await SegmentModel.create({
      accountId: t.account._id,
      name: 'Overdue > 30',
      filter: { conditions: [{ key: 'days_past_due', op: 'gt', value: 30 }] },
      createdBy: viewer.user._id,
    });
    const res = await request(app)
      .get(`${URL}?segmentId=${segment._id.toString()}`)
      .set(auth(viewer));
    expect(names(res)).toEqual(['Asha Verma']);
    const both = await request(app)
      .get(`${URL}?segmentId=${segment._id.toString()}&tag=overdue`)
      .set(auth(viewer));
    expect(names(both)).toEqual(['Asha Verma']);

    const broken = await SegmentModel.create({
      accountId: t.account._id,
      name: 'Deleted field',
      filter: { conditions: [{ key: 'gone', op: 'exists' }] },
      createdBy: viewer.user._id,
    });
    const none = await request(app)
      .get(`${URL}?segmentId=${broken._id.toString()}`)
      .set(auth(viewer));
    expect(none.body.meta.total).toBe(0);

    const other = await createTestAccount();
    const otherViewer = await other.addUser('viewer');
    const res404 = await request(app)
      .get(`${URL}?segmentId=${segment._id.toString()}`)
      .set(auth(otherViewer));
    expect(res404.status).toBe(404);
    expect((await request(app).get(URL).set(auth(otherViewer))).body.meta.total).toBe(0);
  });
});

describe('POST /contacts/search', () => {
  it.each([
    [
      { conditions: [{ key: 'days_past_due', op: 'between', value: 5, value2: 50 }] },
      ['bharat singh', 'Asha Verma'],
    ],
    [
      { conditions: [{ key: 'due_date', op: 'within_next_days', value: 7 }] },
      ['आशा देवी', 'bharat singh'],
    ],
    [{ conditions: [{ key: 'due_date', op: 'overdue_by_days', value: 30 }] }, ['Asha Verma']],
    [{ conditions: [{ key: 'loan_amount', op: 'gte', value: '₹10,000' }] }, ['Asha Verma']],
    [{ conditions: [{ key: 'loan_amount', op: 'not_exists' }] }, ['Chetan', 'आशा देवी']],
    [{ listIds: [] as string[] }, null],
  ])('%j', async (filter, expected) => {
    const res = await request(app).post(`${URL}/search`).set(auth(viewer)).send({ filter });
    if (expected === null) {
      expect(res.status).toBe(422);
      return;
    }
    expect(res.status).toBe(200);
    expect(names(res)).toEqual(expected);
  });

  it('defaults the body and reports problems with filter paths', async () => {
    const all = await request(app)
      .post(`${URL}/search`)
      .set(auth(viewer))
      .send({ limit: 1, sort: 'name' });
    expect(all.body.meta).toMatchObject({ total: 4, limit: 1, totalPages: 4 });
    expect(names(all)).toEqual(['Asha Verma']);
    const bad = await request(app)
      .post(`${URL}/search`)
      .set(auth(viewer))
      .send({ filter: { conditions: [{ key: 'days_past_due', op: 'contains', value: 'x' }] } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0].path).toBe('filter.conditions.0.op');
  });
});
