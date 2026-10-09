import type { Db } from 'mongodb';

import type { Migration } from '../migrate';
import { DEFAULT_RATE_CARD } from '../models/rate-card.model';

export const AI_COLLECTIONS = [
  'aiAgents',
  'knowledgeBases',
  'knowledgeSources',
  'knowledgeChunks',
  'agentPlaygroundSessions',
  'agentToolCalls',
  'agentUsage',
  'mockPaymentRecords',
] as const;

const ensureCollection = async (db: Db, name: string) => {
  const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
  if (!exists) await db.createCollection(name);
};

/**
 * Phase 5: AI agent / knowledge / playground collections, and the two AI
 * prices on every rate-card row that predates them (those prices did not
 * exist before, so the defaults apply to the whole history).
 */
export const aiAgentsMigration: Migration = {
  name: '0006-ai-agents',
  up: async (db) => {
    for (const name of AI_COLLECTIONS) await ensureCollection(db, name);
    await db
      .collection('rateCards')
      .updateMany(
        { aiTextPer1kTokensMicros: { $exists: false } },
        { $set: { aiTextPer1kTokensMicros: DEFAULT_RATE_CARD.aiTextPer1kTokensMicros } },
      );
    await db
      .collection('rateCards')
      .updateMany(
        { embeddingPer1kTokensMicros: { $exists: false } },
        { $set: { embeddingPer1kTokensMicros: DEFAULT_RATE_CARD.embeddingPer1kTokensMicros } },
      );
  },
  down: async (db) => {
    const agents = await db.collection('aiAgents').countDocuments({}, { limit: 1 });
    const sources = await db.collection('knowledgeSources').countDocuments({}, { limit: 1 });
    if (agents || sources) {
      throw new Error(
        '0006-ai-agents: refusing to roll back — AI agents or knowledge sources exist',
      );
    }
    for (const name of AI_COLLECTIONS) {
      const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
      if (exists) await db.collection(name).drop();
    }
    // Rate-card rows keep the AI price fields (history is never rewritten on the way down).
  },
};
