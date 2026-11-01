import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import mongoose, { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getEnv } from '../../src/config/env';
import { AccountExportModel } from '../../src/db/models/account-export.model';
import { ApiKeyModel } from '../../src/db/models/api-key.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { CallModel } from '../../src/db/models/call.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { DndEntryModel } from '../../src/db/models/dnd-entry.model';
import { EraseJobModel } from '../../src/db/models/erase-job.model';
import { ExportJobModel } from '../../src/db/models/export-job.model';
import { ImportJobModel } from '../../src/db/models/import-job.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { SuppressionModel } from '../../src/db/models/suppression.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { generateApiKey, PREFIX_LENGTH } from '../../src/modules/api-keys/api-keys.service';
import { sha256Hex } from '../../src/modules/auth/hmac';
import { analyseBatch } from '../../src/modules/contact-imports/analyse';
import { isPhoneOnDnd } from '../../src/modules/contacts/contacts.service';
import { processPostCallSend } from '../../src/modules/post-call/send.job';
import { ERASE_MAP } from '../../src/modules/privacy/erase-map';
import { runEraseJob } from '../../src/modules/privacy/erase.job';
import {
  assertSuppressionReady,
  isBlockedForOutreach,
  recordSuppression,
  suppressedPhones,
} from '../../src/modules/privacy/suppression';
import { seal, secretKeys } from '../../src/shared/crypto/secret-box';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { recordingContactJobs, useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const storage = useTempStorage();
const recorded = recordingContactJobs();
let app: ReturnType<typeof buildTestApp>;
let a: TestAccount;
let b: TestAccount;
let owner: TestUser;
let ownerB: TestUser;

const NAME = 'Zorawar Quixley';
const TEXT = 'MARKERTEXT77 my loan';
const header = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

const db = () => mongoose.connection.db as NonNullable<typeof mongoose.connection.db>;

/** The same person seeded into every store that can hold them, for one account. */
const seed = async (accountId: Types.ObjectId, phone: string, tag: string) => {
  const digits = phone.replace(/^\+/, '');
  const contactId = new Types.ObjectId();
  const callId = new Types.ObjectId();
  const conversationId = new Types.ObjectId();
  const sessionId = new Types.ObjectId();
  const keep = (name: string) => `${tag}/${name}`;
  const put = (name: string, body: string) =>
    storage.put(keep(name), Buffer.from(body), { contentType: 'text/plain' });
  await put('recording.wav', `voice ${TEXT}`);
  await put('media.jpg', `photo ${TEXT}`);
  await put('import.csv', `phone,name\n${phone},${NAME}\n`);
  await put('other-import.csv', 'phone,name\n+919000000000,Someone Else\n');
  await put('export.csv', `${phone},${NAME}\n`);
  await put('archive.zip', 'PK compressed');
  const docs: [string, Record<string, unknown>][] = [
    [
      'contacts',
      {
        _id: contactId,
        accountId,
        phoneE164: phone,
        name: NAME,
        email: 'zorawar@example.com',
        searchText: `${NAME.toLowerCase()} ${digits}`,
        variables: { note: TEXT },
        whatsapp: { waId: digits },
        dnd: false,
        optedOutAt: null,
        deletedAt: null,
      },
    ],
    [
      'conversations',
      { _id: conversationId, accountId, contactId, phoneE164: phone, waId: digits, name: NAME },
    ],
    [
      'messages',
      {
        accountId,
        conversationId,
        contactId,
        text: TEXT,
        media: { storageKey: keep('media.jpg') },
      },
    ],
    ['inboxUploads', { accountId, storageKey: keep('media.jpg'), fileName: 'photo.jpg' }],
    ['conversationSummaries', { accountId, conversationId, summary: TEXT }],
    [
      'calls',
      {
        _id: callId,
        accountId,
        contactId,
        to: phone,
        from: '+911100000000',
        status: 'completed',
        durationSec: 42,
        cost: { totalMicros: 5 },
        variables: { name: NAME },
        manualVariables: { note: TEXT },
        outcome: { summary: TEXT },
        recording: { fileKey: keep('recording.wav'), deletedAt: null },
      },
    ],
    ['callEvents', { accountId, callId, seq: 1, type: 'x', data: { text: TEXT } }],
    ['transcriptTurns', { accountId, callId, seq: 1, text: TEXT }],
    ['callInsights', { accountId, callId, output: { summary: TEXT } }],
    [
      'flowRuns',
      { accountId, contactId, callId, transcript: [TEXT], state: { contact: { name: NAME } } },
    ],
    [
      'agentPlaygroundSessions',
      { _id: sessionId, accountId, contactId, testPhone: phone, turns: [TEXT] },
    ],
    ['agentToolCalls', { accountId, sessionId, resultPreview: TEXT }],
    [
      'postCallMessages',
      { accountId, callId, contactId, variables: { a: TEXT }, status: 'scheduled' },
    ],
    [
      'webhookEvents',
      {
        _id: `evt_${tag}` as never,
        accountId,
        type: 'call.completed',
        data: { callId: callId.toString(), phone, name: NAME, summary: TEXT },
      },
    ],
    [
      'webhookDeliveries',
      { accountId, eventId: `evt_${tag}`, endpointId: new Types.ObjectId(), responseSnippet: TEXT },
    ],
    ['whatsappCallPermissions', { accountId, contactId, history: [TEXT] }],
    ['dndEntries', { accountId, phoneE164: phone, reason: 'x' }],
    [
      'campaignContacts',
      {
        accountId,
        campaignId: new Types.ObjectId(),
        contactId,
        phoneE164: phone,
        name: NAME,
        variables: { a: TEXT },
        status: 'pending',
      },
    ],
    ['idempotencyKeys', { accountId, key: `k-${tag}`, responseBody: { phone, name: NAME } }],
    [
      'notifications',
      {
        accountId,
        userId: new Types.ObjectId(),
        title: `Call with ${NAME}`,
        body: 'x',
        link: `/contacts/${contactId.toString()}`,
      },
    ],
    [
      'ledgerEntries',
      {
        accountId,
        amountMicros: -5,
        balanceAfterMicros: 95,
        idempotencyKey: `ledger-${tag}`,
        note: `Refund for ${NAME}`,
        ref: { type: 'call', id: callId.toString() },
      },
    ],
    [
      'importJobs',
      { accountId, fileKey: keep('import.csv'), errorReportKey: keep('other-import.csv') },
    ],
    ['exportJobs', { accountId, fileKey: keep('export.csv'), status: 'ready' }],
    ['accountExports', { accountId, fileKey: keep('archive.zip'), status: 'ready' }],
    [
      'metaWebhookEvents',
      {
        accountId,
        key: `${tag}-1`,
        payloadSealed: seal(
          secretKeys(getEnv()),
          JSON.stringify({ contacts: [{ wa_id: digits, profile: { name: NAME } }], text: TEXT }),
        ),
      },
    ],
    [
      'metaWebhookEvents',
      {
        accountId,
        key: `${tag}-2`,
        payloadSealed: seal(secretKeys(getEnv()), JSON.stringify({ wa_id: '919111111111' })),
      },
    ],
  ];
  for (const [name, doc] of docs) await db().collection(name).insertOne(doc);
  return { contactId, callId, keep, digits };
};

/** Every string of every document of every collection, for one account. */
const dump = async (accountId: Types.ObjectId) => {
  const out: Record<string, string> = {};
  for (const { name } of await db().listCollections().toArray()) {
    const rows = await db()
      .collection(name)
      .find({ accountId } as never)
      .toArray();
    if (rows.length) out[name] = JSON.stringify(rows);
  }
  return out;
};

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const filesOf = (root: string, tag: string) =>
  walk(root).filter((f) => f.includes(`${path.sep}${tag}${path.sep}`));

const storageRoot = () => (storage as unknown as { root: string }).root;

const erase = (u: TestUser, id: string, body: object = { confirm: 'ERASE' }) =>
  request(app).post(`/api/v1/contacts/${id}/erase`).set(header(u)).send(body);

beforeAll(async () => {
  app = buildTestApp({}, { storage, contactJobs: recorded.jobs });
  a = await createTestAccount();
  b = await createTestAccount();
  owner = await a.addUser('owner');
  ownerB = await b.addUser('owner');
});
beforeEach(async () => {
  for (const { name } of await db().listCollections().toArray()) {
    if (['accounts', 'users', 'roles', 'wallets'].includes(name)) continue;
    await db().collection(name).deleteMany({});
  }
  recorded.queued.length = 0;
});

describe('erase-map', () => {
  it('has one entry per row of DATA_MAP.md, and every action says what happens', () => {
    const map = readFileSync(
      path.resolve(__dirname, '..', '..', 'docs', 'security', 'DATA_MAP.md'),
      'utf8',
    );
    const section = map.slice(map.indexOf('## Collections'), map.indexOf('## File stores'));
    const stores = section
      .split('\n')
      .filter((l) => l.startsWith('| `'))
      .flatMap((l) => [...(l.split('|')[1] ?? '').matchAll(/`(\w+)`/g)].map((m) => m[1] ?? ''));
    expect(stores.length).toBeGreaterThanOrEqual(60);
    const known = new Set(ERASE_MAP.map((e) => e.store));
    expect(stores.filter((s) => !known.has(s))).toEqual([]);
    expect(new Set(ERASE_MAP.map((e) => e.store)).size).toBe(ERASE_MAP.length);
    for (const e of ERASE_MAP) {
      expect(Boolean(e.run) || Boolean(e.reason), e.store).toBe(true);
    }
  });
});

describe('POST /contacts/:id/erase (leak scan)', () => {
  it('finds nothing of the person in this account, and the other account is untouched', async () => {
    const phone = '+919812300001';
    const me = await seed(a.account._id, phone, 'acct-a');
    await seed(b.account._id, phone, 'acct-b');
    const otherBefore = await dump(b.account._id);
    const otherFiles = filesOf(storageRoot(), 'acct-b');

    const res = await erase(owner, me.contactId.toString());
    expect(res.status).toBe(200);
    expect(res.body.data.erased).toBe(true);
    expect(res.body.data.counts.contacts).toBe(1);

    const scan = await dump(a.account._id);
    // suppressions keep a hash; the call row keeps its id
    for (const [store, text] of Object.entries(scan)) {
      for (const marker of [phone, me.digits, phone.slice(-10), NAME, 'zorawar', 'MARKERTEXT77']) {
        expect(text.toLowerCase().includes(marker.toLowerCase()), `${store}: ${marker}`).toBe(
          false,
        );
      }
    }
    // files: the person's are gone, the file that doesn't hold them stays
    const left = filesOf(storageRoot(), 'acct-a').map((f) => path.basename(f));
    expect(left).toEqual(['other-import.csv']);
    for (const f of filesOf(storageRoot(), 'acct-a')) {
      expect(readFileSync(f, 'utf8')).not.toContain(phone);
    }

    expect(await dump(b.account._id)).toEqual(otherBefore);
    expect(filesOf(storageRoot(), 'acct-b')).toEqual(otherFiles);
    expect(await SuppressionModel.countDocuments({ accountId: b.account._id })).toBe(0);
  });

  it('keeps what money and reports need', async () => {
    const me = await seed(a.account._id, '+919812300002', 'acct-money');
    const wallet = await WalletModel.findOne({ accountId: a.account._id }).lean();
    const ledger = await LedgerEntryModel.collection.find({ accountId: a.account._id }).toArray();
    await erase(owner, me.contactId.toString()).expect(200);
    const call = await CallModel.collection.findOne({ _id: me.callId });
    expect(call).toMatchObject({
      status: 'completed',
      durationSec: 42,
      to: 'erased',
      contactId: null,
    });
    expect(call?.cost).toEqual({ totalMicros: 5 });
    const after = await LedgerEntryModel.collection.find({ accountId: a.account._id }).toArray();
    expect(after.map((l) => l.amountMicros as number)).toEqual(
      ledger.map((l) => l.amountMicros as number),
    );
    expect(after[0]?.note).toBeNull();
    expect(await WalletModel.findOne({ accountId: a.account._id }).lean()).toEqual(wallet);
  });

  it('marks the export files gone, and is safe to run from a stopped state', async () => {
    const me = await seed(a.account._id, '+919812300003', 'acct-rerun');
    await erase(owner, me.contactId.toString()).expect(200);
    expect((await ExportJobModel.collection.findOne({}))?.fileKey).toBeNull();
    expect((await AccountExportModel.collection.findOne({}))?.status).toBe('expired');
    const job = await ImportJobModel.collection.findOne({});
    expect(job?.fileKey).toBeNull();
    expect(job?.errorReportKey).toBe('acct-rerun/other-import.csv');
    // the contact goes last: a contact that is gone answers 404
    expect((await erase(owner, me.contactId.toString())).status).toBe(404);
  });

  it('audits counts only', async () => {
    const me = await seed(a.account._id, '+919812300004', 'acct-audit');
    await erase(owner, me.contactId.toString()).expect(200);
    const row = await AuditLogModel.findOne({ action: 'contact.erased' }).lean();
    expect(row?.target?.id).toBe(me.contactId.toString());
    expect(JSON.stringify(row)).not.toContain(NAME);
    expect(JSON.stringify(row)).not.toContain('919812300004');
  });

  it('refuses without the typed word, for another account, a viewer and an API key', async () => {
    const me = await seed(a.account._id, '+919812300005', 'acct-guard');
    const id = me.contactId.toString();
    expect((await erase(owner, id, {})).status).toBe(422);
    expect((await erase(owner, id, { confirm: 'erase' })).status).toBe(422);
    expect((await erase(ownerB, id)).status).toBe(404);
    expect((await erase(await a.addUser('viewer'), id)).status).toBe(403);
    expect((await erase(await a.addUser('manager'), id)).status).toBe(403);
    expect((await erase(owner, 'not-an-id')).status).toBe(422);
    expect(
      (await request(app).post(`/api/v1/contacts/${id}/erase`).send({ confirm: 'ERASE' })).status,
    ).toBe(401);
    expect(await ContactModel.collection.countDocuments({ _id: me.contactId })).toBe(1);
  });

  it('refuses while the contact is on a live call: nothing is touched', async () => {
    const me = await seed(a.account._id, '+919812300006', 'acct-live');
    await CallModel.collection.updateOne({ _id: me.callId }, { $set: { status: 'in_progress' } });
    const res = await erase(owner, me.contactId.toString());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONTACT_ERASE_BLOCKED');
    expect(await ContactModel.collection.countDocuments({ _id: me.contactId })).toBe(1);
    expect(await SuppressionModel.countDocuments({})).toBe(0);
  });
});

describe('suppression', () => {
  const add = (phone: string, u = owner) =>
    request(app).post('/api/v1/contacts').set(header(u)).send({ phone, name: 'Back Again' });

  it('a plain erase can be added back by hand; opt-out and DND stay blocked', async () => {
    const plain = await add('+919812300010');
    await erase(owner, String(plain.body.data.id)).expect(200);
    expect((await SuppressionModel.findOne({}).lean())?.reason).toBe('erased');
    expect(await isBlockedForOutreach(a.account._id, ['+919812300010'])).toBe(false);
    expect((await add('+919812300010')).status).toBe(201);

    const out = await add('+919812300011');
    await ContactModel.collection.updateOne(
      { _id: new Types.ObjectId(String(out.body.data.id)) },
      { $set: { optedOutAt: new Date() } },
    );
    await erase(owner, String(out.body.data.id)).expect(200);
    expect((await add('+919812300011')).status).toBe(409);
    expect(await isBlockedForOutreach(a.account._id, ['+919812300011'])).toBe(true);
    expect(await isPhoneOnDnd(a.account._id, ['+919812300011'])).toBe(true);

    const dnd = await add('+919812300012');
    await DndEntryModel.create({
      accountId: a.account._id,
      phoneE164: '+919812300012',
      reason: 'asked',
      source: 'manual',
    });
    await erase(owner, String(dnd.body.data.id)).expect(200);
    expect(await DndEntryModel.countDocuments({ phoneE164: '+919812300012' })).toBe(0);
    expect(await isPhoneOnDnd(a.account._id, ['+919812300012'])).toBe(true);
    expect(await isPhoneOnDnd(b.account._id, ['+919812300012'])).toBe(false);
  });

  it('stores a hash, never the number, and keeps the first reason', async () => {
    await recordSuppression(a.account._id, '+919812300020', 'opted_out');
    await recordSuppression(a.account._id, '+919812300020', 'erased');
    const rows = await SuppressionModel.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('opted_out');
    expect(JSON.stringify(rows)).not.toContain('9812300020');
    expect(rows[0]?.phoneHmac).toMatch(/^[0-9a-f]{64}$/);
    expect((await suppressedPhones(a.account._id, ['+919812300020'])).get('+919812300020')).toBe(
      'opted_out',
    );
    expect((await suppressedPhones(a.account._id, [])).size).toBe(0);
    expect(() => assertSuppressionReady()).not.toThrow();
  });

  it('answers 503 when file storage is not configured', async () => {
    const seen = await request(buildTestApp({}, { contactJobs: recorded.jobs }))
      .post(`/api/v1/contacts/${new Types.ObjectId().toString()}/erase`)
      .set(header(owner))
      .send({ confirm: 'ERASE' });
    expect(seen.status).toBe(503);
  });
});

describe('entry points refuse a suppressed number', () => {
  it('an API key can not add it back; a file import marks the row', async () => {
    await recordSuppression(a.account._id, '+919812300040', 'erased');
    const key = generateApiKey(false);
    await ApiKeyModel.create({
      accountId: a.account._id,
      name: 'erase-test',
      prefix: key.slice(0, PREFIX_LENGTH),
      keyHash: sha256Hex(key),
      scopes: ['contacts:write'],
      createdBy: new Types.ObjectId(),
    });
    const viaKey = await request(app)
      .post('/api/v1/contacts')
      .set('X-API-Key', key)
      .set('Idempotency-Key', 'erase-k1')
      .send({ phone: '+919812300040' });
    expect(viaKey.status).toBe(409);
    const bulk = await request(app)
      .post('/api/v1/contacts/bulk-upsert')
      .set('X-API-Key', key)
      .set('Idempotency-Key', 'erase-k2')
      .send({ upsert: 'phone', rows: [{ phone: '+919812300040' }] });
    expect(bulk.body.data).toMatchObject({ created: 0, failed: 1 });

    const rows = await analyseBatch(
      { accountId: a.account._id, kind: 'contacts' },
      {
        ctx: { country: 'IN' },
        fields: new Map(),
        columns: [{ index: 0, target: 'phone' }],
        options: null,
      } as never,
      [{ rowNumber: 2, cells: ['+919812300040'] }],
      new Map(),
    );
    expect(rows[0]).toMatchObject({ outcome: 'invalid', reasons: ['suppressed'] });
  });

  it('a queued after-call message for an erased person ends quietly', async () => {
    expect(await processPostCallSend({} as never, new Types.ObjectId().toString())).toEqual({
      status: 'done',
    });
  });
});

describe('bulk erase', () => {
  const start = (ids: string[], u = owner) =>
    request(app).post('/api/v1/contacts/bulk-erase').set(header(u)).send({ ids, confirm: 'ERASE' });

  it('runs as a job with progress, retries a live call, then finishes', async () => {
    const one = await seed(a.account._id, '+919812300030', 'bulk-1');
    const two = await seed(a.account._id, '+919812300031', 'bulk-2');
    await CallModel.collection.updateOne({ _id: two.callId }, { $set: { status: 'ringing' } });

    const res = await start([one.contactId.toString(), two.contactId.toString()]);
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ status: 'queued', total: 2, done: 0 });
    const id = String(res.body.data.id);
    expect(recorded.queued.at(-1)?.name).toBe('contacts.erase');
    const data = { accountId: a.account._id.toString(), eraseJobId: id };
    const ctx = { storage, jobs: recorded.jobs };

    expect(await runEraseJob(data, ctx)).toEqual({ done: 1, retried: 1 });
    expect(recorded.queued.at(-1)?.name).toBe('contacts.erase');
    expect(await ContactModel.collection.countDocuments({ _id: one.contactId })).toBe(0);
    expect(await ContactModel.collection.countDocuments({ _id: two.contactId })).toBe(1);

    await CallModel.collection.updateOne({ _id: two.callId }, { $set: { status: 'completed' } });
    expect(await runEraseJob(data, ctx)).toEqual({ done: 2, retried: 0 });
    const view = await request(app).get(`/api/v1/contacts/erase-jobs/${id}`).set(header(owner));
    expect(view.body.data).toMatchObject({ status: 'done', done: 2, total: 2 });
    expect((await EraseJobModel.findById(id).lean())?.contactIds).toEqual([]);
    expect(await runEraseJob(data, ctx)).toMatchObject({ skipped: true });

    const other = await request(app).get(`/api/v1/contacts/erase-jobs/${id}`).set(header(ownerB));
    expect(other.status).toBe(404);
  });

  it('refuses ids of another account and more than 1,000', async () => {
    const mine = await seed(a.account._id, '+919812300032', 'bulk-3');
    expect((await start([mine.contactId.toString()], ownerB)).status).toBe(404);
    const many = Array.from({ length: 1001 }, () => new Types.ObjectId().toString());
    expect((await start(many)).status).toBe(422);
    expect(await ContactModel.collection.countDocuments({ _id: mine.contactId })).toBe(1);
  });

  it('a contact already gone counts as done', async () => {
    const accountId = a.account._id;
    const job = await EraseJobModel.create({
      accountId,
      requestedBy: owner.user._id,
      contactIds: [new Types.ObjectId()],
      total: 1,
      expiresAt: new Date(Date.now() + 1000),
    });
    expect(
      await runEraseJob(
        { accountId: accountId.toString(), eraseJobId: job._id.toString() },
        { storage, jobs: recorded.jobs },
      ),
    ).toEqual({ done: 1, retried: 0 });
  });
});
