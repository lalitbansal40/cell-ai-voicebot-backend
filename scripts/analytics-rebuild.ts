/** Rollup recount (dev): npm run analytics:rebuild — the code lives in `src/ops/analytics-rebuild.ts` (also compiled for the image). */
import { main } from '../src/ops/analytics-rebuild';
import { runOp } from '../src/ops/cli';

runOp(main);
