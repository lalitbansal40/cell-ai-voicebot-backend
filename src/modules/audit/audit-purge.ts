import { AuditLogModel } from '../../db/models/audit-log.model';

export const AUDIT_RETENTION_DAYS = 365;
const BATCH = 10_000;

/** Deletes audit entries older than the retention period, in batches. Returns the count. */
export const purgeAuditLogs = async (now = new Date()): Promise<number> => {
  const cutoff = new Date(now.getTime() - AUDIT_RETENTION_DAYS * 86_400_000);
  let total = 0;
  for (;;) {
    const ids = (
      await AuditLogModel.find({ at: { $lt: cutoff } })
        .select({ _id: 1 })
        .limit(BATCH)
        .lean()
    ).map((d) => d._id);
    if (!ids.length) return total;
    const res = await AuditLogModel.deleteMany(
      { _id: { $in: ids } },
      {
        allowPurge: true,
      },
    );
    total += res.deletedCount;
  }
};
