import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Infra smoke test: proves a single-node replica set supports multi-document
 * transactions — the wallet (hold / capture / release + ledger) depends on this.
 * MongoDB binary version is pinned in package.json → config.mongodbMemoryServer.
 */
describe('MongoDB replica set (infra)', () => {
  let replSet: MongoMemoryReplSet;
  let client: MongoClient;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    client = await MongoClient.connect(replSet.getUri());
  });

  afterAll(async () => {
    await client?.close();
    await replSet?.stop();
  });

  it('commits a multi-document transaction across two collections', async () => {
    const db = client.db('infra_test');
    const wallets = db.collection<{ accountId: string; balanceMicros: number }>('wallets');
    const ledger = db.collection<{ accountId: string; amountMicros: number }>('ledger');
    await wallets.insertOne({ accountId: 'acc_1', balanceMicros: 1_000_000 });

    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        await wallets.updateOne(
          { accountId: 'acc_1' },
          { $inc: { balanceMicros: -250_000 } },
          { session },
        );
        await ledger.insertOne({ accountId: 'acc_1', amountMicros: 250_000 }, { session });
      });
    } finally {
      await session.endSession();
    }

    const wallet = await wallets.findOne({ accountId: 'acc_1' });
    expect(wallet?.balanceMicros).toBe(750_000);
    expect(await ledger.countDocuments({ accountId: 'acc_1' })).toBe(1);
  });

  it('rolls back every write when the transaction aborts', async () => {
    const db = client.db('infra_test');
    const wallets = db.collection<{ accountId: string; balanceMicros: number }>('wallets');
    const ledger = db.collection<{ accountId: string; amountMicros: number }>('ledger');

    const session = client.startSession();
    await expect(
      session.withTransaction(async () => {
        await wallets.updateOne(
          { accountId: 'acc_1' },
          { $inc: { balanceMicros: -100_000 } },
          { session },
        );
        await ledger.insertOne({ accountId: 'acc_1', amountMicros: 100_000 }, { session });
        throw new Error('simulated failure');
      }),
    ).rejects.toThrow('simulated failure');
    await session.endSession();

    const wallet = await wallets.findOne({ accountId: 'acc_1' });
    expect(wallet?.balanceMicros).toBe(750_000);
    expect(await ledger.countDocuments({ accountId: 'acc_1' })).toBe(1);
  });
});
