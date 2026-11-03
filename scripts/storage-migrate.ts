/** Uploads to S3 (dev): npm run storage:migrate-to-s3 — the code lives in `src/ops/storage-migrate.ts`. */
import { runOp } from '../src/ops/cli';
import { main } from '../src/ops/storage-migrate';

runOp(main);
