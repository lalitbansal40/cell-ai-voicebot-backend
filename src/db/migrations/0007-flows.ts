import type { Db } from 'mongodb';

import type { Migration } from '../migrate';
import { FlowAudioModel } from '../models/flow-audio.model';
import { FlowNodeStatsModel } from '../models/flow-node-stats.model';
import { FlowRunModel } from '../models/flow-run.model';
import { FlowVersionModel } from '../models/flow-version.model';
import { FlowModel } from '../models/flow.model';

export const FLOW_COLLECTIONS = [
  'flows',
  'flowVersions',
  'flowRuns',
  'flowNodeStats',
  'flowAudio',
] as const;

const FLOW_MODELS = [FlowModel, FlowVersionModel, FlowRunModel, FlowNodeStatsModel, FlowAudioModel];

const ensureCollection = async (db: Db, name: string) => {
  const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
  if (!exists) await db.createCollection(name);
};

/** Phase 6: call flow collections and their indexes (unique names, version numbers, TTL). */
export const flowsMigration: Migration = {
  name: '0007-flows',
  up: async (db) => {
    for (const name of FLOW_COLLECTIONS) await ensureCollection(db, name);
    for (const model of FLOW_MODELS) await model.createIndexes();
  },
  down: async (db) => {
    const flows = await db.collection('flows').countDocuments({}, { limit: 1 });
    const audio = await db.collection('flowAudio').countDocuments({}, { limit: 1 });
    if (flows || audio) {
      throw new Error('0007-flows: refusing to roll back — flows or flow audio exist');
    }
    for (const name of FLOW_COLLECTIONS) {
      const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
      if (exists) await db.collection(name).drop();
    }
  },
};
