/** Builds/updates indexes for every registered model (production deploy step): npm run db:sync-indexes */
import { getEnv } from '../src/config/env';
import { connectMongo, disconnectMongo, syncAllIndexes } from '../src/db/mongo';
import { getLogger } from '../src/shared/logger';

const main = async (): Promise<void> => {
  const logger = getLogger();
  await connectMongo(getEnv(), logger);
  try {
    await syncAllIndexes(logger);
  } finally {
    await disconnectMongo();
  }
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
