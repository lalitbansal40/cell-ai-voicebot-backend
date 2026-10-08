import type { Logger } from '../shared/logger';

export type ShutdownHook = () => Promise<void> | void;

export interface LifecycleOptions {
  /** Hard limit for the whole shutdown. */
  timeoutMs?: number;
  /** Injectable for tests. */
  exit?: (code: number) => void;
}

export interface Lifecycle {
  /** Lower `order` runs first: http 10, ws 20, queues 30, email 35, redis 40, mongo 50. */
  onShutdown: (name: string, hook: ShutdownHook, order?: number) => void;
  shutdown: (reason: string, exitCode?: number) => Promise<void>;
  installSignalHandlers: () => void;
  /** True as soon as shutdown starts — readiness reports 503 from then on. */
  isShuttingDown: () => boolean;
}

/**
 * Ordered, idempotent graceful shutdown with a hard timeout. Every hook is
 * awaited in turn; a failing hook is logged and the rest still run.
 */
export const createLifecycle = (logger: Logger, options: LifecycleOptions = {}): Lifecycle => {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const hooks: { name: string; hook: ShutdownHook; order: number }[] = [];
  let shuttingDown: Promise<void> | undefined;
  let signalsInstalled = false;

  const runHooks = async (): Promise<void> => {
    for (const { name, hook } of [...hooks].sort((a, b) => a.order - b.order)) {
      try {
        logger.info({ hook: name }, 'shutdown: running hook');
        await hook();
      } catch (err) {
        logger.error({ err, hook: name }, 'shutdown: hook failed');
      }
    }
  };

  const shutdown = (reason: string, exitCode = 0): Promise<void> => {
    shuttingDown ??= (async () => {
      logger.info({ reason }, 'shutdown: started');
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
        timer.unref();
      });
      const result = await Promise.race([runHooks().then(() => 'done' as const), timedOut]);
      clearTimeout(timer);
      if (result === 'timeout') {
        logger.fatal({ timeoutMs }, 'shutdown: timed out, forcing exit');
        exit(1);
        return;
      }
      logger.info('shutdown: complete');
      exit(exitCode);
    })();
    return shuttingDown;
  };

  const installSignalHandlers = (): void => {
    if (signalsInstalled) return;
    signalsInstalled = true;
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => void shutdown(signal, 0));
    }
    process.on('unhandledRejection', (reason) => {
      logger.fatal({ err: reason }, 'unhandledRejection');
      void shutdown('unhandledRejection', 1);
    });
    process.on('uncaughtException', (err) => {
      logger.fatal({ err }, 'uncaughtException');
      void shutdown('uncaughtException', 1);
    });
  };

  return {
    onShutdown: (name, hook, order = 100) => {
      hooks.push({ name, hook, order });
    },
    shutdown,
    installSignalHandlers,
    isShuttingDown: () => shuttingDown !== undefined,
  };
};
