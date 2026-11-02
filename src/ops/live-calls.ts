/**
 * Waits for live calls to end before a release stops the API (Phase 17, ADR 0049): a stopped
 * API ends its calls with the technical line. `node dist/ops/live-calls.js [--wait <seconds>]`
 * prints the count once, or polls until it reaches 0 or the wait runs out. Exits 0 either way:
 * calls still live after the wait are ended politely by the shutdown code.
 */
import { getEnv } from '../config/env';
import { CALL_LIMITS } from '../config/limits';
import { CallModel, LIVE_CALL_STATUSES } from '../db/models/call.model';
import { connectMongo, disconnectMongo } from '../db/mongo';
import { getLogger } from '../shared/logger';

import { runOp, say, type OpMain } from './cli';

/** A call queued or ringing for longer than this is stale, not live. */
const STALE_MS = 2 * 3_600_000;
const POLL_MS = 5_000;

export const countLiveCalls = (now = new Date()): Promise<number> =>
  CallModel.countDocuments({
    status: { $in: LIVE_CALL_STATUSES },
    createdAt: {
      $gte: new Date(now.getTime() - Math.max(STALE_MS, CALL_LIMITS.maxCallSecHard * 1000)),
    },
  });

export const parseWait = (args: string[]): number => {
  const at = args.indexOf('--wait');
  if (at === -1) return 0;
  const seconds = Number(args[at + 1]);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3_600) {
    throw new Error('--wait takes whole seconds from 0 to 3600');
  }
  return seconds;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls until no call is live or `waitSec` runs out; returns the last count. */
export const waitForLiveCalls = async (
  waitSec: number,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<number> => {
  const deadline = Date.now() + waitSec * 1000;
  let live = await countLiveCalls();
  while (live > 0 && Date.now() < deadline) {
    say(`${String(live)} live calls; waiting`);
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
    live = await countLiveCalls();
  }
  return live;
};

export const main: OpMain = async (args) => {
  const waitSec = parseWait(args);
  await connectMongo(getEnv(), getLogger());
  try {
    const live = await waitForLiveCalls(waitSec);
    say(
      live === 0
        ? 'Live calls: 0'
        : `${String(live)} calls still live after ${String(waitSec)} s; they end politely at shutdown`,
    );
  } finally {
    await disconnectMongo();
  }
};

if (require.main === module) runOp(main);
