import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../src/db/migrations';
import { CALL_COLLECTIONS } from '../../src/db/migrations/0008-calls';
import { useTestDb } from '../helpers/db';

useTestDb();

const db = () => {
  const handle = mongoose.connection.db;
  if (!handle) throw new Error('no db');
  return handle;
};
const migration = () => {
  const found = MIGRATIONS.find((m) => m.name === '0008-calls');
  if (!found) throw new Error('0008 missing');
  return found;
};
const collections = async () =>
  (await db().listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);

describe('0008-calls', () => {
  it('is registered right after 0007', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(names.indexOf('0008-calls')).toBe(names.indexOf('0007-flows') + 1);
  });

  it('creates the call collections and indexes, sets the recording notice; idempotent', async () => {
    for (const name of CALL_COLLECTIONS) {
      if ((await collections()).includes(name)) await db().collection(name).drop();
    }
    const accounts = db().collection('accounts');
    const { insertedId } = await accounts.insertOne({
      name: 'Old',
      settings: { recordingEnabled: true },
    });
    const custom = await accounts.insertOne({
      name: 'Custom',
      slug: 'p7-mig-custom',
      settings: { recordingNotice: 'Custom notice' },
    });
    await migration().up(db());
    await migration().up(db());
    expect(await collections()).toEqual(expect.arrayContaining([...CALL_COLLECTIONS]));
    expect(await db().collection('callEvents').indexes()).toContainEqual(
      expect.objectContaining({ key: { callId: 1, seq: 1 }, unique: true }),
    );
    expect(await db().collection('ttsCache').indexes()).toContainEqual(
      expect.objectContaining({ key: { key: 1 }, unique: true }),
    );
    expect(await db().collection('flowRuns').indexes()).toContainEqual(
      expect.objectContaining({ key: { callId: 1 }, sparse: true }),
    );
    expect((await accounts.findOne({ _id: insertedId }))?.settings).toMatchObject({
      recordingNotice: 'Yeh call quality ke liye record ki ja rahi hai.',
    });
    expect((await accounts.findOne({ _id: custom.insertedId }))?.settings).toMatchObject({
      recordingNotice: 'Custom notice',
    });
    await accounts.deleteMany({ _id: { $in: [insertedId, custom.insertedId] } });
  });

  it('refuses to roll back while calls exist, else drops collections and the notice', async () => {
    await migration().up(db());
    await db().collection('calls').insertOne({ to: 'x' });
    await expect(migration().down(db())).rejects.toThrow('0008-calls: refusing to roll back');
    await db().collection('calls').deleteMany({});
    const { insertedId } = await db()
      .collection('accounts')
      .insertOne({ name: 'N', slug: 'p7-mig-n', settings: { recordingNotice: 'x' } });
    await migration().down(db());
    const left = await collections();
    for (const name of CALL_COLLECTIONS) expect(left).not.toContain(name);
    expect((await db().collection('accounts').findOne({ _id: insertedId }))?.settings).toEqual({});
    await db().collection('accounts').deleteOne({ _id: insertedId });
    await migration().down(db());
    await migration().up(db());
  });
});
