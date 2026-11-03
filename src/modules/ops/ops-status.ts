import { AccountModel } from '../../db/models/account.model';
import { PlatformSettingsModel } from '../../db/models/platform-settings.model';
import { recordAudit } from '../audit/audit.service';

/**
 * What the ops commands record about production (Phase 17): the last backup, restore drill and
 * release. One `platformSettings` row, key `opsStatus`; Admin → System and healthwatch read it.
 */
export interface OpsStatus {
  lastBackup: { at: string; ok: boolean; bytes: number } | null;
  lastRestoreDrill: { at: string; rtoMinutes: number } | null;
  lastRelease: { at: string; tag: string; backend: string; frontend: string } | null;
}

const EMPTY: OpsStatus = { lastBackup: null, lastRestoreDrill: null, lastRelease: null };

export const readOpsStatus = async (): Promise<OpsStatus> => {
  const row = await PlatformSettingsModel.findOne({ key: 'opsStatus' })
    .lean<{ value?: Partial<OpsStatus> }>()
    .exec();
  return { ...EMPTY, ...row?.value };
};

const save = async (patch: Partial<OpsStatus>) => {
  await PlatformSettingsModel.updateOne(
    { key: 'opsStatus' },
    { $set: Object.fromEntries(Object.entries(patch).map(([k, v]) => [`value.${k}`, v])) },
    { upsert: true },
  );
};

/** The platform account's audit log holds ops events (no personal data). */
const auditPlatform = async (
  action: 'ops.release_recorded' | 'ops.restore_drill_recorded',
  meta: Record<string, unknown>,
) => {
  const platform = await AccountModel.findOne({ isPlatform: true }).select({ _id: 1 }).lean();
  if (!platform) return;
  await recordAudit({
    accountId: platform._id,
    actor: { type: 'system', id: null, platform: true },
    action,
    meta,
  });
};

export const recordBackup = (at: Date, ok: boolean, bytes: number) =>
  save({ lastBackup: { at: at.toISOString(), ok, bytes } });

export const recordRestoreDrill = async (at: Date, rtoMinutes: number) => {
  await save({ lastRestoreDrill: { at: at.toISOString(), rtoMinutes } });
  await auditPlatform('ops.restore_drill_recorded', { rtoMinutes });
};

export const recordRelease = async (
  at: Date,
  release: { tag: string; backend: string; frontend: string },
) => {
  await save({ lastRelease: { at: at.toISOString(), ...release } });
  await auditPlatform('ops.release_recorded', release);
};
