/** Index sync (dev): npm run db:sync-indexes — the code lives in `src/ops/sync-indexes.ts` (also compiled for the image). */
import { runOp } from '../src/ops/cli';
import { main } from '../src/ops/sync-indexes';

runOp(main);
