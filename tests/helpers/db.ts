import mongoose from 'mongoose';
import { afterAll, beforeAll } from 'vitest';

import { startTestMongo } from './mongo';

/**
 * Connects mongoose to a fresh database on the shared in-memory replica set
 * for this test file and builds the indexes of every registered model.
 * Import the models before calling it.
 */
export const useTestDb = (): void => {
  let stop: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const mongo = await startTestMongo();
    stop = mongo.stop;
    await mongoose.connect(mongo.uri);
    await mongoose.syncIndexes();
  });
  afterAll(async () => {
    await stop?.();
  });
};
