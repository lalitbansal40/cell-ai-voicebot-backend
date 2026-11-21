import type { Env } from '../../config/env';
import { CallModel, LIVE_CALL_STATUSES, type CallEndReason } from '../../db/models/call.model';
import { MetaCallErrorModel } from '../../db/models/meta-call-error.model';
import { WhatsAppChannelModel } from '../../db/models/whatsapp-channel.model';

/** Admin → System (Phase 18B): is WhatsApp call audio ready on this install. No secrets. */
export interface WhatsAppCallsStatus {
  mediaEnabled: boolean;
  publicIpSet: boolean;
  /** SAC-T12: a TURN relay is configured (`WA_TURN_URLS`). */
  turnSet: boolean;
  portRange: string;
  liveCalls: number;
  /** Queued → ringing of the latest WhatsApp call, ms (`null` = none yet). */
  lastSetupMs: number | null;
  /** The latest failed setup: reason + when (`null` = none in 24 h). */
  lastError: { reason: string; at: string } | null;
  /** Failed setups in the last 15 minutes (health rule `wa-call-setup-failing`). */
  failedSetups15m: number;
  /** SAC-T4: Meta numbers whose last webhook check failed (health rule `wa-webhook-missing`). */
  webhookMissing: number;
  /**
   * SAC-T12: p95 of answer → first audio of AI WhatsApp calls in the last 30 minutes (`null`
   * under 10 calls; health rule `wa-ai-latency-high` above 2.5 s).
   */
  aiFirstAudioP95Ms: number | null;
  /** PMC: managed numbers with calls over Meta Graph — working / broken (`wa-meta-calling-broken`). */
  metaCallingOn: number;
  metaCallingBroken: number;
  metaCallErrors1h: number;
}

export type WhatsAppCallsEnv = Pick<
  Env,
  | 'WHATSAPP_ENABLED'
  | 'WA_MEDIA_ENABLED'
  | 'WA_MEDIA_PUBLIC_IP'
  | 'WA_MEDIA_PORT_MIN'
  | 'WA_MEDIA_PORT_MAX'
  | 'WA_TURN_URLS'
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
  const live = { provider: 'pinnacle' as const, status: { $ne: 'disconnected' as const } };
  const [
    liveCalls,
    latest,
    lastFailed,
    failedSetups15m,
    webhookMissing,
    firstAudio,
    metaCallingOn,
    metaCallingBroken,
    metaCallErrors1h,
  ] = await Promise.all([
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
    WhatsAppChannelModel.countDocuments({
      provider: { $ne: 'pinnacle' },
      status: { $in: ['connected', 'action_needed', 'restricted'] },
      'webhookCheck.status': 'failed',
    }),
    CallModel.find({
      provider: 'whatsapp',
      mode: 'ai',
      createdAt: { $gte: new Date(now.getTime() - 30 * MIN) },
      'metrics.firstAudioMs': { $gte: 0 },
    })
      .select({ 'metrics.firstAudioMs': 1 })
      .limit(500)
      .lean<{ metrics?: { firstAudioMs?: number } }[]>(),
    WhatsAppChannelModel.countDocuments({ ...live, 'metaCalling.status': 'on' }),
    WhatsAppChannelModel.countDocuments({ ...live, 'metaCalling.status': 'error' }),
    MetaCallErrorModel.countDocuments({ at: { $gte: new Date(now.getTime() - 60 * MIN) } }),
  ]);
  const samples = firstAudio.map((c) => c.metrics?.firstAudioMs ?? 0).sort((a, b) => a - b);
  const aiFirstAudioP95Ms =
    samples.length >= 10 ? (samples[Math.ceil(samples.length * 0.95) - 1] ?? null) : null;
  const ringing = latest?.timestamps.ringingAt;
  return {
    mediaEnabled: env.WA_MEDIA_ENABLED,
    publicIpSet: Boolean(env.WA_MEDIA_PUBLIC_IP),
    turnSet: env.WA_TURN_URLS.length > 0,
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
    webhookMissing,
    aiFirstAudioP95Ms,
    metaCallingOn,
    metaCallingBroken,
    metaCallErrors1h,
  };
};
