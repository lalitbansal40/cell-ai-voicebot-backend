/**
 * Database migrations: `npm run db:migrate | db:migrate:down | db:migrate:status`, or in
 * the image `node dist/ops/migrate.js up | down | status`.
 */
import mongoose from 'mongoose';

import { getEnv } from '../config/env';
import { migrateDown, migrateUp, migrationStatus } from '../db/migrate';
import { MIGRATIONS } from '../db/migrations';
import { connectMongo, disconnectMongo } from '../db/mongo';
import { getLogger } from '../shared/logger';

import { runOp, say, type OpMain } from './cli';

export const main: OpMain = async (args) => {
  const command = args[0] ?? 'status';
  const logger = getLogger();
  await connectMongo(getEnv(), logger);
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB connection has no database handle');
  try {
    if (command === 'up') {
      const applied = await migrateUp(db, MIGRATIONS, logger);
      say(applied.length ? `Applied: ${applied.join(', ')}` : 'Nothing to apply — up to date.');
    } else if (command === 'down') {
      const reverted = await migrateDown(db, MIGRATIONS, logger);
      say(reverted ? `Reverted: ${reverted}` : 'Nothing to revert.');
    } else if (command === 'status') {
      const status = await migrationStatus(db, MIGRATIONS);
      say(
        `Applied: ${status.applied.join(', ') || '—'}\nPending: ${status.pending.join(', ') || '—'}`,
      );
    } else {
      throw new Error(`Unknown command "${command}" — use up | down | status`);
    }
  } finally {
    await disconnectMongo();
  }
};

if (require.main === module) runOp(main);
