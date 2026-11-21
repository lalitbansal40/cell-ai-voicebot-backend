import mongoose, { Types } from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../src/db/migrations';
import { useTestDb } from '../helpers/db';

/** PMC: 0032 adds `metaCalling` (off) to every WhatsApp channel. */
useTestDb();

const db = () => {
  const handle = mongoose.connection.db;
  if (!handle) throw new Error('no db');
  return handle;
};
const migration = () => {
  const found = MIGRATIONS.find((m) => m.name === '0032-wa-meta-calling');
  if (!found) throw new Error('0032 missing');
  return found;
};
const channels = () => db().collection('whatsappChannels');

beforeEach(async () => {
  await channels().deleteMany({});
});

describe('0032-wa-meta-calling', () => {
  it('is registered right after 0031', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(names.indexOf('0032-wa-meta-calling')).toBe(
      names.indexOf('0031-wa-scheduled-calls') + 1,
    );
  });

  it('up: off everywhere it is missing, keeps an existing state, adds the index (idempotent); down removes it', async () => {
    const old = new Types.ObjectId();
    const on = new Types.ObjectId();
    await channels().insertMany([
      { _id: old, provider: 'pinnacle' },
      { _id: on, provider: 'pinnacle', metaCalling: { status: 'on', tokenSealed: 'sealed' } },
    ]);
    await migration().up(db());
    await migration().up(db());
    const rows = await channels().find({}).toArray();
    const byId = new Map(rows.map((r) => [r._id.toString(), r]));
    expect(byId.get(old.toString())?.metaCalling).toMatchObject({
      status: 'off',
      tokenSealed: null,
      webhookCheck: { status: 'unknown' },
      error: null,
    });
    expect(byId.get(on.toString())?.metaCalling).toMatchObject({ status: 'on' });
    const indexes = await channels().indexes();
    expect(indexes.map((i) => i.name)).toContain('metaCalling.status_1');
    await migration().down(db());
    expect(await channels().countDocuments({ metaCalling: { $exists: true } })).toBe(0);
    expect((await channels().indexes()).map((i) => i.name)).not.toContain('metaCalling.status_1');
  });
});
