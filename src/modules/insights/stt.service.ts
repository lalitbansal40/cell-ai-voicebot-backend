/**
 * `insights.stt` (Phase 14, ADR 0044): transcribes a recorded human call when the account
 * turned `transcribeHumanCalls` on — each side of the stereo recording is cut into speech
 * segments, each segment is one `stt` turn (customer / agent) at its real time; then the
 * insights run as usual. Charged per transcribed second (`stt-<callId>`), once.
 */
import type { Readable } from 'node:stream';

import { Types } from 'mongoose';

import { INSIGHTS_LIMITS } from '../../config/limits';
import { sttCost } from '../../core/ai/pricing';
import { chargeUsage } from '../../core/billing/engine';
import { effectiveRateCard } from '../../core/billing/rates';
import { getOrCreateWallet } from '../../core/billing/wallets';
import type { StorageProvider } from '../../core/storage';
import { sliceMs, speechSegments, splitStereo } from '../../core/voice/audio/segments';
import { wavBuffer } from '../../core/voice/audio/wav';
import { CallModel, type CallDoc } from '../../db/models/call.model';
import { TranscriptTurnModel } from '../../db/models/transcript-turn.model';
import { AppError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';

import {
  finishInsights,
  INSIGHT_JOBS,
  insightRunJobId,
  type InsightsDeps,
} from './insights.service';

export const sttJobId = (callId: string): string => `stt-${callId}`;

const readAll = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
};

export interface SttDeps extends InsightsDeps {
  storage?: StorageProvider;
  /** `OPENAI_TRANSCRIBE_MODEL`. */
  transcribeModel: string;
}

export const runStt = async (
  data: { accountId: string; callId: string },
  deps: SttDeps,
  attempt: { made: number; max: number } = { made: 0, max: 1 },
): Promise<{ status: string; reason?: string; turns?: number }> => {
  const now = deps.now?.() ?? new Date();
  const accountId = new Types.ObjectId(data.accountId);
  const call = await CallModel.findOne({ _id: data.callId, accountId }).lean<CallDoc>();
  if (call?.insights?.status !== 'pending' || call.insights.version !== 1)
    return { status: 'stale' };
  const recording = call.recording;
  if (!recording || recording.deletedAt || !deps.storage)
    return finishInsights(call, 1, 'skipped', 'no_recording', now);
  const wallet = await getOrCreateWallet(accountId);
  if (wallet.balanceMicros - wallet.holdMicros <= 0)
    return finishInsights(call, 1, 'skipped', 'low_balance', now);
  if (!deps.provider?.transcribe)
    throw new Error('AI transcription is not configured for the worker');

  let turns: { speaker: 'customer' | 'agent'; startMs: number; endMs: number; text: string }[] = [];
  let seconds = 0;
  try {
    const audio = splitStereo(await readAll(await deps.storage.get(recording.fileKey)));
    const options = {
      minMs: INSIGHTS_LIMITS.sttSegmentMinMs,
      maxMs: INSIGHTS_LIMITS.sttSegmentMaxSec * 1000,
    };
    const parts = [
      ...speechSegments(audio.left, audio.rate, options).map((s) => ({
        ...s,
        speaker: 'customer' as const,
        pcm: audio.left,
      })),
      ...speechSegments(audio.right, audio.rate, options).map((s) => ({
        ...s,
        speaker: 'agent' as const,
        pcm: audio.right,
      })),
    ]
      .sort((a, b) => a.startMs - b.startMs)
      .slice(0, INSIGHTS_LIMITS.sttMaxSegments);
    for (const part of parts) {
      const clip = sliceMs(part.pcm, audio.rate, part);
      const { text } = await deps.provider.transcribe({
        model: deps.transcribeModel,
        audio: wavBuffer(clip, audio.rate),
      });
      seconds += (part.endMs - part.startMs) / 1000;
      if (text)
        turns.push({
          speaker: part.speaker,
          startMs: part.startMs,
          endMs: part.endMs,
          text: text.slice(0, 4000),
        });
    }
  } catch (err) {
    if (attempt.made + 1 < attempt.max) throw err;
    getLogger().warn(
      { callId: data.callId, err: (err as Error).name },
      'insights: transcription failed',
    );
    return finishInsights(call, 1, 'failed', 'stt_failed', now);
  }

  const cost = sttCost(await effectiveRateCard(accountId), seconds);
  if (cost > 0) {
    try {
      await chargeUsage({
        accountId,
        type: 'ai_charge',
        amountMicros: cost,
        breakdown: {
          aiMicros: cost,
          aiSeconds: Math.ceil(seconds),
          model: deps.transcribeModel,
          kind: 'stt',
        },
        ref: { type: 'call', id: call._id.toString() },
        idempotencyKey: sttJobId(call._id.toString()),
      });
    } catch (err) {
      if (
        err instanceof AppError &&
        (err.code === 'WALLET_INSUFFICIENT_BALANCE' || err.code === 'WALLET_BUDGET_EXCEEDED')
      )
        return finishInsights(call, 1, 'skipped', 'low_balance', now);
      throw err;
    }
  }

  // a retry replaces what an earlier attempt wrote
  await TranscriptTurnModel.deleteMany({ accountId, callId: call._id, source: 'stt' });
  const last = await TranscriptTurnModel.findOne({ accountId, callId: call._id })
    .sort({ seq: -1 })
    .select({ seq: 1 })
    .lean<{ seq: number }>();
  turns = turns.sort((a, b) => a.startMs - b.startMs);
  if (turns.length)
    await TranscriptTurnModel.insertMany(
      turns.map((t, i) => ({
        accountId,
        callId: call._id,
        seq: (last?.seq ?? 0) + i + 1,
        speaker: t.speaker,
        text: t.text,
        startMs: t.startMs,
        endMs: t.endMs,
        source: 'stt',
      })),
    );
  const customer = turns.filter((t) => t.speaker === 'customer').length;
  if (customer < INSIGHTS_LIMITS.minCustomerTurns)
    return finishInsights(call, 1, 'skipped', 'too_short', now);
  await deps.jobs.enqueue(
    INSIGHT_JOBS.run,
    { accountId: data.accountId, callId: data.callId, version: 1 },
    { jobId: insightRunJobId(data.callId, 1) },
  );
  return { status: 'transcribed', turns: turns.length };
};
