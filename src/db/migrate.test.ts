import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestMongo } from '../../tests/helpers/mongo';
import { createLogger } from '../shared/logger';

import { migrateDown, migrateUp, migrationStatus, type Migration } from './migrate';
import { MIGRATIONS } from './migrations';
import { baseline } from './migrations/0001-baseline';

/** Runner tests use their own list — the real registry grows every phase. */
const BASE: Migration[] = [baseline];

const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });

const db = () => {
  const handle = mongoose.connection.db;
  if (!handle) throw new Error('no db');
  return handle;
};

const second: Migration = {
  name: '0002-add-flag',
  up: async (d) => {
    await d.collection('things').insertOne({ flag: true });
  },
  down: async (d) => {
    await d.collection('things').deleteMany({ flag: true });
  },
};

describe('migrations', () => {
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const mongo = await startTestMongo();
    stop = mongo.stop;
    await mongoose.connect(mongo.uri);
  });

  afterAll(async () => {
    await stop();
  });

  beforeEach(async () => {
    await db().collection('migrations').deleteMany({});
    await db().collection('migrationLocks').deleteMany({});
    await db().collection('things').deleteMany({});
  });

  it('registry starts with the baseline and has unique, ordered names', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(names[0]).toBe('0001-baseline');
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(names);
  });

  it('applies pending migrations once, in order', async () => {
    expect(await migrateUp(db(), [...BASE, second], logger)).toEqual([
      '0001-baseline',
      '0002-add-flag',
    ]);
    expect(await migrateUp(db(), [...BASE, second], logger)).toEqual([]);
    expect(await db().collection('things').countDocuments({ flag: true })).toBe(1);
  });

  it('reports status', async () => {
    await migrateUp(db(), BASE, logger);
    expect(await migrationStatus(db(), [...BASE, second])).toEqual({
      applied: ['0001-baseline'],
      pending: ['0002-add-flag'],
    });
  });

  it('reverts the last applied migration', async () => {
    await migrateUp(db(), [...BASE, second], logger);
    expect(await migrateDown(db(), [...BASE, second], logger)).toBe('0002-add-flag');
    expect(await db().collection('things').countDocuments({ flag: true })).toBe(0);
    expect((await migrationStatus(db(), [...BASE, second])).pending).toEqual(['0002-add-flag']);
  });

  it('refuses to run while another runner holds the lock', async () => {
    await db()
      .collection('migrationLocks')
      .insertOne({ _id: 'lock' as never, at: new Date() });
    await expect(migrateUp(db(), BASE, logger)).rejects.toThrow(/already running/);
  });

  it('takes over a stale lock', async () => {
    await db()
      .collection('migrationLocks')
      .insertOne({ _id: 'lock' as never, at: new Date(Date.now() - 11 * 60_000) });
    expect(await migrateUp(db(), BASE, logger)).toEqual(['0001-baseline']);
    expect(await db().collection('migrationLocks').countDocuments()).toBe(0);
  });
});
