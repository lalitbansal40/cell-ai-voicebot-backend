/**
 * `npm run storage:migrate-to-s3 -- [--dry-run] [--batch <n>]` (image: `node dist/ops/storage-migrate.js`):
 * copies local files to S3 and verifies each one (Phase 17). Run with `STORAGE_DRIVER=local` and the
 * S3 settings present; when it reports all files verified, set `STORAGE_DRIVER=s3` and release.
 * Counts only in its output, never file keys.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { getEnv } from '../config/env';
import { createStorage } from '../core/storage';
import { listLocalKeys, migrateStorage, type MigrateState } from '../core/storage/migrate';
import { S3Storage } from '../core/storage/s3.storage';
import { PlatformSettingsModel } from '../db/models/platform-settings.model';
import { connectMongo, disconnectMongo } from '../db/mongo';
import { getLogger } from '../shared/logger';

import { runOp, say, type OpMain } from './cli';

const STATE_PATH = 'value.storageMigration';

export const parseMigrateArgs = (args: string[]) => {
  const at = args.indexOf('--batch');
  const batch = at === -1 ? 200 : Number(args[at + 1]);
  if (!Number.isInteger(batch) || batch < 1 || batch > 5_000) {
    throw new Error('--batch takes a whole number from 1 to 5000');
  }
  return { dryRun: args.includes('--dry-run'), batch };
};

const loadState = async (): Promise<MigrateState> => {
  const row = await PlatformSettingsModel.findOne({ key: 'opsStatus' })
    .lean<{ value?: { storageMigration?: MigrateState } }>()
    .exec();
  return row?.value?.storageMigration ?? { lastKey: null, copied: 0, bytes: 0 };
};

export const main: OpMain = async (args) => {
  const options = parseMigrateArgs(args);
  const env = getEnv();
  if (env.STORAGE_DRIVER !== 'local') throw new Error('Run it while STORAGE_DRIVER=local');
  if (!env.S3_BUCKET || !env.S3_REGION) throw new Error('Set S3_BUCKET and S3_REGION first');
  await connectMongo(env, getLogger());
  try {
    const root = path.resolve(env.STORAGE_LOCAL_PATH);
    const result = await migrateStorage({
      keys: await listLocalKeys(root),
      source: createStorage(env),
      target: S3Storage.fromEnv(env),
      state: await loadState(),
      ...options,
      saveState: async (state) => {
        await PlatformSettingsModel.updateOne(
          { key: 'opsStatus' },
          { $set: { [STATE_PATH]: state } },
          { upsert: true },
        );
      },
      sizeOf: async (key) => (await stat(path.join(root, key))).size,
    });
    const mb = (result.bytes / 1_048_576).toFixed(1);
    if (options.dryRun) {
      say(`Dry run: ${String(result.total)} files, ${mb} MB still to copy`);
    } else if (result.done) {
      say(
        `All ${String(result.total)} files are on S3 and verified. Set STORAGE_DRIVER=s3 and release.`,
      );
    } else {
      say(`Stopped after ${String(result.copied)} files: one did not verify. Run it again.`);
      process.exitCode = 1;
    }
  } finally {
    await disconnectMongo();
  }
};

if (require.main === module) runOp(main);
