import mongoose, { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../src/db/migrations';
import { AI_COLLECTIONS } from '../../src/db/migrations/0006-ai-agents';
import { DEFAULT_RATE_CARD } from '../../src/db/models/rate-card.model';
import { useTestDb } from '../helpers/db';

useTestDb();

const db = () => {
  const handle = mongoose.connection.db;
  if (!handle) throw new Error('no db');
  return handle;
};
const migration = () => {
  const found = MIGRATIONS.find((m) => m.name === '0006-ai-agents');
  if (!found) throw new Error('0006 missing');
  return found;
};
const collections = async () =>
  (await db().listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);

describe('0006-ai-agents', () => {
  it('is registered right after 0005', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(names.indexOf('0006-ai-agents')).toBe(names.indexOf('0005-wallets') + 1);
  });

  it('creates the AI collections and backfills AI prices on old rate cards; idempotent', async () => {
    const old = {
      callPerMinuteMicros: 1_000_000,
      pulseSeconds: 60,
      aiPerMinuteMicros: 6_000_000,
      ttsPer1kCharsMicros: 2_500_000,
      commissionBps: 0,
      billUnansweredAttempts: false,
      inheritsDefault: false,
      effectiveFrom: new Date(0),
    };
    await db()
      .collection('rateCards')
      .insertMany([
        { ...old, accountId: null },
        { ...old, accountId: new Types.ObjectId(), aiTextPer1kTokensMicros: 999 },
      ]);
    await migration().up(db());
    await migration().up(db());
    expect(await collections()).toEqual(expect.arrayContaining([...AI_COLLECTIONS]));
    const cards = await db().collection('rateCards').find().sort({ accountId: 1 }).toArray();
    expect(cards.map((c) => Number(c.aiTextPer1kTokensMicros)).sort()).toEqual(
      [999, DEFAULT_RATE_CARD.aiTextPer1kTokensMicros].sort(),
    );
    expect(
      cards.every(
        (c) => c.embeddingPer1kTokensMicros === DEFAULT_RATE_CARD.embeddingPer1kTokensMicros,
      ),
    ).toBe(true);
  });

  it('refuses to roll back while agents or knowledge sources exist, else drops the collections', async () => {
    await migration().up(db());
    await db().collection('aiAgents').insertOne({ name: 'x' });
    await expect(migration().down(db())).rejects.toThrow('0006-ai-agents: refusing to roll back');
    await db().collection('aiAgents').deleteMany({});
    await db().collection('knowledgeSources').insertOne({ title: 'x' });
    await expect(migration().down(db())).rejects.toThrow('refusing');
    await db().collection('knowledgeSources').deleteMany({});
    await migration().down(db());
    const left = await collections();
    for (const name of AI_COLLECTIONS) expect(left).not.toContain(name);
    // history keeps the prices
    expect(
      await db()
        .collection('rateCards')
        .countDocuments({ aiTextPer1kTokensMicros: { $exists: true } }),
    ).toBeGreaterThan(0);
    await migration().down(db()); // nothing left to drop
  });
});
