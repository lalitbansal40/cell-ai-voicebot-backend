/** Database migrations (dev): npm run db:migrate | db:migrate:down | db:migrate:status — the code lives in `src/ops/migrate.ts` (also compiled for the image). */
import { runOp } from '../src/ops/cli';
import { main } from '../src/ops/migrate';

runOp(main);
