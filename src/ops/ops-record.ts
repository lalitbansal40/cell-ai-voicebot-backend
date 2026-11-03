/**
 * Records ops events for Admin → System and healthwatch (Phase 17):
 *   node dist/ops/ops-record.js backup --ok|--failed --bytes <n>
 *   node dist/ops/ops-record.js restore-drill --rto-minutes <n>
 *   node dist/ops/ops-record.js release --tag <tag> --backend <sha> --frontend <sha>
 * Prints one line; never secrets.
 */
import { getEnv } from '../config/env';
import { connectMongo, disconnectMongo } from '../db/mongo';
import { recordBackup, recordRelease, recordRestoreDrill } from '../modules/ops/ops-status';
import { getLogger } from '../shared/logger';

import { runOp, say, type OpMain } from './cli';

const SHA = /^[a-f0-9]{40}$/;
const TAG = /^release-\d{8}-[a-f0-9]{7}$/;

export type OpsRecord =
  | { kind: 'backup'; ok: boolean; bytes: number }
  | { kind: 'restore-drill'; rtoMinutes: number }
  | { kind: 'release'; tag: string; backend: string; frontend: string };

export const parseOpsRecord = (args: string[]): OpsRecord => {
  const value = (name: string) => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? undefined : args[at + 1];
  };
  const whole = (name: string, max: number) => {
    const n = Number(value(name));
    if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`--${name} takes a whole number`);
    return n;
  };
  switch (args[0]) {
    case 'backup':
      if (args.includes('--ok') === args.includes('--failed')) {
        throw new Error('backup takes --ok or --failed');
      }
      return {
        kind: 'backup',
        ok: args.includes('--ok'),
        bytes: whole('bytes', Number.MAX_SAFE_INTEGER),
      };
    case 'restore-drill':
      return { kind: 'restore-drill', rtoMinutes: whole('rto-minutes', 10_000) };
    case 'release': {
      const tag = value('tag') ?? '';
      const backend = value('backend') ?? '';
      const frontend = value('frontend') ?? '';
      if (!TAG.test(tag) || !SHA.test(backend) || !SHA.test(frontend)) {
        throw new Error(
          'release takes --tag release-YYYYMMDD-<sha7> --backend <sha> --frontend <sha>',
        );
      }
      return { kind: 'release', tag, backend, frontend };
    }
    default:
      throw new Error('Usage: ops-record backup|restore-drill|release …');
  }
};

export const main: OpMain = async (args) => {
  const record = parseOpsRecord(args);
  await connectMongo(getEnv(), getLogger());
  try {
    const now = new Date();
    if (record.kind === 'backup') await recordBackup(now, record.ok, record.bytes);
    else if (record.kind === 'restore-drill') await recordRestoreDrill(now, record.rtoMinutes);
    else await recordRelease(now, record);
    say(`Recorded ${record.kind}`);
  } finally {
    await disconnectMongo();
  }
};

if (require.main === module) runOp(main);
