import { createServer, type Server } from 'node:http';

import { createApp } from './app';
import { getEnv } from './config/env';
import { createLifecycle, type Lifecycle } from './core/lifecycle';
import { getLogger } from './shared/logger';

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

  const app = createApp({ env, logger });
  const server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(env.PORT, () => {
      server.off('error', reject);
      resolve();
    });
  });
  logger.info({ port: env.PORT }, `API listening on http://localhost:${env.PORT}`);

  // Later tasks register: ws 20, queues 30, redis 40, mongo 50.
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
