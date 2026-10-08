/**
 * Database migrations: npm run db:migrate | db:migrate:down | db:migrate:status
 */
import mongoose from 'mongoose';

import { getEnv } from '../src/config/env';
import { migrateDown, migrateUp, migrationStatus } from '../src/db/migrate';
import { MIGRATIONS } from '../src/db/migrations';
import { connectMongo, disconnectMongo } from '../src/db/mongo';
import { getLogger } from '../src/shared/logger';

const main = async (): Promise<void> => {
  const command = process.argv[2] ?? 'status';
  const logger = getLogger();
  await connectMongo(getEnv(), logger);
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB connection has no database handle');
  try {
    if (command === 'up') {
      const applied = await migrateUp(db, MIGRATIONS, logger);
      console.info(
        applied.length ? `Applied: ${applied.join(', ')}` : 'Nothing to apply — up to date.',
      );
    } else if (command === 'down') {
      const reverted = await migrateDown(db, MIGRATIONS, logger);
      console.info(reverted ? `Reverted: ${reverted}` : 'Nothing to revert.');
    } else if (command === 'status') {
      const status = await migrationStatus(db, MIGRATIONS);
      console.info(
        `Applied: ${status.applied.join(', ') || '—'}\nPending: ${status.pending.join(', ') || '—'}`,
      );
    } else {
      throw new Error(`Unknown command "${command}" — use up | down | status`);
    }
  } finally {
    await disconnectMongo();
  }
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
