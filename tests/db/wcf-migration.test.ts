import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';

import { META_CALL_DIAG } from '../../src/config/limits';
import { MIGRATIONS } from '../../src/db/migrations';
import { useTestDb } from '../helpers/db';

useTestDb();
const db = () => {
  const handle = mongoose.connection.db;
  if (!handle) throw new Error('no db');
  return handle;
};

describe('0033-meta-call-errors', () => {
  it('creates TTL and query indexes idempotently, then drops the collection', async () => {
    const migration = MIGRATIONS.find((item) => item.name === '0033-meta-call-errors');
    if (!migration) throw new Error('0033 migration missing');
    await migration.up(db());
    await migration.up(db());
    const indexes = await db().collection('metaCallErrors').indexes();
    expect(indexes.find((index) => index.name === 'at_1')?.expireAfterSeconds).toBe(
      META_CALL_DIAG.errorTtlDays * 86_400,
    );
    expect(indexes.some((index) => index.key.channelId === 1 && index.key.at === -1)).toBe(true);
    expect(indexes.some((index) => index.key.accountId === 1 && index.key.at === -1)).toBe(true);
    await migration.down(db());
    expect(await db().listCollections({ name: 'metaCallErrors' }).toArray()).toHaveLength(0);
  });
});
