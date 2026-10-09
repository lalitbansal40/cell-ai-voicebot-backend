import { createApp, type AppDeps } from '../../src/app';
import { loadEnv, type Env } from '../../src/config/env';
import { createLogger } from '../../src/shared/logger';

/** Test env: defaults + overrides, silent logs. */
export const testEnv = (overrides: NodeJS.ProcessEnv = {}): Env =>
  loadEnv({ NODE_ENV: 'test', ...overrides });

/** The real app with a silent logger. */
export const buildTestApp = (
  overrides: NodeJS.ProcessEnv = {},
  deps: Pick<
    AppDeps,
    'rateLimit' | 'authRateLimit' | 'storage' | 'contactJobs' | 'payments' | 'billingJobs'
  > = {},
) => {
  const env = testEnv(overrides);
  return createApp({ env, logger: createLogger(env), ...deps });
};
