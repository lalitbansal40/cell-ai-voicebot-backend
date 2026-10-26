/** Builds / updates indexes for every registered model (deploy step): `npm run db:sync-indexes` or `node dist/ops/sync-indexes.js`. */
import { getEnv } from '../config/env';
import { connectMongo, disconnectMongo, syncAllIndexes } from '../db/mongo';
import { getLogger } from '../shared/logger';

import { runOp, type OpMain } from './cli';

export const main: OpMain = async () => {
  const logger = getLogger();
  await connectMongo(getEnv(), logger);
  try {
    await syncAllIndexes(logger);
  } finally {
    await disconnectMongo();
  }
};

if (require.main === module) runOp(main);
