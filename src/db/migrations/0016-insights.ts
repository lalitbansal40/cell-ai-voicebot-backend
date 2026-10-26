import type { Migration } from '../migrate';
import { DEFAULT_DISPOSITIONS, DEFAULT_INSIGHTS_SETTINGS } from '../models/account.model';
import { CallInsightModel } from '../models/call-insight.model';
import { CallModel } from '../models/call.model';
import { DEFAULT_RATE_CARD } from '../models/rate-card.model';

export const INSIGHTS_DUE_INDEX = 'insights_due';
export const BEFORE_INSIGHTS = 'before_insights';

/**
 * Phase 14 post-call AI: every account gets the insights settings and the default
 * call outcomes; calls that ended before this release are marked `skipped:
 * before_insights` (never charged retroactively — "Regenerate" still works); outcomes
 * already set by a flow / AI agent get their source. Additive and idempotent.
 */
export const insightsMigration: Migration = {
  name: '0016-insights',
  up: async (db) => {
    const accounts = db.collection('accounts');
    await accounts.updateMany(
      { 'settings.insights': { $exists: false } },
      { $set: { 'settings.insights': { ...DEFAULT_INSIGHTS_SETTINGS } } },
    );
    await accounts.updateMany(
      { 'settings.dispositions': { $exists: false } },
      { $set: { 'settings.dispositions': DEFAULT_DISPOSITIONS.map((d) => ({ ...d })) } },
    );
    const calls = db.collection('calls');
    const at = new Date();
    await calls.updateMany(
      { insights: { $exists: false }, 'timestamps.endedAt': { $ne: null } },
      {
        $set: {
          insights: {
            status: 'skipped',
            reason: BEFORE_INSIGHTS,
            version: 0,
            sentiment: null,
            hasPromise: false,
            promiseAmountMicros: null,
            hasSummary: false,
            at,
          },
        },
      },
    );
    await calls.updateMany({ insights: { $exists: false } }, { $set: { insights: null } });
    await calls.updateMany(
      { dispositionSource: { $exists: false }, disposition: { $ne: null }, 'source.kind': 'agent' },
      { $set: { dispositionSource: 'agent' } },
    );
    await calls.updateMany(
      { dispositionSource: { $exists: false }, disposition: { $ne: null } },
      { $set: { dispositionSource: 'flow' } },
    );
    await calls.updateMany(
      { dispositionSource: { $exists: false } },
      { $set: { dispositionSource: null } },
    );
    await db
      .collection('rateCards')
      .updateMany(
        { sttPerMinuteMicros: { $exists: false } },
        { $set: { sttPerMinuteMicros: DEFAULT_RATE_CARD.sttPerMinuteMicros } },
      );
    await CallModel.createIndexes();
    await CallInsightModel.createIndexes();
  },
  down: async (db) => {
    const calls = db.collection('calls');
    if (await calls.indexExists(INSIGHTS_DUE_INDEX)) await calls.dropIndex(INSIGHTS_DUE_INDEX);
    await calls.updateMany({}, { $unset: { insights: '', dispositionSource: '' } });
    await db
      .collection('accounts')
      .updateMany({}, { $unset: { 'settings.insights': '', 'settings.dispositions': '' } });
    await db.collection('rateCards').updateMany({}, { $unset: { sttPerMinuteMicros: '' } });
    if ((await db.listCollections({ name: 'callInsights' }).toArray()).length)
      await db.dropCollection('callInsights');
  },
};
