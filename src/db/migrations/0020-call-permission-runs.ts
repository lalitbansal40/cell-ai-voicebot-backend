import type { ObjectId } from 'mongodb';

import type { Migration } from '../migrate';
import { CallPermissionRunModel } from '../models/call-permission-run.model';

type Row = { contactId: ObjectId; accountId: ObjectId; status: string; expiresAt: Date | null };

/** Same order as `permissionSummary` (Phase 18B): allowed > asked > declined > none. */
const summaryOf = (rows: Row[], now: number): string => {
  if (
    rows.some(
      (r) =>
        r.status === 'permanent' ||
        (r.status === 'temporary' && (!r.expiresAt || r.expiresAt.getTime() > now)),
    )
  ) {
    return 'allowed';
  }
  if (rows.some((r) => r.status === 'requested')) return 'asked';
  if (rows.some((r) => ['declined', 'revoked', 'expired', 'temporary'].includes(r.status))) {
    return 'declined';
  }
  return 'none';
};

/**
 * Phase 18B: bulk call permission runs get their collection + index; every contact gets
 * `waCallPermission` (from its permission rows, else `none`). Additive only, so the
 * previous release keeps working.
 */
export const callPermissionRunsMigration: Migration = {
  name: '0020-call-permission-runs',
  up: async (db) => {
    await CallPermissionRunModel.createIndexes();
    const now = Date.now();
    const byContact = new Map<string, Row[]>();
    const cursor = db
      .collection<Row>('whatsappCallPermissions')
      .find({}, { projection: { contactId: 1, accountId: 1, status: 1, expiresAt: 1 } });
    for await (const row of cursor) {
      const key = String(row.contactId);
      byContact.set(key, [...(byContact.get(key) ?? []), row]);
    }
    const ops = [...byContact.values()].map((rows) => ({
      updateOne: {
        filter: { _id: rows[0]?.contactId as ObjectId, accountId: rows[0]?.accountId as ObjectId },
        update: { $set: { waCallPermission: summaryOf(rows, now) } },
      },
    }));
    for (let i = 0; i < ops.length; i += 500) {
      await db.collection('contacts').bulkWrite(ops.slice(i, i + 500), { ordered: false });
    }
    await db
      .collection('contacts')
      .updateMany({ waCallPermission: { $exists: false } }, { $set: { waCallPermission: 'none' } });
  },
  down: async (db) => {
    await db.collection('contacts').updateMany({}, { $unset: { waCallPermission: '' } });
    await db
      .collection('callPermissionRuns')
      .drop()
      .catch(() => undefined);
  },
};
