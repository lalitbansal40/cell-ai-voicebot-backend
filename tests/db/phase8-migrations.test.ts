import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../src/db/migrations';
import { CAMPAIGN_COLLECTIONS, PHASE8_CALL_INDEXES } from '../../src/db/migrations/0009-campaigns';
import { useTestDb } from '../helpers/db';

useTestDb();

const db = () => {
  const handle = mongoose.connection.db;
  if (!handle) throw new Error('no db');
  return handle;
};
const migration = () => {
  const found = MIGRATIONS.find((m) => m.name === '0009-campaigns');
  if (!found) throw new Error('0009 missing');
  return found;
};
const collections = async () =>
  (await db().listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
const callIndexNames = async () => (await db().collection('calls').indexes()).map((i) => i.name);

describe('0009-campaigns', () => {
  it('is registered right after 0008', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(names.indexOf('0009-campaigns')).toBe(names.indexOf('0008-calls') + 1);
  });

  it('creates the campaign collections and indexes, account defaults, export kinds, roles; idempotent', async () => {
    for (const name of CAMPAIGN_COLLECTIONS) {
      if ((await collections()).includes(name)) await db().collection(name).drop();
    }
    const accounts = db().collection('accounts');
    const old = await accounts.insertOne({ name: 'Old', slug: 'p8-mig-old', settings: {} });
    const custom = await accounts.insertOne({
      name: 'Custom',
      slug: 'p8-mig-custom',
      limits: { maxConcurrentCalls: 3, dialsPerMinute: 9 },
      settings: { callCaps: { perDay: 1, perWeek: 2, minGapMinutes: 0 } },
    });
    const job = await db()
      .collection('exportJobs')
      .insertOne({ scope: 'filter', status: 'ready', accountId: old.insertedId });
    const role = await db()
      .collection('roles')
      .insertOne({
        accountId: old.insertedId,
        key: 'manager',
        name: 'Manager',
        isSystem: true,
        permissions: ['campaigns.read'],
      });

    await migration().up(db());
    await migration().up(db());

    expect(await collections()).toEqual(expect.arrayContaining([...CAMPAIGN_COLLECTIONS]));
    expect(await db().collection('campaignContacts').indexes()).toContainEqual(
      expect.objectContaining({ key: { campaignId: 1, contactId: 1 }, unique: true }),
    );
    expect(await db().collection('campaigns').indexes()).toContainEqual(
      expect.objectContaining({ key: { accountId: 1, name: 1 }, unique: true }),
    );
    expect(await db().collection('calls').indexes()).toContainEqual(
      expect.objectContaining({
        key: { campaignContactId: 1, attempt: 1 },
        unique: true,
        partialFilterExpression: { campaignContactId: { $type: 'objectId' } },
      }),
    );
    expect(await accounts.findOne({ _id: old.insertedId })).toMatchObject({
      limits: { maxConcurrentCalls: 10, dialsPerMinute: 60 },
      settings: { callCaps: { perDay: 3, perWeek: 10, minGapMinutes: 30 } },
    });
    expect(await accounts.findOne({ _id: custom.insertedId })).toMatchObject({
      limits: { maxConcurrentCalls: 3, dialsPerMinute: 9 },
      settings: { callCaps: { perDay: 1, perWeek: 2, minGapMinutes: 0 } },
    });
    expect(await db().collection('exportJobs').findOne({ _id: job.insertedId })).toMatchObject({
      kind: 'contacts',
      campaignId: null,
      format: 'csv',
      includePhone: true,
    });
    expect(
      (await db().collection('roles').findOne({ _id: role.insertedId }))?.permissions,
    ).toContain('campaigns.export');

    await accounts.deleteMany({ _id: { $in: [old.insertedId, custom.insertedId] } });
    await db().collection('exportJobs').deleteOne({ _id: job.insertedId });
    await db().collection('roles').deleteOne({ _id: role.insertedId });
  });

  it('refuses to roll back while campaigns exist, else drops collections, indexes and fields', async () => {
    await migration().up(db());
    await db().collection('campaigns').insertOne({ name: 'x' });
    await expect(migration().down(db())).rejects.toThrow('0009-campaigns: refusing to roll back');
    await db().collection('campaigns').deleteMany({});

    const account = await db()
      .collection('accounts')
      .insertOne({
        name: 'N',
        slug: 'p8-mig-n',
        limits: { maxConcurrentCalls: 1 },
        settings: { callCaps: {} },
      });
    const role = await db()
      .collection('roles')
      .insertOne({ key: 'owner', isSystem: true, permissions: ['campaigns.export', 'calls.read'] });
    await migration().down(db());

    const left = await collections();
    for (const name of CAMPAIGN_COLLECTIONS) expect(left).not.toContain(name);
    for (const name of PHASE8_CALL_INDEXES) expect(await callIndexNames()).not.toContain(name);
    const after = await db().collection('accounts').findOne({ _id: account.insertedId });
    expect(after?.limits).toBeUndefined();
    expect(after?.settings).toEqual({});
    expect((await db().collection('roles').findOne({ _id: role.insertedId }))?.permissions).toEqual(
      ['calls.read'],
    );
    await db().collection('accounts').deleteOne({ _id: account.insertedId });
    await db().collection('roles').deleteOne({ _id: role.insertedId });

    // a second rollback (nothing left) and a fresh up work
    await migration().down(db());
    await migration().up(db());
    expect(await callIndexNames()).toEqual(expect.arrayContaining([...PHASE8_CALL_INDEXES]));
  });
});
