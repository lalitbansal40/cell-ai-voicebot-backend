import { randomBytes } from 'node:crypto';

import mongoose from 'mongoose';
import { inject } from 'vitest';

/**
 * A unique database on the shared in-memory replica set started by
 * tests/setup/mongo.global.ts (transactions work). `stop()` disconnects
 * mongoose and drops the database.
 */
export const startTestMongo = (): Promise<{ uri: string; stop: () => Promise<void> }> => {
  const dbName = `cav_test_${randomBytes(4).toString('hex')}`;
  const uri = inject('mongoUriTemplate').replace('__DB__', dbName);
  return Promise.resolve({
    uri,
    stop: async () => {
      if (mongoose.connection.readyState !== mongoose.ConnectionStates.connected) {
        await mongoose.connect(uri);
      }
      await mongoose.connection.dropDatabase().catch(() => undefined);
      await mongoose.disconnect();
    },
  });
};
