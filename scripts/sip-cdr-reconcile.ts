/** Trunk CDR vs our SIP minutes (dev): npm run sip:cdr-reconcile -- <file.csv> — code in `src/ops/sip-cdr-reconcile.ts`. */
import { runOp } from '../src/ops/cli';
import { main } from '../src/ops/sip-cdr-reconcile';

runOp(main);
