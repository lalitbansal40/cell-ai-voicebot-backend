import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../src/db/migrations';
import { INBOX_COLLECTIONS } from '../../src/db/migrations/0011-inbox';
import { DEFAULT_INBOX_SETTINGS } from '../../src/db/models/account.model';
import { useTestDb } from '../helpers/db';

useTestDb();

const db = () => {
  const handle = mongoose.connection.db;
  if (!handle) throw new Error('no db');
  return handle;
};
const migration = () => {
  const found = MIGRATIONS.find((m) => m.name === '0011-inbox');
  if (!found) throw new Error('0011 missing');
  return found;
};
const collections = async () =>
  (await db().listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);

describe('0011-inbox', () => {
  it('is registered right after 0010', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(names.indexOf('0011-inbox')).toBe(names.indexOf('0010-whatsapp') + 1);
  });

  it('creates the collections and indexes, the inbox settings and the roles; idempotent', async () => {
    for (const name of INBOX_COLLECTIONS) {
      if ((await collections()).includes(name)) await db().collection(name).drop();
    }
    const accounts = db().collection('accounts');
    const old = await accounts.insertOne({ name: 'Old', slug: 'p10-mig-old', settings: {} });
    const custom = await accounts.insertOne({
      name: 'Custom',
      slug: 'p10-mig-custom',
      settings: { inbox: { ...DEFAULT_INBOX_SETTINGS, sendReadReceipts: false } },
    });
    const role = await db()
      .collection('roles')
      .insertOne({
        accountId: old.insertedId,
        key: 'agent',
        name: 'Agent',
        isSystem: true,
        permissions: ['contacts.read'],
      });

    await migration().up(db());
    await migration().up(db());

    expect(await collections()).toEqual(expect.arrayContaining([...INBOX_COLLECTIONS]));
    expect(await db().collection('conversations').indexes()).toContainEqual(
      expect.objectContaining({ key: { accountId: 1, channelId: 1, waId: 1 }, unique: true }),
    );
    const messageIndexes = await db().collection('messages').indexes();
    expect(messageIndexes).toContainEqual(
      expect.objectContaining({
        key: { accountId: 1, channelId: 1, waMessageId: 1 },
        unique: true,
      }),
    );
    expect(messageIndexes).toContainEqual(expect.objectContaining({ default_language: 'none' }));
    expect(await db().collection('inboxUploads').indexes()).toContainEqual(
      expect.objectContaining({ key: { expiresAt: 1 } }),
    );
    expect((await accounts.findOne({ _id: old.insertedId }))?.settings.inbox).toEqual(
      DEFAULT_INBOX_SETTINGS,
    );
    expect(
      (await accounts.findOne({ _id: custom.insertedId }))?.settings.inbox.sendReadReceipts,
    ).toBe(false);
    const permissions = (await db().collection('roles').findOne({ _id: role.insertedId }))
      ?.permissions as string[];
    expect(permissions).toEqual(expect.arrayContaining(['inbox.read', 'inbox.reply']));
    expect(permissions).not.toContain('inbox.assign');

    await accounts.deleteMany({ _id: { $in: [old.insertedId, custom.insertedId] } });
    await db().collection('roles').deleteOne({ _id: role.insertedId });
  });

  it('refuses to roll back while messages exist, else drops collections and fields', async () => {
    await migration().up(db());
    const msg = await db().collection('messages').insertOne({ type: 'text' });
    await expect(migration().down(db())).rejects.toThrow('0011-inbox: refusing to roll back');
    await db().collection('messages').deleteOne({ _id: msg.insertedId });

    const account = await db()
      .collection('accounts')
      .insertOne({
        name: 'N',
        slug: 'p10-mig-n',
        settings: { recordingEnabled: true, inbox: DEFAULT_INBOX_SETTINGS },
      });
    const contact = await db()
      .collection('contacts')
      .insertOne({ phoneE164: '+919000099020', whatsapp: { waId: '919000099020' } });
    const role = await db()
      .collection('roles')
      .insertOne({
        key: 'owner',
        isSystem: true,
        permissions: ['inbox.read', 'inbox.reply', 'inbox.assign', 'calls.read'],
      });
    await migration().down(db());

    const left = await collections();
    for (const name of INBOX_COLLECTIONS) expect(left).not.toContain(name);
    expect(
      (await db().collection('accounts').findOne({ _id: account.insertedId }))?.settings,
    ).toEqual({ recordingEnabled: true });
    expect(
      (await db().collection('contacts').findOne({ _id: contact.insertedId }))?.whatsapp,
    ).toBeUndefined();
    expect((await db().collection('roles').findOne({ _id: role.insertedId }))?.permissions).toEqual(
      ['calls.read'],
    );
    await db().collection('accounts').deleteOne({ _id: account.insertedId });
    await db().collection('contacts').deleteOne({ _id: contact.insertedId });
    await db().collection('roles').deleteOne({ _id: role.insertedId });

    await migration().down(db());
    await migration().up(db());
    expect(await collections()).toEqual(expect.arrayContaining([...INBOX_COLLECTIONS]));
  });
});
