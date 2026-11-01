import { readFileSync } from 'node:fs';
import path from 'node:path';

import { unzipSync, strFromU8 } from 'fflate';
import mongoose, { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AccountExportModel } from '../../src/db/models/account-export.model';
import { AccountModel } from '../../src/db/models/account.model';
import { ApiKeyModel } from '../../src/db/models/api-key.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { CallModel } from '../../src/db/models/call.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { CustomFieldModel } from '../../src/db/models/custom-field.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { UserModel } from '../../src/db/models/user.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { WebhookEndpointModel } from '../../src/db/models/webhook-endpoint.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import {
  cleanForExport,
  cleanupAccountExports,
  EXPORT_STORES,
  runAccountExport,
} from '../../src/modules/privacy/account-export.job';
import { purgeAccount, runAccountPurges } from '../../src/modules/privacy/account-purge.job';
import { encryptValue } from '../../src/modules/privacy/sensitive';
import {
  createTestAccount,
  TEST_PASSWORD,
  tokenFor,
  type TestAccount,
  type TestUser,
} from '../helpers/auth';
import { recordingContactJobs, useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { lastEmail, useCapturedEmail } from '../helpers/email';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const sent = useCapturedEmail();
const storage = useTempStorage();
const recorded = recordingContactJobs();
let app: ReturnType<typeof buildTestApp>;
const header = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
const db = () => mongoose.connection.db as NonNullable<typeof mongoose.connection.db>;

const SECRET_VALUE = 'SENSITIVE-LOAN-555';

const world = async (tag: string, phone: string) => {
  const account = await createTestAccount({ name: `Biz ${tag}` });
  const owner = await account.addUser('owner');
  const id = account.account._id;
  await WalletModel.collection.deleteMany({ accountId: id });
  await WalletModel.collection.insertOne({ accountId: id, balanceMicros: 5000, holdMicros: 0 });
  await ContactModel.collection.insertOne({
    accountId: id,
    phoneE164: phone,
    name: `Person ${tag}`,
    tags: ['vip'],
    variables: { loan: encryptValue(SECRET_VALUE), branch: `Branch-${tag}` },
    deletedAt: null,
  });
  await CallModel.collection.insertOne({
    accountId: id,
    contactId: null,
    to: phone,
    status: 'completed',
    outcome: {},
    variables: {},
  });
  await db()
    .collection('messages')
    .insertOne({ accountId: id, text: `hello ${tag}` });
  await WebhookEndpointModel.collection.insertOne({
    accountId: id,
    url: 'https://hooks.example.com/x',
    secretSealed: 'v2:never',
    active: true,
  });
  await db()
    .collection('ledgerEntries')
    .insertOne({
      accountId: id,
      amountMicros: 100,
      balanceAfterMicros: 100,
      idempotencyKey: `seed-${tag}`,
    });
  return { account, owner, id };
};

/** The state an owner's request leaves, with the grace over. */
const dueForPurge = (id: Types.ObjectId) =>
  AccountModel.updateOne(
    { _id: id },
    {
      $set: {
        deletion: {
          status: 'scheduled',
          requestedAt: new Date(),
          requestedBy: null,
          scheduledFor: new Date(Date.now() - 1000),
          purgedAt: null,
        },
      },
    },
  );

const readArchive = async (key: string) => {
  const stream = await storage.get(key);
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  const files = unzipSync(new Uint8Array(Buffer.concat(chunks)));
  return Object.fromEntries(Object.entries(files).map(([n, b]) => [n, strFromU8(b)]));
};

beforeAll(() => {
  app = buildTestApp({}, { storage, contactJobs: recorded.jobs });
});
beforeEach(async () => {
  recorded.queued.length = 0;
  await AccountExportModel.deleteMany({});
});

describe('account export', () => {
  const ask = (u: TestUser, body: object = { password: TEST_PASSWORD }) =>
    request(app).post('/api/v1/account/export').set(header(u)).send(body);

  it('holds every store of the data map, opens sensitive fields, and nothing of others', async () => {
    const mine = await world('A1', '+919700000001');
    await world('B1', '+919700000002');
    const res = await ask(mine.owner);
    expect(res.status).toBe(202);
    const id = String(res.body.data.id);
    expect(recorded.queued.at(-1)?.name).toBe('account.export');

    expect(
      await runAccountExport({ accountId: mine.id.toString(), accountExportId: id }, { storage }),
    ).toEqual({ status: 'ready' });
    expect(lastEmail(sent, 'account.export_ready', mine.owner.user.email)).toBeDefined();
    const row = await AccountExportModel.findById(id).lean();
    expect(row?.status).toBe('ready');
    expect(row?.counts.contacts).toBe(1);
    const files = await readArchive(String(row?.fileKey));

    for (const store of EXPORT_STORES) expect(files[`${store}.jsonl`], store).toBeDefined();
    expect(files['contacts.csv']).toContain('+919700000001');
    expect(files['contacts.csv']).toContain(SECRET_VALUE);
    expect(files['calls.jsonl']).toContain('+919700000001');
    const all = JSON.stringify(files);
    expect(all).not.toContain('919700000002');
    expect(all).not.toContain('Person B1');
    expect(all).not.toContain('v2:never');
    expect(all).not.toContain('passwordHash');
    expect(all).not.toContain('hooks.example.com');

    const page = await request(app).get(`/api/v1/account/exports/${id}`).set(header(mine.owner));
    expect(page.body.data.url).toContain('/files/');
    expect(await AuditLogModel.countDocuments({ action: 'account.export_downloaded' })).toBe(1);
    const list = await request(app).get('/api/v1/account/exports').set(header(mine.owner));
    expect(list.body.data).toHaveLength(1);
  });

  it('matches the export column of DATA_MAP.md', () => {
    const map = readFileSync(
      path.resolve(__dirname, '..', '..', 'docs', 'security', 'DATA_MAP.md'),
      'utf8',
    );
    const rows = map
      .slice(map.indexOf('## Collections'), map.indexOf('## File stores'))
      .split('\n');
    const marked = rows
      .filter((l) => l.startsWith('| `'))
      .filter((l) => (l.split('|')[5] ?? '').includes('yes'))
      .flatMap((l) => [...(l.split('|')[1] ?? '').matchAll(/`(\w+)`/g)].map((m) => m[1] ?? ''))
      .filter((s) => s !== 'contacts' && s !== 'invoiceCounters' && s !== 'paymentEvents');
    expect(marked.filter((s) => !(EXPORT_STORES as readonly string[]).includes(s))).toEqual([]);
  });

  it('adds recordings when asked; one at a time; password and owner only', async () => {
    const mine = await world('A2', '+919700000003');
    await storage.put('rec/a2.wav', Buffer.from('voice-bytes'), { contentType: 'audio/wav' });
    await CallModel.collection.insertOne({
      accountId: mine.id,
      to: 'x',
      recording: { fileKey: 'rec/a2.wav' },
    });
    await CallModel.collection.insertOne({
      accountId: mine.id,
      to: 'y',
      recording: { fileKey: 'rec/gone.wav' },
    });
    expect((await ask(mine.owner, { password: 'wrong-password-1' })).body.error.code).toBe(
      'REAUTH_FAILED',
    );
    expect((await ask(await mine.account.addUser('admin'))).status).toBe(403);
    const first = await ask(mine.owner, { password: TEST_PASSWORD, includeRecordings: true });
    expect(first.status).toBe(202);
    const second = await ask(mine.owner);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ACCOUNT_EXPORT_IN_PROGRESS');
    const id = String(first.body.data.id);
    await runAccountExport({ accountId: mine.id.toString(), accountExportId: id }, { storage });
    const row = await AccountExportModel.findById(id).lean();
    const files = await readArchive(String(row?.fileKey));
    expect(Object.keys(files).filter((n) => n.startsWith('recordings/'))).toHaveLength(1);
    expect(row?.counts.recordings).toBe(1);
    // rerun of a finished job does nothing
    expect(
      await runAccountExport({ accountId: mine.id.toString(), accountExportId: id }, { storage }),
    ).toEqual({ status: 'skipped' });
    const running = await request(app)
      .get(`/api/v1/account/exports/${id}`)
      .set(header(await mine.account.addUser('viewer')));
    expect(running.status).toBe(403);
  });

  it('another account gets 404; a failed job says so; old files are removed', async () => {
    const mine = await world('A3', '+919700000004');
    const other = await world('B3', '+919700000005');
    const res = await ask(mine.owner);
    const id = String(res.body.data.id);
    expect(
      (await request(app).get(`/api/v1/account/exports/${id}`).set(header(other.owner))).status,
    ).toBe(404);
    const notReady = await request(app)
      .get(`/api/v1/account/exports/${id}`)
      .set(header(mine.owner));
    expect(notReady.body.data.url).toBeNull();
    const broken = {
      put: () => Promise.reject(new Error('disk full')),
      get: storage.get.bind(storage),
    } as never;
    await expect(
      runAccountExport({ accountId: mine.id.toString(), accountExportId: id }, { storage: broken }),
    ).rejects.toThrow('disk full');
    expect((await AccountExportModel.findById(id).lean())?.status).toBe('failed');

    await storage.put('old.zip', Buffer.from('x'), { contentType: 'application/zip' });
    await AccountExportModel.updateOne(
      { _id: id },
      { $set: { status: 'ready', fileKey: 'old.zip', expiresAt: new Date(Date.now() - 1000) } },
    );
    expect(await cleanupAccountExports(storage)).toEqual({ removed: 1 });
    expect(await storage.exists('old.zip')).toBe(false);
    expect((await AccountExportModel.findById(id).lean())?.status).toBe('expired');
  });

  it('cleans secrets from any document', () => {
    expect(
      cleanForExport({
        name: 'x',
        tokenSealed: 's',
        nested: [{ secretSealed: 's', keep: 1 }],
        passwordHash: 'h',
        at: new Date(0),
        when: null,
      }),
    ).toEqual({ name: 'x', nested: [{ keep: 1 }], at: new Date(0), when: null });
    expect(cleanForExport('$enc:abc')).toBe('••••');
  });
});

describe('account delete', () => {
  const del = (u: TestUser, body: object) =>
    request(app).post('/api/v1/account/delete').set(header(u)).send(body);
  const good = (a: TestAccount) => ({ password: TEST_PASSWORD, confirmName: a.account.name });

  it('schedules with password and typed name: keys, webhooks and banner; cancel restores', async () => {
    const w = await world('D1', '+919700000010');
    const key = await ApiKeyModel.collection.insertOne({
      accountId: w.id,
      name: 'k',
      revokedAt: null,
    });
    const body = good(w.account);
    expect((await del(w.owner, { ...body, password: 'wrong-password-1' })).body.error.code).toBe(
      'REAUTH_FAILED',
    );
    expect((await del(w.owner, { ...body, confirmName: 'Other' })).status).toBe(422);
    expect((await del(await w.account.addUser('admin'), body)).status).toBe(403);

    const res = await del(w.owner, body);
    expect(res.status).toBe(200);
    const days = (new Date(res.body.data.scheduledFor).getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(7);
    expect((await ApiKeyModel.collection.findOne({ _id: key.insertedId }))?.revokedAt).toBeTruthy();
    expect((await WebhookEndpointModel.collection.findOne({ accountId: w.id }))?.active).toBe(
      false,
    );
    expect((await del(w.owner, body)).status).toBe(409);
    expect(lastEmail(sent, 'account.delete_scheduled', w.owner.user.email)).toBeDefined();
    const me = await request(app).get('/api/v1/account').set(header(w.owner));
    expect(me.body.data.deletion.status).toBe('scheduled');

    // not due yet: nothing is purged
    expect(await runAccountPurges({ storage })).toEqual({ purged: 0, waiting: 0 });
    expect(await ContactModel.collection.countDocuments({ accountId: w.id })).toBe(1);

    const cancel = await request(app).post('/api/v1/account/delete/cancel').set(header(w.owner));
    expect(cancel.body.data).toEqual({ canceled: true });
    expect((await WebhookEndpointModel.collection.findOne({ accountId: w.id }))?.active).toBe(true);
    expect((await AccountModel.findById(w.id).lean())?.deletion).toBeNull();
    expect(lastEmail(sent, 'account.delete_canceled', w.owner.user.email)).toBeDefined();
    expect(
      (await request(app).post('/api/v1/account/delete/cancel').set(header(w.owner))).status,
    ).toBe(409);
  });

  it('a wallet hold blocks it; impersonation is refused; a suspended owner may delete', async () => {
    const w = await world('D2', '+919700000011');
    await WalletModel.collection.updateOne({ accountId: w.id }, { $set: { holdMicros: 10 } });
    const held = await del(w.owner, good(w.account));
    expect(held.body.error.code).toBe('ACCOUNT_DELETE_BLOCKED');
    await WalletModel.collection.updateOne({ accountId: w.id }, { $set: { holdMicros: 0 } });

    const imp = await tokenFor(w.owner.user, { imp: new Types.ObjectId().toString() });
    const refused = await request(app)
      .post('/api/v1/account/delete')
      .set('Authorization', `Bearer ${imp}`)
      .send(good(w.account));
    expect(refused.status).toBe(403);

    await AccountModel.updateOne({ _id: w.id }, { $set: { status: 'suspended' } });
    expect((await del(w.owner, good(w.account))).status).toBe(200);
  });

  it('purges after the grace: no personal data, a second account untouched, money kept', async () => {
    const w = await world('P1', '+919700000012');
    const other = await world('P2', '+919700000012');
    const beforeOther = await Promise.all(
      ['contacts', 'calls', 'messages', 'ledgerEntries'].map((c) =>
        db().collection(c).find({ accountId: other.id }).toArray(),
      ),
    );
    const ledger = await LedgerEntryModel.collection.countDocuments({ accountId: w.id });
    const channel = await WhatsAppChannelModel.collection.insertOne({
      accountId: w.id,
      status: 'connected',
      wabaId: 'w1',
    });
    await del(w.owner, good(w.account)).expect(200);
    await AccountModel.updateOne(
      { _id: w.id },
      { $set: { 'deletion.scheduledFor': new Date(Date.now() - 1000) } },
    );
    const disconnected: string[] = [];
    expect(
      await runAccountPurges({
        storage,
        disconnectChannel: (_id, channelId) => {
          disconnected.push(channelId);
          return Promise.resolve();
        },
      }),
    ).toEqual({ purged: 1, waiting: 0 });
    expect(disconnected).toEqual([channel.insertedId.toString()]);

    const account = await AccountModel.findById(w.id).lean();
    expect(account).toMatchObject({ name: 'Deleted account', status: 'deleted', ownerId: null });
    expect(account?.deletion?.status).toBe('purged');
    expect(await UserModel.countDocuments({ accountId: w.id })).toBe(0);
    for (const { name } of await db().listCollections().toArray()) {
      const text = JSON.stringify(
        await db()
          .collection(name)
          .find({ accountId: w.id } as never)
          .toArray(),
      );
      for (const marker of ['919700000012', 'Person P1', 'hello P1', 'Branch-P1']) {
        expect(text.includes(marker), `${name}: ${marker}`).toBe(false);
      }
    }
    expect(await LedgerEntryModel.collection.countDocuments({ accountId: w.id })).toBe(ledger);
    expect(await WalletModel.collection.countDocuments({ accountId: w.id })).toBe(1);
    expect(await AuditLogModel.countDocuments({ accountId: w.id, action: 'account.purged' })).toBe(
      1,
    );

    const afterOther = await Promise.all(
      ['contacts', 'calls', 'messages', 'ledgerEntries'].map((c) =>
        db().collection(c).find({ accountId: other.id }).toArray(),
      ),
    );
    expect(afterOther).toEqual(beforeOther);
    const stillIn = await request(app).get('/api/v1/account').set(header(w.owner));
    expect(stillIn.status).toBe(401);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: w.owner.user.email, password: TEST_PASSWORD });
    expect(login.status).toBe(401);
  });

  it('restarts mid-purge and finishes; a live call waits for the next run', async () => {
    const w = await world('R1', '+919700000013');
    await ContactModel.collection.insertOne({
      accountId: w.id,
      phoneE164: '+919700000014',
      deletedAt: null,
    });
    await dueForPurge(w.id);
    let stopped = false;
    await expect(
      purgeAccount(w.id, {
        storage,
        afterContact: () => {
          if (!stopped) {
            stopped = true;
            throw new Error('stopped');
          }
        },
      }),
    ).rejects.toThrow('stopped');
    expect((await AccountModel.findById(w.id).lean())?.status).toBe('deleted');
    const live = await CallModel.collection.insertOne({
      accountId: w.id,
      to: '+919700000014',
      status: 'in_progress',
    });
    expect(await purgeAccount(w.id, { storage })).toMatchObject({ status: 'waiting' });
    await CallModel.collection.updateOne(
      { _id: live.insertedId },
      { $set: { status: 'completed' } },
    );
    expect((await purgeAccount(w.id, { storage })).status).toBe('purged');
    expect(await ContactModel.collection.countDocuments({ accountId: w.id })).toBe(0);
  });

  it('refuses an account nobody asked to delete, and the platform account', async () => {
    const w = await world('G1', '+919700000016');
    await expect(purgeAccount(w.id, { storage })).rejects.toThrow('not waiting');
    expect(await ContactModel.collection.countDocuments({ accountId: w.id })).toBe(1);
    const platform = await createTestAccount({ isPlatform: true });
    await dueForPurge(platform.account._id);
    await expect(purgeAccount(platform.account._id, { storage })).rejects.toThrow('not waiting');
    expect(await runAccountPurges({ storage })).toEqual({ purged: 0, waiting: 0 });
  });

  it('a number that fails to disconnect at Meta does not stop the purge', async () => {
    const w = await world('M1', '+919700000015');
    await WhatsAppChannelModel.collection.insertOne({
      accountId: w.id,
      status: 'connected',
      wabaId: 'x1',
    });
    await dueForPurge(w.id);
    const res = await purgeAccount(w.id, {
      storage,
      disconnectChannel: () => Promise.reject(new Error('meta down')),
    });
    expect(res.status).toBe('purged');
  });
});

describe('superadmin', () => {
  let superadmin: TestUser;
  beforeAll(async () => {
    const platform = await createTestAccount({ isPlatform: true });
    superadmin = await platform.addUser('owner', { platformRole: 'superadmin' });
  });

  it('lists pending deletes with the balance, cancels, and runs only after the grace', async () => {
    const w = await world('S1', '+919700000020');
    await request(app)
      .post('/api/v1/account/delete')
      .set(header(w.owner))
      .send({ password: TEST_PASSWORD, confirmName: w.account.account.name })
      .expect(200);
    const list = await request(app).get('/api/v1/admin/account-deletions').set(header(superadmin));
    expect(list.body.data.find((a: { id: string }) => a.id === w.id.toString())).toMatchObject({
      status: 'scheduled',
      balanceMicros: 5000,
    });
    const run = `/api/v1/admin/accounts/${w.id.toString()}/deletion/run`;
    expect((await request(app).post(run).set(header(superadmin))).status).toBe(409);
    expect((await request(app).post(run).set(header(w.owner))).status).toBe(403);

    const cancel = `/api/v1/admin/accounts/${w.id.toString()}/deletion/cancel`;
    expect((await request(app).post(cancel).set(header(superadmin))).status).toBe(200);
    expect((await request(app).post(run).set(header(superadmin))).status).toBe(409);
    await request(app)
      .post('/api/v1/account/delete')
      .set(header(w.owner))
      .send({ password: TEST_PASSWORD, confirmName: w.account.account.name })
      .expect(200);
    await AccountModel.updateOne(
      { _id: w.id },
      { $set: { 'deletion.scheduledFor': new Date(Date.now() - 1000) } },
    );
    const done = await request(app).post(run).set(header(superadmin));
    expect(done.body.data.status).toBe('purged');
    const audit = await AuditLogModel.find({
      action: 'account.purged',
      'target.id': w.id.toString(),
    }).lean();
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it('answers 503 without storage', async () => {
    const bare = buildTestApp();
    const res = await request(bare)
      .post(`/api/v1/admin/accounts/${new Types.ObjectId().toString()}/deletion/run`)
      .set(header(superadmin));
    expect(res.status).toBe(503);
    const field = await CustomFieldModel.exists({});
    expect(field).toBeNull();
  });
});
