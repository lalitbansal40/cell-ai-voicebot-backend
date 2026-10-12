import type { Db } from 'mongodb';

import { CALL_LINES } from '../../config/limits';
import type { Migration } from '../migrate';
import { CallEventModel } from '../models/call-event.model';
import { CallModel } from '../models/call.model';
import { FlowRunModel } from '../models/flow-run.model';
import { TranscriptTurnModel } from '../models/transcript-turn.model';
import { TtsCacheModel } from '../models/tts-cache.model';

export const CALL_COLLECTIONS = ['calls', 'callEvents', 'transcriptTurns', 'ttsCache'] as const;

const CALL_MODELS = [CallModel, CallEventModel, TranscriptTurnModel, TtsCacheModel];

const ensureCollection = async (db: Db, name: string) => {
  const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
  if (!exists) await db.createCollection(name);
};

/** Phase 7: call collections + indexes, `flowRuns.callId`, account recording notice default. */
export const callsMigration: Migration = {
  name: '0008-calls',
  up: async (db) => {
    for (const name of CALL_COLLECTIONS) await ensureCollection(db, name);
    for (const model of CALL_MODELS) await model.createIndexes();
    await FlowRunModel.createIndexes();
    await db
      .collection('accounts')
      .updateMany(
        { 'settings.recordingNotice': { $exists: false } },
        { $set: { 'settings.recordingNotice': CALL_LINES.recordingNotice } },
      );
  },
  down: async (db) => {
    const calls = await db.collection('calls').countDocuments({}, { limit: 1 });
    if (calls) throw new Error('0008-calls: refusing to roll back — calls exist');
    for (const name of CALL_COLLECTIONS) {
      const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
      if (exists) await db.collection(name).drop();
    }
    await db.collection('accounts').updateMany({}, { $unset: { 'settings.recordingNotice': '' } });
  },
};
