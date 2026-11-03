import type { Redis } from 'ioredis';

import type { Env } from '../../config/env';
import { SipCapacity } from '../../core/telephony/sip/capacity';
import { CallModel } from '../../db/models/call.model';

export interface SipStatus {
  ariConnected: boolean;
  /** PJSIP endpoint state of the trunk from ARI (`null` = could not tell). */
  trunkOnline: boolean | null;
  liveChannels: number;
  maxChannels: number;
  maxCps: number;
  /** Last 24 h of SIP calls by end reason. */
  causes24h: Record<string, number>;
  avgLossPct: number | null;
  avgJitterMs: number | null;
}

export type SipStatusEnv = Pick<
  Env,
  | 'TELEPHONY_PROVIDER'
  | 'ARI_URL'
  | 'ARI_USER'
  | 'ARI_PASSWORD'
  | 'SIP_TRUNK_ENDPOINT'
  | 'SIP_MAX_CHANNELS'
  | 'SIP_MAX_CPS'
>;

const ari = async (env: SipStatusEnv, path: string): Promise<unknown> => {
  const auth = Buffer.from(`${env.ARI_USER}:${env.ARI_PASSWORD ?? ''}`).toString('base64');
  const res = await fetch(new URL(`/ari${path}`, env.ARI_URL), {
    headers: { authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) throw new Error(`ari ${String(res.status)}`);
  return res.json();
};

/**
 * Admin → System SIP card and healthwatch (T18.15): asks Asterisk directly, so it works
 * from the API, the worker or the health-check CLI. `null` when the install has no trunk.
 */
export const readSipStatus = async (
  env: SipStatusEnv,
  redis: Redis,
  now = new Date(),
): Promise<SipStatus | null> => {
  if (env.TELEPHONY_PROVIDER !== 'sip') return null;
  const [info, endpoint, liveChannels, rows] = await Promise.all([
    ari(env, '/asterisk/info').then(
      () => true,
      () => false,
    ),
    ari(env, `/endpoints/PJSIP/${encodeURIComponent(env.SIP_TRUNK_ENDPOINT)}`).then(
      (e) => {
        const state = (e as { state?: string }).state;
        return state === 'online' ? true : state === 'offline' ? false : null;
      },
      () => null,
    ),
    new SipCapacity({ redis, maxChannels: env.SIP_MAX_CHANNELS, maxCps: env.SIP_MAX_CPS })
      .inUse()
      .catch(() => -1),
    CallModel.aggregate<{
      _id: string | null;
      n: number;
      loss: number | null;
      jitter: number | null;
    }>([
      { $match: { provider: 'sip', createdAt: { $gte: new Date(now.getTime() - 86_400_000) } } },
      {
        $group: {
          _id: '$endReason',
          n: { $sum: 1 },
          loss: { $avg: '$sip.lossPct' },
          jitter: { $avg: '$sip.jitterMs' },
        },
      },
    ]).catch(() => []),
  ]);
  const causes24h: Record<string, number> = {};
  let weighted = 0;
  let lossSum = 0;
  let jitterSum = 0;
  for (const r of rows) {
    causes24h[r._id ?? 'live'] = r.n;
    if (r.loss !== null && r.jitter !== null) {
      weighted += r.n;
      lossSum += r.loss * r.n;
      jitterSum += r.jitter * r.n;
    }
  }
  const round = (v: number) => Math.round(v * 10) / 10;
  return {
    ariConnected: info,
    trunkOnline: info ? endpoint : null,
    liveChannels,
    maxChannels: env.SIP_MAX_CHANNELS,
    maxCps: env.SIP_MAX_CPS,
    causes24h,
    avgLossPct: weighted ? round(lossSum / weighted) : null,
    avgJitterMs: weighted ? round(jitterSum / weighted) : null,
  };
};
