/** Key rotation (dev): npm run keys:reseal — the code lives in `src/ops/keys-reseal.ts` (also compiled for the image). */
import { runOp } from '../src/ops/cli';
import { main } from '../src/ops/keys-reseal';

runOp(main);
