import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../src/db/migrations';
import { WHATSAPP_COLLECTIONS } from '../../src/db/migrations/0010-whatsapp';
import { useTestDb } from '../helpers/db';

useTestDb();

const db = () => {
  const handle = mongoose.connection.db;
  if (!handle) throw new Error('no db');
  return handle;
};
const migration = () => {
  const found = MIGRATIONS.find((m) => m.name === '0010-whatsapp');
  if (!found) throw new Error('0010 missing');
  return found;
};
const collections = async () =>
  (await db().listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);

describe('0010-whatsapp', () => {
  it('is registered right after 0009', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(names.indexOf('0010-whatsapp')).toBe(names.indexOf('0009-campaigns') + 1);
  });

  it('creates the collections and indexes, the billing mode default and the roles; idempotent', async () => {
    for (const name of WHATSAPP_COLLECTIONS) {
      if ((await collections()).includes(name)) await db().collection(name).drop();
    }
    const accounts = db().collection('accounts');
    const old = await accounts.insertOne({ name: 'Old', slug: 'p9-mig-old' });
    const custom = await accounts.insertOne({
      name: 'Custom',
      slug: 'p9-mig-custom',
      whatsapp: { metaPayer: 'customer' },
    });
    const role = await db()
      .collection('roles')
      .insertOne({
        accountId: old.insertedId,
        key: 'viewer',
        name: 'Viewer',
        isSystem: true,
        permissions: ['contacts.read'],
      });

    await migration().up(db());
    await migration().up(db());

    expect(await collections()).toEqual(expect.arrayContaining([...WHATSAPP_COLLECTIONS]));
    expect(await db().collection('whatsappChannels').indexes()).toContainEqual(
      expect.objectContaining({ key: { phoneNumberId: 1 }, unique: true }),
    );
    const events = await db().collection('metaWebhookEvents').indexes();
    expect(events).toContainEqual(expect.objectContaining({ key: { key: 1 }, unique: true }));
    expect(events).toContainEqual(
      expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
    );
    expect(await db().collection('metaDeletionRequests').indexes()).toContainEqual(
      expect.objectContaining({ key: { confirmationCode: 1 }, unique: true }),
    );
    expect(await accounts.findOne({ _id: old.insertedId })).toMatchObject({
      whatsapp: { metaPayer: 'platform' },
    });
    expect(await accounts.findOne({ _id: custom.insertedId })).toMatchObject({
      whatsapp: { metaPayer: 'customer' },
    });
    expect(
      (await db().collection('roles').findOne({ _id: role.insertedId }))?.permissions,
    ).toContain('whatsapp.read');

    await accounts.deleteMany({ _id: { $in: [old.insertedId, custom.insertedId] } });
    await db().collection('roles').deleteOne({ _id: role.insertedId });
  });

  it('refuses to roll back while numbers are connected, else drops collections and fields', async () => {
    await migration().up(db());
    const channel = await db()
      .collection('whatsappChannels')
      .insertOne({ status: 'connected', phoneNumberId: 'p9-roll' });
    await expect(migration().down(db())).rejects.toThrow('0010-whatsapp: refusing to roll back');
    await db()
      .collection('whatsappChannels')
      .updateOne({ _id: channel.insertedId }, { $set: { status: 'disconnected' } });

    const account = await db()
      .collection('accounts')
      .insertOne({ name: 'N', slug: 'p9-mig-n', whatsapp: { metaPayer: 'platform' } });
    const role = await db()
      .collection('roles')
      .insertOne({
        key: 'owner',
        isSystem: true,
        permissions: ['whatsapp.read', 'whatsapp.manage', 'calls.read'],
      });
    await migration().down(db());

    const left = await collections();
    for (const name of WHATSAPP_COLLECTIONS) expect(left).not.toContain(name);
    expect(
      (await db().collection('accounts').findOne({ _id: account.insertedId }))?.whatsapp,
    ).toBeUndefined();
    expect((await db().collection('roles').findOne({ _id: role.insertedId }))?.permissions).toEqual(
      ['calls.read'],
    );
    await db().collection('accounts').deleteOne({ _id: account.insertedId });
    await db().collection('roles').deleteOne({ _id: role.insertedId });

    // a second rollback (nothing left) and a fresh up work
    await migration().down(db());
    await migration().up(db());
    expect(await collections()).toEqual(expect.arrayContaining([...WHATSAPP_COLLECTIONS]));
  });
});
