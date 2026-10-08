import type { Db } from 'mongodb';

import type { Logger } from '../shared/logger';

export interface Migration {
  name: string;
  up(db: Db): Promise<void>;
  down(db: Db): Promise<void>;
}

interface AppliedMigration {
  name: string;
  appliedAt: Date;
}

interface MigrationLock {
  _id: string;
  at: Date;
}

const STALE_LOCK_MS = 10 * 60_000;

const applied = (db: Db) => db.collection<AppliedMigration>('migrations');
const locks = (db: Db) => db.collection<MigrationLock>('migrationLocks');

const isDuplicateKey = (err: unknown): boolean => (err as { code?: number }).code === 11000;

/** Single-runner lock; a lock older than 10 minutes is considered stale and taken over. */
const withLock = async <T>(db: Db, logger: Logger, fn: () => Promise<T>): Promise<T> => {
  try {
    await locks(db).insertOne({ _id: 'lock', at: new Date() });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    const taken = await locks(db).findOneAndUpdate(
      { _id: 'lock', at: { $lt: new Date(Date.now() - STALE_LOCK_MS) } },
      { $set: { at: new Date() } },
    );
    if (!taken) throw new Error('Migrations already running (lock held)');
    logger.warn('migrations: took over a stale lock');
  }
  try {
    return await fn();
  } finally {
    await locks(db).deleteOne({ _id: 'lock' });
  }
};

const ensureIndex = async (db: Db) => {
  await applied(db).createIndex({ name: 1 }, { unique: true });
};

export const migrationStatus = async (
  db: Db,
  migrations: Migration[],
): Promise<{ applied: string[]; pending: string[] }> => {
  const done = new Set((await applied(db).find().toArray()).map((m) => m.name));
  return {
    applied: migrations.filter((m) => done.has(m.name)).map((m) => m.name),
    pending: migrations.filter((m) => !done.has(m.name)).map((m) => m.name),
  };
};

/** Applies all pending migrations in order. Returns the names applied. */
export const migrateUp = (db: Db, migrations: Migration[], logger: Logger): Promise<string[]> =>
  withLock(db, logger, async () => {
    await ensureIndex(db);
    const { pending } = await migrationStatus(db, migrations);
    for (const name of pending) {
      const migration = migrations.find((m) => m.name === name) as Migration;
      logger.info({ migration: name }, 'migrations: applying');
      await migration.up(db);
      await applied(db).insertOne({ name, appliedAt: new Date() });
    }
    return pending;
  });

/** Reverts the most recently applied migration. Returns its name, or undefined. */
export const migrateDown = (
  db: Db,
  migrations: Migration[],
  logger: Logger,
): Promise<string | undefined> =>
  withLock(db, logger, async () => {
    const last = await applied(db).find().sort({ appliedAt: -1, _id: -1 }).limit(1).next();
    if (!last) return undefined;
    const migration = migrations.find((m) => m.name === last.name);
    if (!migration) throw new Error(`Applied migration ${last.name} is not in the registry`);
    logger.info({ migration: last.name }, 'migrations: reverting');
    await migration.down(db);
    await applied(db).deleteOne({ name: last.name });
    return last.name;
  });
