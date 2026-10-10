import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../src/db/migrations';
import { FLOW_COLLECTIONS } from '../../src/db/migrations/0007-flows';
import { useTestDb } from '../helpers/db';

useTestDb();

const db = () => {
  const handle = mongoose.connection.db;
  if (!handle) throw new Error('no db');
  return handle;
};
const migration = () => {
  const found = MIGRATIONS.find((m) => m.name === '0007-flows');
  if (!found) throw new Error('0007 missing');
  return found;
};
const collections = async () =>
  (await db().listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);

describe('0007-flows', () => {
  it('is registered right after 0006', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(names.indexOf('0007-flows')).toBe(names.indexOf('0006-ai-agents') + 1);
  });

  it('creates the flow collections with their indexes; idempotent', async () => {
    for (const name of FLOW_COLLECTIONS) {
      if ((await collections()).includes(name)) await db().collection(name).drop();
    }
    await migration().up(db());
    await migration().up(db());
    expect(await collections()).toEqual(expect.arrayContaining([...FLOW_COLLECTIONS]));
    const versionIndexes = await db().collection('flowVersions').indexes();
    expect(versionIndexes).toContainEqual(
      expect.objectContaining({ key: { flowId: 1, version: 1 }, unique: true }),
    );
    const runIndexes = await db().collection('flowRuns').indexes();
    expect(runIndexes).toContainEqual(
      expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
    );
  });

  it('refuses to roll back while flows or audio exist, else drops the collections', async () => {
    await migration().up(db());
    await db().collection('flows').insertOne({ name: 'x' });
    await expect(migration().down(db())).rejects.toThrow('0007-flows: refusing to roll back');
    await db().collection('flows').deleteMany({});
    await db().collection('flowAudio').insertOne({ name: 'x' });
    await expect(migration().down(db())).rejects.toThrow('refusing');
    await db().collection('flowAudio').deleteMany({});
    await migration().down(db());
    const left = await collections();
    for (const name of FLOW_COLLECTIONS) expect(left).not.toContain(name);
    await migration().down(db()); // nothing left to drop
    await migration().up(db()); // leave the collections for other suites in this file
  });
});
