import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../src/db/migrations';
import { META_2026_INDEX } from '../../src/db/migrations/0014-meta-2026';
import { useTestDb } from '../helpers/db';

useTestDb();

const db = () => {
  const handle = mongoose.connection.db;
  if (!handle) throw new Error('no db');
  return handle;
};
const migration = () => {
  const found = MIGRATIONS.find((m) => m.name === '0014-meta-2026');
  if (!found) throw new Error('0014 missing');
  return found;
};
const channels = () => db().collection('whatsappChannels');

describe('0014-meta-2026', () => {
  it('is registered right after 0013', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(names.indexOf('0014-meta-2026')).toBe(names.indexOf('0013-whatsapp-calling') + 1);
  });

  it('up adds wabaKind / waacId (null) without touching set values; down removes them', async () => {
    await channels().insertMany([
      { label: 'Old', wabaId: '1', status: 'connected' },
      { label: 'New', wabaId: '2', status: 'connected', wabaKind: 'messaging', waacId: '9' },
    ]);
    await migration().up(db());
    await migration().up(db()); // idempotent
    const rows = await channels()
      .find({}, { sort: { wabaId: 1 } })
      .toArray();
    expect(rows.map((r) => [r.wabaKind as unknown, r.waacId as unknown])).toEqual([
      [null, null],
      ['messaging', '9'],
    ]);
    expect(await channels().indexExists(META_2026_INDEX)).toBe(true);

    await migration().down(db());
    expect(await channels().indexExists(META_2026_INDEX)).toBe(false);
    const after = await channels().find({}).toArray();
    expect(after.every((r) => !('wabaKind' in r) && !('waacId' in r))).toBe(true);
    await migration().down(db()); // safe twice
  });
});
