import { createServer, type Server } from 'node:http';

import { createApp } from './app';
import { getEnv } from './config/env';
import { createEmailProvider, createEmailService, setEmail, type EmailJobData } from './core/email';
import { createLifecycle, type Lifecycle } from './core/lifecycle';
import { QUEUES } from './core/queues/names';
import { closeAllQueues, createQueue } from './core/queues/queue-factory';
import {
  closeAllRedis,
  createSubscriber,
  getAppRedis,
  pingRedis,
  redactRedisUrl,
} from './core/queues/redis';
import { startEmailWorker } from './core/queues/workers/email.worker';
import { startSystemWorker } from './core/queues/workers/system.worker';
import { createRealtime, setRealtime } from './core/realtime';
import { createStorage } from './core/storage';
import {
  connectMongo,
  disconnectMongo,
  pingMongo,
  redactMongoUri,
  syncAllIndexes,
} from './db/mongo';
import { getLogger } from './shared/logger';
import { createRedisRateLimitStore } from './shared/middlewares/rate-limit';

export interface RunningServer {
  server: Server;
  lifecycle: Lifecycle;
}

const FORCE_CLOSE_AFTER_MS = 5_000;

/** Validates env, builds the app, listens and wires graceful shutdown. */
export const startServer = async (): Promise<RunningServer> => {
  const env = getEnv();
  const logger = getLogger();
  const lifecycle = createLifecycle(logger);

  try {
    await connectMongo(env, logger);
  } catch (err) {
    logger.fatal(
      { err, target: redactMongoUri(env.MONGODB_URI) },
      'MongoDB not reachable — run "npm run infra:up"',
    );
    throw err;
  }
  lifecycle.onShutdown('mongo', disconnectMongo, 50);
  if (env.NODE_ENV !== 'production') await syncAllIndexes(logger);

  const redis = getAppRedis(env.REDIS_URL, logger);
  lifecycle.onShutdown('redis', closeAllRedis, 40);
  if (!(await pingRedis(redis, 5000))) {
    logger.fatal(
      { target: redactRedisUrl(env.REDIS_URL) },
      'Redis not reachable — run "npm run infra:up"',
    );
    throw new Error('Redis not reachable');
  }
  lifecycle.onShutdown('queues', closeAllQueues, 30);

  const emailProvider = createEmailProvider(env, logger);
  setEmail(
    createEmailService({
      provider: emailProvider,
      queue: createQueue<EmailJobData>(QUEUES.email, { redisUrl: env.REDIS_URL, logger }),
      logger,
    }),
  );
  lifecycle.onShutdown(
    'email',
    async () => {
      await emailProvider.close();
      setEmail(undefined);
    },
    35,
  );
  if (emailProvider.driver === 'smtp') {
    // Non-blocking: a slow/broken SMTP server must not stop the API (jobs retry).
    void emailProvider.verify().then((ok) => {
      if (ok) logger.info('email: smtp ready');
      else logger.warn('email: smtp verify failed — queued emails will retry');
    });
  } else {
    logger.info(`email: ${emailProvider.driver} driver (emails are logged, not sent)`);
  }

  const app = createApp({
    env,
    logger,
    rateLimitStore: createRedisRateLimitStore(redis),
    storage: createStorage(env, logger),
    readiness: {
      checks: { mongo: () => pingMongo(), redis: () => pingRedis(redis) },
      isShuttingDown: lifecycle.isShuttingDown,
    },
  });
  const server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(env.PORT, () => {
      server.off('error', reject);
      resolve();
    });
  });
  logger.info({ port: env.PORT }, `API listening on http://localhost:${env.PORT}`);

  if (env.WORKERS_ENABLED) {
    await startSystemWorker({ redisUrl: env.REDIS_URL, logger });
    startEmailWorker({ redisUrl: env.REDIS_URL, logger, provider: emailProvider });
    logger.info('workers: started');
  }

  const realtime = await createRealtime({
    server,
    redis,
    subscriber: createSubscriber(env.REDIS_URL, logger),
    logger,
  });
  setRealtime(realtime);
  lifecycle.onShutdown(
    'ws',
    async () => {
      await realtime.close();
      setRealtime(undefined);
    },
    20,
  );
  lifecycle.onShutdown(
    'http',
    () =>
      new Promise<void>((resolve) => {
        const force = setTimeout(() => server.closeAllConnections(), FORCE_CLOSE_AFTER_MS);
        force.unref();
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        server.closeIdleConnections();
      }),
    10,
  );
  lifecycle.installSignalHandlers();

  return { server, lifecycle };
};
