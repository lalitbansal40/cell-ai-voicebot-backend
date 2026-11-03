import { readFile } from 'node:fs/promises';

import { getEnv } from '../config/env';
import { parseCdr, reconcileCdr } from '../core/telephony/sip/cdr';
import { CallModel } from '../db/models/call.model';
import { connectMongo, disconnectMongo } from '../db/mongo';
import { getLogger } from '../shared/logger';

import { say, type OpMain } from './cli';

/** `npm run sip:cdr-reconcile -- <cdr.csv>`: carrier minutes vs ours per day (report only). */
export const main: OpMain = async (args) => {
  const file = args.find((a) => !a.startsWith('-'));
  if (!file) throw new Error('Usage: sip:cdr-reconcile -- <cdr.csv>');
  const cdr = parseCdr(await readFile(file, 'utf8'));
  if (cdr.length === 0) throw new Error('No CDR rows with a date and seconds');
  const days = cdr.map((c) => c.day).sort();
  const env = getEnv();
  await connectMongo(env, getLogger());
  try {
    const from = new Date(`${days[0] as string}T00:00:00Z`);
    const to = new Date(`${days.at(-1) as string}T23:59:59.999Z`);
    const calls = await CallModel.find({
      provider: 'sip',
      'timestamps.answeredAt': { $gte: from, $lte: to },
    })
      .select({ 'timestamps.answeredAt': 1, durationSec: 1 })
      .lean<{ timestamps: { answeredAt: Date }; durationSec: number }[]>();
    const ours = calls.map((c) => ({
      day: c.timestamps.answeredAt.toISOString().slice(0, 10),
      seconds: c.durationSec,
    }));
    say('day         cdr calls  cdr min  our calls  our min  diff min');
    for (const r of reconcileCdr(cdr, ours)) {
      say(
        `${r.day}  ${String(r.cdrCalls).padStart(9)}  ${String(r.cdrMinutes).padStart(7)}  ${String(r.ourCalls).padStart(9)}  ${String(r.ourMinutes).padStart(7)}  ${String(r.diffMinutes).padStart(8)}`,
      );
    }
  } finally {
    await disconnectMongo();
  }
};
