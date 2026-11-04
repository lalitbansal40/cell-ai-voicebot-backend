import type { Env } from '../../config/env';
import { CallModel, LIVE_CALL_STATUSES, type CallEndReason } from '../../db/models/call.model';

/** Admin → System (Phase 18B): is WhatsApp call audio ready on this install. No secrets. */
export interface WhatsAppCallsStatus {
  mediaEnabled: boolean;
  publicIpSet: boolean;
  portRange: string;
  liveCalls: number;
  /** Queued → ringing of the latest WhatsApp call, ms (`null` = none yet). */
  lastSetupMs: number | null;
  /** The latest failed setup: reason + when (`null` = none in 24 h). */
  lastError: { reason: string; at: string } | null;
  /** Failed setups in the last 15 minutes (health rule `wa-call-setup-failing`). */
  failedSetups15m: number;
}

export type WhatsAppCallsEnv = Pick<
  Env,
  | 'WHATSAPP_ENABLED'
  | 'WA_MEDIA_ENABLED'
  | 'WA_MEDIA_PUBLIC_IP'
  | 'WA_MEDIA_PORT_MIN'
  | 'WA_MEDIA_PORT_MAX'
>;

/** A WhatsApp call that never got its audio up. */
export const SETUP_FAILURE_REASONS: readonly CallEndReason[] = [
  'meta_failed',
  'media_timeout',
  'media_error',
  'engine_error',
];

const MIN = 60_000;

/** `null` when WhatsApp is off on this install. */
export const readWhatsAppCallsStatus = async (
  env: WhatsAppCallsEnv,
  now: Date,
): Promise<WhatsAppCallsStatus | null> => {
  if (!env.WHATSAPP_ENABLED) return null;
  const failed = {
    provider: 'whatsapp' as const,
    status: 'failed' as const,
    endReason: { $in: [...SETUP_FAILURE_REASONS] },
  };
  const [liveCalls, latest, lastFailed, failedSetups15m] = await Promise.all([
    CallModel.countDocuments({ provider: 'whatsapp', status: { $in: LIVE_CALL_STATUSES } }),
    CallModel.findOne({ provider: 'whatsapp', 'timestamps.ringingAt': { $ne: null } })
      .sort({ createdAt: -1 })
      .select({ timestamps: 1 })
      .lean<{ timestamps: { queuedAt: Date; ringingAt: Date | null } }>(),
    CallModel.findOne({ ...failed, createdAt: { $gte: new Date(now.getTime() - 1_440 * MIN) } })
      .sort({ createdAt: -1 })
      .select({ endReason: 1, createdAt: 1 })
      .lean<{ endReason: string; createdAt: Date }>(),
    CallModel.countDocuments({
      ...failed,
      createdAt: { $gte: new Date(now.getTime() - 15 * MIN) },
    }),
  ]);
  const ringing = latest?.timestamps.ringingAt;
  return {
    mediaEnabled: env.WA_MEDIA_ENABLED,
    publicIpSet: Boolean(env.WA_MEDIA_PUBLIC_IP),
    portRange: `${String(env.WA_MEDIA_PORT_MIN)}-${String(env.WA_MEDIA_PORT_MAX)}`,
    liveCalls,
    lastSetupMs:
      latest && ringing
        ? Math.max(0, ringing.getTime() - latest.timestamps.queuedAt.getTime())
        : null,
    lastError: lastFailed
      ? { reason: lastFailed.endReason, at: lastFailed.createdAt.toISOString() }
      : null,
    failedSetups15m,
  };
};
