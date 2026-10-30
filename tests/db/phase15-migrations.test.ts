import mongoose, { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../src/db/migrations';
import { EXTERNAL_REF_INDEX } from '../../src/db/migrations/0017-integrations';
import { useTestDb } from '../helpers/db';

useTestDb();

const db = () => {
  const handle = mongoose.connection.db;
  if (!handle) throw new Error('no db');
  return handle;
};
const migration = () => {
  const found = MIGRATIONS.find((m) => m.name === '0017-integrations');
  if (!found) throw new Error('0017 missing');
  return found;
};

describe('0017-integrations', () => {
  it('is registered right after 0016', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(names.indexOf('0017-integrations')).toBe(names.indexOf('0016-insights') + 1);
  });

  it('up adds the key fields and indexes (idempotent); down removes them', async () => {
    const keyId = new Types.ObjectId();
    await db()
      .collection('apiKeys')
      .insertOne({
        _id: keyId,
        accountId: new Types.ObjectId(),
        name: 'old',
        prefix: 'cav_test_abcd',
        keyHash: 'f'.repeat(64),
        scopes: ['calls:read'],
        createdBy: new Types.ObjectId(),
      });

    await migration().up(db());
    await migration().up(db());
    expect(await db().collection('apiKeys').findOne({ _id: keyId })).toMatchObject({
      ipAllowlist: [],
      expiresAt: null,
      usage: [],
    });
    expect(await db().collection('calls').indexExists(EXTERNAL_REF_INDEX)).toBe(true);
    expect(await db().collection('messages').indexExists(EXTERNAL_REF_INDEX)).toBe(true);
    for (const created of [
      'webhookEvents',
      'webhookDeliveries',
      'postCallMessages',
      'sheetImports',
    ])
      expect((await db().listCollections({ name: created }).toArray()).length).toBe(1);
    const logIndexes = await db().collection('apiRequestLogs').indexes();
    expect(logIndexes.find((i) => i.key.at === 1)?.expireAfterSeconds).toBe(7 * 86_400);

    await migration().down(db());
    expect(await db().collection('calls').indexExists(EXTERNAL_REF_INDEX)).toBe(false);
    expect(await db().collection('messages').indexExists(EXTERNAL_REF_INDEX)).toBe(false);
    const key = await db().collection('apiKeys').findOne({ _id: keyId });
    expect(key).not.toHaveProperty('ipAllowlist');
    expect(key).not.toHaveProperty('usage');
    const names = (await db().listCollections().toArray()).map((c) => c.name);
    for (const gone of [
      'apiRequestLogs',
      'webhookEndpoints',
      'webhookEvents',
      'webhookDeliveries',
      'outcomeRules',
      'postCallMessages',
      'sheetImports',
    ])
      expect(names).not.toContain(gone);
    await migration().down(db()); // safe twice
  });
});
