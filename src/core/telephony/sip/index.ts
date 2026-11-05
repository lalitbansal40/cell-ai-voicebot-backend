import type { Redis } from 'ioredis';

import type { Env } from '../../../config/env';
import type { Logger } from '../../../shared/logger';
import { systemClock, type Clock } from '../../voice/clock';

import { AriClient } from './ari-client';
import { SipCapacity } from './capacity';
import { parsePortRange, PortPool } from './port-pool';
import { SipTelephonyProvider } from './provider';

export { SipTelephonyProvider } from './provider';

export type SipEnv = Pick<
  Env,
  | 'ARI_URL'
  | 'ARI_USER'
  | 'ARI_PASSWORD'
  | 'ARI_APP'
  | 'SIP_TRUNK_ENDPOINT'
  | 'SIP_CALLER_ID'
  | 'SIP_CODEC'
  | 'SIP_RING_TIMEOUT_SEC'
  | 'SIP_MEDIA_TIMEOUT_SEC'
  | 'SIP_APP_RTP_PORTS'
  | 'SIP_APP_RTP_ADVERTISE'
  | 'SIP_ASTERISK_RTP_HOST'
  | 'SIP_MAX_CHANNELS'
  | 'SIP_MAX_CPS'
  | 'SIP_INBOUND_ENABLED'
  | 'SIP_INBOUND_RESERVED_CHANNELS'
>;

export interface SipLine {
  provider: SipTelephonyProvider;
  ari: AriClient;
  /** This process's ARI app (`<ARI_APP>-api` / `<ARI_APP>-worker`): events of its calls only. */
  app: string;
  /** `<ARI_APP>-inbound` on the API process when incoming calls are on (Phase 20), else null. */
  inboundApp: string | null;
  close(): void;
}

/**
 * The SIP line of one process (ADR 0050). Each process has its own ARI app, so the
 * events of a channel reach the process that dialed it; limits are shared in Redis.
 */
export const createSipLine = (
  env: SipEnv,
  options: {
    logger: Logger;
    role: 'api' | 'worker';
    redis: Redis;
    clock?: Clock;
    /** This process takes trunk calls (Phase 20): exactly one process kind may. */
    inbound?: boolean;
  },
): SipLine => {
  const app = `${env.ARI_APP}-${options.role}`;
  // Only one process kind takes trunk calls (the dialplan hands them to this app).
  const inboundApp = options.inbound && env.SIP_INBOUND_ENABLED ? `${env.ARI_APP}-inbound` : null;
  const ari = new AriClient({
    url: env.ARI_URL,
    user: env.ARI_USER,
    password: env.ARI_PASSWORD ?? '',
    app,
    extraApps: inboundApp ? [inboundApp] : [],
  });
  const { min, max } = parsePortRange(env.SIP_APP_RTP_PORTS);
  const provider = new SipTelephonyProvider(
    ari,
    new PortPool(min, max, min + Math.floor(Math.random() * (max - min + 1))),
    options.clock ?? systemClock,
    {
      trunk: env.SIP_TRUNK_ENDPOINT,
      format: env.SIP_CODEC,
      ringTimeoutSec: env.SIP_RING_TIMEOUT_SEC,
      mediaTimeoutSec: env.SIP_MEDIA_TIMEOUT_SEC,
      rtpBindHost: '127.0.0.1',
      advertiseHost: env.SIP_APP_RTP_ADVERTISE,
      asteriskRtpHost: env.SIP_ASTERISK_RTP_HOST,
      defaultCallerId: env.SIP_CALLER_ID ?? '',
      app,
    },
    new SipCapacity({
      redis: options.redis,
      maxChannels: env.SIP_MAX_CHANNELS,
      maxCps: env.SIP_MAX_CPS,
      reservedInbound: env.SIP_INBOUND_RESERVED_CHANNELS,
    }),
  );
  ari.on('state', (up) => {
    if (up) options.logger.info({ app }, 'sip: ari connected');
    else options.logger.warn({ app }, 'sip: ari disconnected');
  });
  ari.connect();
  return { provider, ari, app, inboundApp, close: () => ari.close() };
};
