import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

/** In-memory single-node replica set (transactions work). One per test file. */
export const startTestMongo = async (): Promise<{ uri: string; stop: () => Promise<void> }> => {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri('cav_test');
  return {
    uri,
    stop: async () => {
      await mongoose.disconnect();
      await replSet.stop();
    },
  };
};
