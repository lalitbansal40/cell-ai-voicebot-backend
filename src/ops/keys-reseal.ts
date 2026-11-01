/**
 * `npm run keys:reseal -- [--dry-run] [--batch <n>]` (image: `node dist/ops/keys-reseal.js`):
 * moves every sealed value to the current ENCRYPTION_KEY. Safe to stop and run again: each value
 * is re-read and written only if it still needs moving and hasn't changed since it was read.
 * Prints counts per field, never a value.
 */
import type { Types } from 'mongoose';

import '../db/models/all';
import { getEnv } from '../config/env';
import { AccountModel } from '../db/models/account.model';
import { connectMongo, disconnectMongo } from '../db/mongo';
import { recordAudit } from '../modules/audit/audit.service';
import {
  projectionRoot,
  readSealedValues,
  SEALED_FIELDS,
  type SealedField,
} from '../shared/crypto/sealed-registry';
import {
  isSealedWithCurrent,
  open,
  seal,
  secretKeys,
  type SecretKeys,
} from '../shared/crypto/secret-box';
import { getLogger } from '../shared/logger';

import { runOp, say, type OpMain } from './cli';

export interface ResealArgs {
  dryRun: boolean;
  batch: number;
}

export const DEFAULT_RESEAL_BATCH = 200;

export const parseResealArgs = (args: string[]): ResealArgs => {
  const out: ResealArgs = { dryRun: false, batch: DEFAULT_RESEAL_BATCH };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = Number(args[i + 1]);
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--batch' && Number.isInteger(value) && value > 0) {
      out.batch = value;
      i += 1;
    } else throw new Error('Usage: keys:reseal [--dry-run] [--batch <n>]');
  }
  return out;
};

export interface FieldCounts {
  name: string;
  /** Values looked at. */
  seen: number;
  /** Already on the current key. */
  current: number;
  /** Moved (or, in a dry run, would be moved). */
  moved: number;
  /** Couldn't be opened with the configured keys: left exactly as they were. */
  failed: number;
}

/** Stops a run in tests; called after each document is finished. */
export type ResealHook = (fieldName: string) => void | Promise<void>;

const resealField = async (
  field: SealedField,
  keys: SecretKeys,
  options: ResealArgs,
  onDoc?: ResealHook,
): Promise<FieldCounts> => {
  const counts: FieldCounts = { name: field.name, seen: 0, current: 0, moved: 0, failed: 0 };
  const collection = field.collection();
  const root = projectionRoot(field.path);
  let after: Types.ObjectId | null = null;
  for (;;) {
    const page = await collection
      .find({ ...(after ? { _id: { $gt: after } } : {}), [root]: { $exists: true, $ne: null } })
      .project<{ _id: Types.ObjectId }>({ [root]: 1 })
      .sort({ _id: 1 })
      .limit(options.batch)
      .toArray();
    for (const doc of page) {
      for (const { path, value } of readSealedValues(doc, field.path)) {
        counts.seen += 1;
        if (isSealedWithCurrent(keys, value)) {
          counts.current += 1;
          continue;
        }
        let plain: string;
        try {
          plain = open(keys, value);
        } catch {
          counts.failed += 1;
          continue;
        }
        counts.moved += 1;
        if (options.dryRun) continue;
        // only if it's still the value we read: a concurrent save wins, and it's already current
        await collection.updateOne(
          { _id: doc._id, [path]: value },
          { $set: { [path]: seal(keys, plain) } },
        );
      }
      await onDoc?.(field.name);
    }
    const last = page.at(-1);
    if (!last || page.length < options.batch) break;
    after = last._id;
  }
  return counts;
};

export const resealAll = async (
  keys: SecretKeys,
  options: ResealArgs,
  onDoc?: ResealHook,
): Promise<FieldCounts[]> => {
  const results: FieldCounts[] = [];
  for (const field of SEALED_FIELDS) results.push(await resealField(field, keys, options, onDoc));
  return results;
};

/** The platform account's audit log holds this run: counts only. */
export const auditRun = async (results: FieldCounts[]): Promise<void> => {
  const platform = await AccountModel.findOne({ isPlatform: true }).select({ _id: 1 }).lean();
  if (!platform) return;
  await recordAudit({
    accountId: platform._id,
    actor: { type: 'system', id: null, platform: true },
    action: 'keys.resealed',
    meta: {
      moved: results.reduce((sum, r) => sum + r.moved, 0),
      failed: results.reduce((sum, r) => sum + r.failed, 0),
    },
  });
};

export const main: OpMain = async (args) => {
  const options = parseResealArgs(args);
  const env = getEnv();
  const logger = getLogger();
  await connectMongo(env, logger);
  try {
    const results = await resealAll(secretKeys(env, logger), options);
    for (const r of results) {
      say(
        `${r.name}: ${String(r.seen)} seen, ${String(r.current)} current, ${String(r.moved)} ${options.dryRun ? 'to move' : 'moved'}, ${String(r.failed)} failed`,
      );
    }
    const moved = results.reduce((sum, r) => sum + r.moved, 0);
    const failed = results.reduce((sum, r) => sum + r.failed, 0);
    say(
      `${options.dryRun ? 'Dry run' : 'Re-seal'}: ${String(moved)} to the current key, ${String(failed)} failed`,
    );
    if (!options.dryRun && moved > 0) await auditRun(results);
    if (failed > 0) {
      throw new Error(
        'Some values could not be opened: add the missing key to ENCRYPTION_KEYS_OLD',
      );
    }
  } finally {
    await disconnectMongo();
  }
};

if (require.main === module) runOp(main);
