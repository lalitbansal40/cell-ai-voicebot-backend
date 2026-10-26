/** Sends the system.test e-mail: npm run email:test -- you@example.com — the code lives in `src/ops/email-test.ts` (also compiled for the image). */
import { runOp } from '../src/ops/cli';
import { main } from '../src/ops/email-test';

runOp(main);
