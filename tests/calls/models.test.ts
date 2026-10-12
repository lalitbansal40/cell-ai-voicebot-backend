import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { CallEventImmutableError, CallEventModel } from '../../src/db/models/call-event.model';
import { CallModel, emptyCallCost, emptyCallMetrics } from '../../src/db/models/call.model';
import { TranscriptTurnModel } from '../../src/db/models/transcript-turn.model';
import { useTestDb } from '../helpers/db';

useTestDb();

const accountId = new Types.ObjectId();

describe('call models', () => {
  it('a web test call gets empty metrics, cost and sequence counters', async () => {
    const call = await CallModel.create({
      accountId,
      direction: 'outbound',
      provider: 'webcall',
      from: 'webcall',
      to: 'webcall:user',
      isTest: true,
      source: { kind: 'agent', agentId: new Types.ObjectId() },
      timestamps: { queuedAt: new Date() },
    });
    expect(call.status).toBe('queued');
    expect(call.metrics).toEqual(emptyCallMetrics());
    expect(call.cost).toEqual(emptyCallCost());
    expect(call.seq).toEqual({ events: 0, transcript: 0 });
    expect(call.recording).toBeNull();
    expect(call.outcome).toEqual({});
    await expect(
      CallModel.create({
        accountId,
        direction: 'outbound',
        provider: 'pigeon' as never,
        from: 'a',
        to: 'b',
        source: { kind: 'agent' },
        timestamps: { queuedAt: new Date() },
      }),
    ).rejects.toThrow();
  });

  it('call events are append-only', async () => {
    const callId = new Types.ObjectId();
    const event = await CallEventModel.create({
      accountId,
      callId,
      seq: 1,
      type: 'status',
      data: { status: 'ringing' },
      at: new Date(),
    });
    await expect(CallEventModel.updateOne({ _id: event._id }, { seq: 2 })).rejects.toThrow(
      CallEventImmutableError,
    );
    await expect(CallEventModel.updateMany({}, { seq: 2 })).rejects.toThrow(
      CallEventImmutableError,
    );
    await expect(CallEventModel.findOneAndUpdate({ _id: event._id }, { seq: 3 })).rejects.toThrow(
      CallEventImmutableError,
    );
    await expect(CallEventModel.findOneAndReplace({ _id: event._id }, { seq: 3 })).rejects.toThrow(
      CallEventImmutableError,
    );
    await expect(CallEventModel.replaceOne({ _id: event._id }, { seq: 3 })).rejects.toThrow(
      CallEventImmutableError,
    );
    event.seq = 9;
    await expect(event.save()).rejects.toThrow('Call events are immutable');
    await expect(
      CallEventModel.create({ accountId, callId, seq: 1, type: 'dtmf', at: new Date() }),
    ).rejects.toThrow(); // unique (callId, seq)
    expect((await CallEventModel.deleteOne({ _id: event._id })).deletedCount).toBe(1);
  });

  it('transcript turns default to not interrupted, no language', async () => {
    const turn = await TranscriptTurnModel.create({
      accountId,
      callId: new Types.ObjectId(),
      seq: 1,
      speaker: 'bot',
      text: 'Namaste',
      source: 'tts',
    });
    expect(turn).toMatchObject({ interrupted: false, language: null, startMs: 0, endMs: 0 });
  });
});
