import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestMongo } from '../../tests/helpers/mongo';
import { createLogger } from '../shared/logger';

import { connectMongo, disconnectMongo, pingMongo, redactMongoUri, syncAllIndexes } from './mongo';
import { withTransaction } from './transaction';

const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });

describe('redactMongoUri', () => {
  it.each([
    ['mongodb://user:pa55@db.internal:27017/cav?replicaSet=rs0', 'mongodb://db.internal:27017/cav'],
    [
      'mongodb+srv://u:p@cluster0.x.mongodb.net/prod?retryWrites=true',
      'mongodb+srv://cluster0.x.mongodb.net/prod',
    ],
    [
      'mongodb://127.0.0.1:27018/cell_ai_voicebot?replicaSet=rs0',
      'mongodb://127.0.0.1:27018/cell_ai_voicebot',
    ],
    ['not-a-uri', 'mongodb://<invalid>'],
  ])('%s → %s', (uri, expected) => {
    expect(redactMongoUri(uri)).toBe(expected);
  });

  it('never contains the password', () => {
    expect(redactMongoUri('mongodb://admin:s3cr3t@h:1/db')).not.toContain('s3cr3t');
  });
});

describe('mongo connection', () => {
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const mongo = await startTestMongo();
    stop = mongo.stop;
    await connectMongo({ MONGODB_URI: mongo.uri, NODE_ENV: 'test' }, logger);
  });

  afterAll(async () => {
    await stop();
  });

  it('pings successfully when connected', async () => {
    expect(await pingMongo()).toBe(true);
  });

  it('syncs indexes without models', async () => {
    await expect(syncAllIndexes(logger)).resolves.toBeUndefined();
  });

  it('commits a transaction', async () => {
    const col = mongoose.connection.collection('tx_commit');
    const result = await withTransaction(async (session) => {
      await col.insertOne({ a: 1 }, { session });
      await col.insertOne({ a: 2 }, { session });
      return 'done';
    });
    expect(result).toBe('done');
    expect(await col.countDocuments()).toBe(2);
  });

  it('rolls back a transaction when fn throws', async () => {
    const col = mongoose.connection.collection('tx_rollback');
    await expect(
      withTransaction(async (session) => {
        await col.insertOne({ a: 1 }, { session });
        throw new Error('fail');
      }),
    ).rejects.toThrow('fail');
    expect(await col.countDocuments()).toBe(0);
  });

  it('pings false after disconnect', async () => {
    await disconnectMongo();
    expect(await pingMongo()).toBe(false);
  });
});
