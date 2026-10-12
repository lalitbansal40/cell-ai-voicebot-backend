import { Types } from 'mongoose';

import { credit } from '../../src/core/billing/engine';
import { WebCallLeg, type MediaChannel } from '../../src/core/telephony/webcall';
import type { FakeClock } from '../../src/core/voice/clock';
import { DEFAULT_RATE_CARD, RateCardModel } from '../../src/db/models/rate-card.model';
import type { CallIO, CallScript, ScriptResult } from '../../src/modules/calls/session';

export const ensureRateCard = async () => {
  if (!(await RateCardModel.exists({ accountId: null }))) {
    await RateCardModel.create({
      accountId: null,
      ...DEFAULT_RATE_CARD,
      effectiveFrom: new Date(0),
    });
  }
};

export const fund = (accountId: Types.ObjectId | string, micros = 500_000_000) =>
  credit({
    accountId,
    type: 'adjustment',
    amountMicros: micros,
    ref: { type: 'manual', id: 'x' },
    idempotencyKey: `fund-${String(accountId)}-${String(micros)}-${new Types.ObjectId().toString()}`,
  });

/** Media channel that records what the server sent to the browser. */
export const fakeChannel = () => {
  const json: Record<string, unknown>[] = [];
  const binary: Buffer[] = [];
  const closed: [number, string][] = [];
  const channel: MediaChannel = {
    sendJson: (m) => json.push(m),
    sendBinary: (f) => binary.push(f),
    bufferedAmount: () => 0,
    close: (code, reason) => closed.push([code, reason]),
  };
  return { channel, json, binary, closed };
};

export const makeLeg = (clock: FakeClock) => {
  const c = fakeChannel();
  return { leg: new WebCallLeg(c.channel, clock), ...c };
};

/** Customer side of a web call: answers, streams quiet frames as time passes. */
export const answer = (leg: WebCallLeg) =>
  leg.receiveControl({ type: 'call.ready', sampleRate: 24000 });

export const emptyResult = (extra: Partial<ScriptResult> = {}): ScriptResult => ({
  outcome: {},
  disposition: null,
  variables: {},
  flowRunId: null,
  aiSeconds: 0,
  languageDetected: null,
  ...extra,
});

/** A script built from a function; `stopped` records why it was stopped. */
export const scriptOf = (
  run: (io: CallIO) => Promise<void | Parameters<CallIO['end']>[0]>,
  result: Partial<ScriptResult> = {},
): CallScript & { stopped: string[] } => {
  const stopped: string[] = [];
  return {
    stopped,
    run: (io) => run(io),
    stop: (reason) => {
      stopped.push(reason);
      return Promise.resolve();
    },
    result: () => emptyResult(result),
  };
};

/** Advances the fake clock in 20 ms steps while feeding customer frames. */
export const talk = async (clock: FakeClock, leg: WebCallLeg, ms: number, level = 0) => {
  for (let t = 0; t < ms; t += 20) {
    leg.receiveAudio(new Int16Array(480).fill(level));
    await clock.tick(20);
  }
};
