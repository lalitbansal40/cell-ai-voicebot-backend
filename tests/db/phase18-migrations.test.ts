import mongoose, { Types } from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../src/db/migrations';
import { AccountModel } from '../../src/db/models/account.model';
import { PhoneNumberModel } from '../../src/db/models/phone-number.model';
import { useTestDb } from '../helpers/db';

useTestDb();

const db = () => {
  const handle = mongoose.connection.db;
  if (!handle) throw new Error('no db');
  return handle;
};
const migration = () => {
  const found = MIGRATIONS.find((m) => m.name === '0019-sip-lines');
  if (!found) throw new Error('0019 missing');
  return found;
};

beforeEach(async () => {
  await db().collection('accounts').deleteMany({});
  await db()
    .collection('phoneNumbers')
    .drop()
    .catch(() => undefined);
});

describe('0019-sip-lines', () => {
  it('is registered right after 0018', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(names.indexOf('0019-sip-lines')).toBe(names.indexOf('0018-security-privacy') + 1);
  });

  it('up puts every account on the test line and creates the number indexes (idempotent)', async () => {
    const old = new Types.ObjectId();
    const switched = new Types.ObjectId();
    await db()
      .collection('accounts')
      .insertMany([
        { _id: old, name: 'Old', slug: 'old' },
        {
          _id: switched,
          name: 'Sip',
          slug: 'sip',
          voiceLine: 'sip',
          sipSettings: { pulseSec: 30, spendMinutesPerHour: null },
        },
      ]);
    await migration().up(db());
    await migration().up(db());
    expect(await db().collection('accounts').findOne({ _id: old })).toMatchObject({
      voiceLine: 'dryrun',
      sipSettings: { pulseSec: null, spendMinutesPerHour: null },
    });
    expect(await db().collection('accounts').findOne({ _id: switched })).toMatchObject({
      voiceLine: 'sip',
      sipSettings: { pulseSec: 30 },
    });
    const indexes = await db().collection('phoneNumbers').indexes();
    expect(indexes.find((i) => i.key.number === 1)?.unique).toBe(true);
    expect(indexes.some((i) => i.key.accountId === 1 && i.key.status === 1)).toBe(true);
  });

  it('the previous release can still read accounts after up (fields are only added)', async () => {
    const id = new Types.ObjectId();
    await db().collection('accounts').insertOne({ _id: id, name: 'A', slug: 'a' });
    await migration().up(db());
    const raw = await db().collection('accounts').findOne({ _id: id });
    expect(raw).toMatchObject({ name: 'A', slug: 'a' });
    expect(Object.keys(raw ?? {}).sort()).toEqual([
      '_id',
      'name',
      'sipSettings',
      'slug',
      'voiceLine',
    ]);
  });

  it('down removes the fields and the collection', async () => {
    await db().collection('accounts').insertOne({ name: 'A', slug: 'a' });
    await migration().up(db());
    await migration().down(db());
    const raw = await db().collection('accounts').findOne({ slug: 'a' });
    expect(raw).not.toHaveProperty('voiceLine');
    expect(raw).not.toHaveProperty('sipSettings');
    expect(await db().listCollections({ name: 'phoneNumbers' }).toArray()).toHaveLength(0);
    await migration().down(db());
  });

  it('new accounts and numbers get the defaults; numbers are unique', async () => {
    const account = await AccountModel.create({ name: 'New', slug: 'new-sip' });
    expect(account.voiceLine).toBe('dryrun');
    expect(account.sipSettings).toEqual({ pulseSec: null, spendMinutesPerHour: null });
    await PhoneNumberModel.createIndexes();
    const n = await PhoneNumberModel.create({ number: '+911600000001', kind: '1600' });
    expect(n.toObject()).toMatchObject({
      accountId: null,
      purpose: 'outbound',
      status: 'active',
      label: '',
    });
    await expect(
      PhoneNumberModel.create({ number: '+911600000001', kind: '1600' }),
    ).rejects.toThrow();
    await expect(PhoneNumberModel.create({ number: '1600', kind: '1600' })).rejects.toThrow();
  });
});
