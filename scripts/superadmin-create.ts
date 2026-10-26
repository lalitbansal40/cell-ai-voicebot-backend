/** Creates or updates a platform superadmin: npm run superadmin:create -- <email> [name] [--password-stdin] — the code lives in `src/ops/superadmin-create.ts` (also compiled for the image). */
import { runOp } from '../src/ops/cli';
import { main } from '../src/ops/superadmin-create';

runOp(main);
