import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { ApiKeyModel } from '../../src/db/models/api-key.model';
import { CallModel } from '../../src/db/models/call.model';
import { ContactModel, type ContactDoc } from '../../src/db/models/contact.model';
import { CustomFieldModel } from '../../src/db/models/custom-field.model';
import { contactTemplateValues } from '../../src/modules/ai-agents/functions.service';
import { contactVariables } from '../../src/modules/ai-agents/variables';
import { generateApiKey, PREFIX_LENGTH } from '../../src/modules/api-keys/api-keys.service';
import { sha256Hex } from '../../src/modules/auth/hmac';
import { displayValues, storedValues, type UsedField } from '../../src/modules/campaigns/audience';
import { exportRow } from '../../src/modules/contact-exports/export.job';
import { loadContactContext } from '../../src/modules/contacts/context';
import { moveSensitiveValues } from '../../src/modules/custom-fields/custom-fields.jobs';
import { ruleValues } from '../../src/modules/post-call/evaluate';
import {
  encryptValue,
  maskTextValues,
  openTextValues,
  readContactVariables,
  sealContactVariables,
  sealTextValues,
  SENSITIVE_MASK,
  withoutSensitive,
} from '../../src/modules/privacy/sensitive';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { recordingContactJobs } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const recorded = recordingContactJobs();
let app: ReturnType<typeof buildTestApp>;
let a: TestAccount;
let owner: TestUser;
let viewer: TestUser;
const VALUE = 'LOAN-77-SECRET';
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

const rawContact = (id: string) => ContactModel.collection.findOne({ _id: new Types.ObjectId(id) });

const addContact = async (phone: string, loan = VALUE) => {
  const res = await request(app)
    .post('/api/v1/contacts')
    .set(auth(owner))
    .send({ phone, name: 'Sensitive Person', variables: { loan_ref: loan, branch: 'Pune' } });
  expect(res.status).toBe(201);
  return String(res.body.data.id);
};

const fieldId = async (key: string) =>
  String((await CustomFieldModel.findOne({ accountId: a.account._id, key }).lean())?._id);

const mark = async (key: string, sensitive: boolean) => {
  const res = await request(app)
    .patch(`/api/v1/custom-fields/${await fieldId(key)}`)
    .set(auth(owner))
    .send({ sensitive });
  expect(res.status).toBe(200);
  return res;
};

beforeAll(async () => {
  app = buildTestApp({}, { contactJobs: recorded.jobs });
  a = await createTestAccount();
  owner = await a.addUser('owner');
  viewer = await a.addUser('viewer');
  for (const key of ['loan_ref', 'branch']) {
    await request(app)
      .post('/api/v1/custom-fields')
      .set(auth(owner))
      .send({ key, label: key, type: 'text' })
      .expect(201);
  }
  await mark('loan_ref', true);
});

describe('sensitive helper', () => {
  it('keeps numbers as numbers, and a sealed value stays sealed', () => {
    const sealed = sealContactVariables({ amt: 5000, ok: 'x' }, new Set(['amt']));
    expect(sealed.ok).toBe('x');
    expect(JSON.stringify(sealed)).not.toContain('5000');
    expect(readContactVariables({ variables: sealed }, { purpose: 'call' }).amt).toBe(5000);
    const again = sealContactVariables(sealed, new Set(['amt']));
    expect(again.amt).toEqual(sealed.amt); // never sealed twice
  });

  it('handles a Map, an empty contact and each purpose', () => {
    const variables = new Map<string, unknown>([
      ['s', encryptValue('v')],
      ['p', 'plain'],
      ['skip', { other: 1 }],
    ]);
    expect(readContactVariables({ variables }, { purpose: 'list' })).toEqual({
      s: SENSITIVE_MASK,
      p: 'plain',
    });
    expect(readContactVariables({ variables }, { purpose: 'view' }).s).toBe(SENSITIVE_MASK);
    expect(readContactVariables({ variables }, { purpose: 'view', reveal: true }).s).toBe('v');
    for (const purpose of ['call', 'send', 'function', 'export'] as const) {
      expect(readContactVariables({ variables }, { purpose }).s).toBe('v');
    }
    expect(readContactVariables({}, { purpose: 'list' })).toEqual({});
  });

  it('sealed text round-trips, and is masked for answers', () => {
    const sealed = sealTextValues({ a: VALUE, b: 'plain', c: '' }, new Set(['a', 'c']));
    expect(JSON.stringify(sealed)).not.toContain(VALUE);
    expect(sealed.c).toBe('');
    expect(sealTextValues(sealed, new Set(['a'])).a).toBe(sealed.a); // not twice
    expect(openTextValues(sealed)).toEqual({ a: VALUE, b: 'plain', c: '' });
    expect(maskTextValues(sealed)).toEqual({ a: SENSITIVE_MASK, b: 'plain', c: '' });
  });
});

describe('contacts API', () => {
  it('stores the value sealed; search text and the database dump do not show it', async () => {
    const id = await addContact('+919800000001');
    const doc = await rawContact(id);
    expect(JSON.stringify(doc)).not.toContain(VALUE);
    expect((doc?.variables as Record<string, { $enc: string }>).loan_ref?.$enc).toMatch(/^v2:/);
    expect((doc?.variables as Record<string, string>).branch).toBe('Pune');
    expect(String(doc?.searchText)).not.toContain(VALUE.toLowerCase());
  });

  it('list shows the mask to everyone; the contact page follows contacts.export', async () => {
    const id = await addContact('+919800000002');
    const list = await request(app).get('/api/v1/contacts').set(auth(owner));
    expect(JSON.stringify(list.body)).not.toContain(VALUE);
    expect(list.body.data[0].variables.loan_ref).toBe(SENSITIVE_MASK);

    const own = await request(app).get(`/api/v1/contacts/${id}`).set(auth(owner));
    expect(own.body.data.variables.loan_ref).toBe(VALUE);
    const view = await request(app).get(`/api/v1/contacts/${id}`).set(auth(viewer));
    expect(view.status).toBe(200);
    expect(view.body.data.variables.loan_ref).toBe(SENSITIVE_MASK);
  });

  it('an API key never gets the value, even with every scope', async () => {
    const id = await addContact('+919800000003');
    const key = generateApiKey(false);
    await ApiKeyModel.create({
      accountId: a.account._id,
      name: 'sens',
      prefix: key.slice(0, PREFIX_LENGTH),
      keyHash: sha256Hex(key),
      scopes: ['contacts:read'],
      createdBy: new Types.ObjectId(),
    });
    const res = await request(app).get(`/api/v1/contacts/${id}`).set('X-API-Key', key);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(VALUE);
  });

  it('updating keeps the seal; sending the mask back changes nothing', async () => {
    const id = await addContact('+919800000004');
    const before = await rawContact(id);
    await request(app)
      .patch(`/api/v1/contacts/${id}`)
      .set(auth(owner))
      .send({ variables: { loan_ref: SENSITIVE_MASK, branch: 'Agra' } })
      .expect(200);
    const after = await rawContact(id);
    expect((after?.variables as Record<string, unknown>).loan_ref).toEqual(
      (before?.variables as Record<string, unknown>).loan_ref,
    );
    await request(app)
      .patch(`/api/v1/contacts/${id}`)
      .set(auth(owner))
      .send({ variables: { loan_ref: 'NEW-VALUE' } })
      .expect(200);
    const changed = await rawContact(id);
    expect(JSON.stringify(changed)).not.toContain('NEW-VALUE');
    const page = await request(app).get(`/api/v1/contacts/${id}`).set(auth(owner));
    expect(page.body.data.variables.loan_ref).toBe('NEW-VALUE');
  });

  it('search and segment filters on it answer 422 SENSITIVE_FIELD_NOT_ALLOWED', async () => {
    const filter = { conditions: [{ key: 'loan_ref', op: 'eq', value: VALUE }] };
    const res = await request(app)
      .post('/api/v1/segments/preview')
      .set(auth(owner))
      .send({ filter });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SENSITIVE_FIELD_NOT_ALLOWED');
  });

  it('a sensitive field refuses a default value, and the setting changes on its own', async () => {
    const id = await fieldId('loan_ref');
    const withDefault = await request(app)
      .patch(`/api/v1/custom-fields/${id}`)
      .set(auth(owner))
      .send({ defaultValue: 'x' });
    expect(withDefault.status).toBe(422);
    const mixed = await request(app)
      .patch(`/api/v1/custom-fields/${id}`)
      .set(auth(owner))
      .send({ sensitive: false, label: 'New' });
    expect(mixed.status).toBe(422);
    const same = await request(app)
      .patch(`/api/v1/custom-fields/${id}`)
      .set(auth(owner))
      .send({ sensitive: true });
    expect(same.status).toBe(200);
    const field = await CustomFieldModel.create({
      accountId: a.account._id,
      key: 'with_default',
      label: 'D',
      type: 'text',
      defaultValue: 'd',
    });
    const blocked = await request(app)
      .patch(`/api/v1/custom-fields/${field._id.toString()}`)
      .set(auth(owner))
      .send({ sensitive: true });
    expect(blocked.status).toBe(422);
    await field.deleteOne();
  });
});

describe('run-time readers get the real value', () => {
  it('calls and functions', async () => {
    const id = new Types.ObjectId(await addContact('+919800000010'));
    const { values, contact } = await contactVariables(a.account._id, id, ['loan_ref', 'name']);
    expect(values.loan_ref).toBe(VALUE);
    expect(contactTemplateValues(contact).loan_ref).toBe(VALUE);
    expect(
      contactTemplateValues({
        phoneE164: '+1',
        name: null,
        externalId: null,
        variables: { loan_ref: encryptValue(VALUE) } as never,
      }).loan_ref,
    ).toBe(VALUE);
  });

  it('copies stored on a call or a campaign row leave it out', async () => {
    expect(await withoutSensitive(a.account._id, { loan_ref: VALUE, branch: 'Pune' })).toEqual({
      branch: 'Pune',
    });
    const none = new Types.ObjectId();
    const same = { x: 'y' };
    expect(await withoutSensitive(none, same)).toBe(same);
    const used: UsedField[] = [
      { name: 'loan_ref', type: 'text' } as UsedField,
      { name: 'branch', type: 'text' } as UsedField,
    ];
    const row = {
      phoneE164: '+919800000011',
      variables: { loan_ref: encryptValue(VALUE), branch: 'Pune' },
    };
    expect(displayValues(row as never, used).loan_ref).toBe(SENSITIVE_MASK);
    expect(storedValues(row as never, used)).toEqual({ branch: 'Pune' });
  });

  it('exports open it, except a file started with an API key', async () => {
    const id = await addContact('+919800000012');
    const doc = await ContactModel.findById(id).lean<ContactDoc>();
    const ctx = await loadContactContext(a.account._id);
    const cols = ['loan_ref'];
    expect(exportRow(doc as ContactDoc, cols, ctx, new Map())).toEqual([VALUE]);
    expect(exportRow(doc as ContactDoc, cols, ctx, new Map(), true)).toEqual([SENSITIVE_MASK]);
  });

  it('a queued after-call message holds sealed text, not the value', async () => {
    const contactId = new Types.ObjectId(await addContact('+919800000013'));
    const [stored] = await ruleValues(
      [{ from: 'contact', key: 'loan_ref' }] as never,
      {
        accountId: a.account._id,
        contactId,
        variables: {},
        disposition: null,
        durationSec: 0,
      },
      null,
    );
    expect(stored).not.toContain(VALUE);
    expect(openTextValues({ v: stored ?? '' }).v).toBe(VALUE);
  });
});

describe('contacts.sensitive_field job', () => {
  it('seals existing values, opens them again, and is safe to rerun', async () => {
    const id = await addContact('+919800000020');
    await request(app)
      .post('/api/v1/custom-fields')
      .set(auth(owner))
      .send({ key: 'pan', label: 'PAN', type: 'text' })
      .expect(201);
    await ContactModel.collection.updateOne(
      { _id: new Types.ObjectId(id) },
      { $set: { 'variables.pan': 'ABCDE1234F' } },
    );
    const fid = await fieldId('pan');
    const res = await mark('pan', true);
    expect(res.body.data.sensitive).toBe(true);
    expect(res.body.data.sensitiveJob.status).toBe('running');
    expect(recorded.queued.at(-1)?.name).toBe('contacts.sensitive_field');
    const data = { accountId: a.account._id.toString(), fieldId: fid };

    expect((await moveSensitiveValues(data)).moved).toBe(1);
    expect(JSON.stringify(await rawContact(id))).not.toContain('ABCDE1234F');
    expect((await CustomFieldModel.findById(fid).lean())?.sensitiveJob).toEqual({
      status: 'done',
      done: 1,
      total: 1,
    });
    expect((await moveSensitiveValues(data)).moved).toBe(0); // rerun

    await mark('pan', false);
    expect((await moveSensitiveValues(data)).moved).toBe(1);
    expect(JSON.stringify(await rawContact(id))).toContain('ABCDE1234F');
    expect((await moveSensitiveValues(data)).moved).toBe(0);
  });

  it('skips a field that is gone and never touches another account', async () => {
    expect(
      await moveSensitiveValues({
        accountId: a.account._id.toString(),
        fieldId: new Types.ObjectId().toString(),
      }),
    ).toEqual({ moved: 0, skipped: true });
    const other = await createTestAccount();
    const field = await CustomFieldModel.create({
      accountId: other.account._id,
      key: 'loan_ref',
      label: 'L',
      type: 'text',
      sensitive: true,
    });
    const id = await addContact('+919800000021', 'OTHER-ACCOUNT-VALUE');
    await ContactModel.collection.updateOne(
      { _id: new Types.ObjectId(id) },
      { $set: { 'variables.branch': 'Delhi' } },
    );
    const before = await rawContact(id);
    await moveSensitiveValues({
      accountId: other.account._id.toString(),
      fieldId: field._id.toString(),
    });
    expect(await rawContact(id)).toEqual(before);
  });
});

describe('a stored call holds no sensitive value', () => {
  it('the model field stays out after withoutSensitive', async () => {
    const stored = await withoutSensitive(a.account._id, { loan_ref: VALUE });
    await CallModel.collection.insertOne({ accountId: a.account._id, variables: stored });
    const row = await CallModel.collection.findOne({ accountId: a.account._id });
    expect(JSON.stringify(row)).not.toContain(VALUE);
  });
});
