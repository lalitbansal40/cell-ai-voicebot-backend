import { EnvValidationError } from './config/env';
import { startServer } from './server';

export { getAppInfo, type AppInfo } from './shared/app-info';

if (require.main === module) {
  startServer().catch((err: unknown) => {
    // The logger may not exist yet (invalid env) — print and exit.
    // eslint-disable-next-line no-console -- bootstrap failure before the logger is available
    console.error(err instanceof EnvValidationError ? err.message : err);
    process.exit(1);
  });
}
