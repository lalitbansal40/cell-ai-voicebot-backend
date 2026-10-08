import mongoose from 'mongoose';

import type { Env } from '../config/env';
import type { Logger } from '../shared/logger';

/** True while we close the connection on purpose — avoids warn-level noise on shutdown. */
let closing = false;

/** Host + db only — never log credentials or query options. */
export const redactMongoUri = (uri: string): string => {
  const match = /^(mongodb(?:\+srv)?:\/\/)(?:[^@/]*@)?([^/?]+)(\/[^?]*)?/.exec(uri);
  if (!match) return 'mongodb://<invalid>';
  return `${match[1]}${match[2]}${match[3] ?? ''}`;
};

/** Connects the default mongoose connection (ADR 0004 — replica set). */
export const connectMongo = async (
  env: Pick<Env, 'MONGODB_URI' | 'NODE_ENV'>,
  logger: Logger,
): Promise<typeof mongoose> => {
  const target = redactMongoUri(env.MONGODB_URI);
  mongoose.set('strictQuery', true);
  const conn = mongoose.connection;
  conn.removeAllListeners('connected');
  conn.removeAllListeners('disconnected');
  conn.removeAllListeners('reconnected');
  conn.removeAllListeners('error');
  conn.on('connected', () => logger.info({ target }, 'mongo: connected'));
  conn.on('disconnected', () => {
    if (closing) logger.info({ target }, 'mongo: closed');
    else logger.warn({ target }, 'mongo: disconnected');
  });
  conn.on('reconnected', () => logger.info({ target }, 'mongo: reconnected'));
  conn.on('error', (err: unknown) => logger.error({ err, target }, 'mongo: error'));

  closing = false;
  return mongoose.connect(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 20,
    autoIndex: env.NODE_ENV !== 'production',
  });
};

export const disconnectMongo = async (): Promise<void> => {
  closing = true;
  await mongoose.disconnect();
};

/** True when the server answers a ping within `timeoutMs`. Never throws. */
export const pingMongo = async (timeoutMs = 2000): Promise<boolean> => {
  const db = mongoose.connection.db;
  if (mongoose.connection.readyState !== mongoose.ConnectionStates.connected || !db) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const ping = db
      .admin()
      .command({ ping: 1 })
      .then((r) => r.ok === 1)
      .catch(() => false);
    return await Promise.race([ping, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/** Builds every registered model's indexes (dev/test at startup; prod via `npm run db:sync-indexes`). */
export const syncAllIndexes = async (logger: Logger): Promise<void> => {
  const names = mongoose.modelNames();
  await mongoose.syncIndexes();
  logger.info({ models: names.length }, `mongo: indexes synced for ${names.length} models`);
};
