import { createSocket } from 'node:dgram';

import type { Types } from 'mongoose';

import type { Env } from '../../config/env';
import { defaultCalling, type WhatsAppChannelDoc } from '../../db/models/whatsapp-channel.model';
import {
  PLACEHOLDER_CALLING_RATE_CARD_NOTE,
  WhatsAppRateCardModel,
} from '../../db/models/whatsapp-rate-card.model';
import type { WhatsAppContext } from '../whatsapp/context';

import { activeRestrictions, LOW_TIERS } from './availability';

/**
 * Is WhatsApp calling ready on this number, and if not, what to fix (Phase 18B T18B.2)?
 * Meta's prerequisites (Calling docs, 4 Nov 2026): Cloud API number, messaging limit of at
 * least 2,000, the app subscribed to the `calls` webhook field, `whatsapp_business_messaging`,
 * calling switched on; plus our side: media on this server and real call prices.
 */

export const READINESS_KEYS = [
  'cloud_api',
  'messaging_limit',
  'business_verified',
  'calls_webhook',
  'app_permission',
  'meta_status',
  'restrictions',
  'last_calls_webhook',
  'media',
  'prices',
] as const;
export type ReadinessKey = (typeof READINESS_KEYS)[number];

export interface ReadinessItem {
  key: ReadinessKey;
  /** `null` = could not tell (never blocks the switch). */
  ok: boolean | null;
  detail: string;
  fix: string | null;
}

/** Items that stop calling from being switched on when they are false. */
export const BLOCKING_KEYS: readonly ReadinessKey[] = [
  'cloud_api',
  'messaging_limit',
  'calls_webhook',
  'media',
];

const CACHE_SEC = 3600;
const TIER_TEXT: Record<string, string> = {
  TIER_50: '50 a day',
  TIER_250: '250 a day',
  TIER_1K: '1,000 a day',
  TIER_10K: '10,000 a day',
  TIER_100K: '100,000 a day',
  TIER_UNLIMITED: 'unlimited',
};

export interface ReadinessFacts {
  channel: Pick<
    WhatsAppChannelDoc,
    | 'mode'
    | 'isOnBizApp'
    | 'platformType'
    | 'messagingLimitTier'
    | 'businessVerificationStatus'
    | 'calling'
  > &
    Partial<Pick<WhatsAppChannelDoc, 'provider'>>;
  callsWebhook: boolean | null;
  appPermission: boolean | null;
  media: {
    enabled: boolean;
    publicIpNeeded: boolean;
    publicIpSet: boolean;
    portFree: boolean | null;
  };
  pricesImported: boolean | null;
  now: Date;
}

/** Pure: facts → the checklist (tests drive every branch through this). */
export const readinessItems = (f: ReadinessFacts): ReadinessItem[] => {
  const c = f.channel;
  const calling = c.calling ?? defaultCalling();
  const coexistence = c.mode === 'coexistence' || c.isOnBizApp === true;
  const platform = c.platformType ? c.platformType.toUpperCase() : null;
  const cloud: boolean | null = coexistence
    ? false
    : platform === null
      ? null
      : platform === 'CLOUD_API';
  const tier = c.messagingLimitTier ?? null;
  const restrictions = activeRestrictions(calling, 'business', f.now).concat(
    activeRestrictions(calling, 'user', f.now),
  );
  const m = f.media;
  const mediaOk = m.enabled && (!m.publicIpNeeded || m.publicIpSet) && m.portFree !== false;
  const verified = c.businessVerificationStatus ?? null;
  return [
    {
      key: 'cloud_api',
      ok: cloud,
      detail: coexistence
        ? 'This number also runs on the WhatsApp Business app'
        : cloud === null
          ? 'Not reported yet — sync the number'
          : cloud
            ? 'Cloud API number'
            : `Platform: ${platform ?? 'unknown'}`,
      fix:
        cloud === false
          ? 'Calling needs a number on the Cloud API only (not the WhatsApp Business app).'
          : null,
    },
    {
      key: 'messaging_limit',
      ok: tier === null ? null : !LOW_TIERS.has(tier),
      detail: tier === null ? 'Not reported yet' : `Messaging limit: ${TIER_TEXT[tier] ?? tier}`,
      fix:
        tier !== null && LOW_TIERS.has(tier)
          ? 'Meta allows calling from 2,000 a day. The limit grows with good-quality messages to more unique customers and with business verification (WhatsApp Manager → Insights).'
          : null,
    },
    {
      key: 'business_verified',
      ok: verified === null ? null : verified.toLowerCase() === 'verified',
      detail: verified === null ? 'Not reported yet' : `Business verification: ${verified}`,
      fix:
        verified !== null && verified.toLowerCase() !== 'verified'
          ? 'Verify the business in Meta Business Settings → Security Centre; it also raises the messaging limit.'
          : null,
    },
    // PN (D16): a managed number's events and access come from the partner (Pinnacle)
    f.channel.provider === 'pinnacle'
      ? {
          key: 'calls_webhook',
          ok: f.callsWebhook,
          detail: f.callsWebhook
            ? 'Partner webhook set — calls events reach us'
            : 'The partner webhook is not set for this number',
          fix: f.callsWebhook ? null : 'Ask support to reset the partner webhook for this number.',
        }
      : {
          key: 'calls_webhook',
          ok: f.callsWebhook,
          detail:
            f.callsWebhook === null
              ? 'Could not read the app’s webhook fields'
              : f.callsWebhook
                ? 'The app receives `calls` events'
                : 'The app is not subscribed to `calls`',
          fix:
            f.callsWebhook === false
              ? 'Meta App Dashboard → WhatsApp → Configuration → Webhook fields: subscribe to "calls".'
              : null,
        },
    f.channel.provider === 'pinnacle'
      ? {
          key: 'app_permission',
          ok: f.appPermission,
          detail: f.appPermission
            ? 'Partner API key valid'
            : 'The partner API key was rejected or not checked yet',
          fix: f.appPermission ? null : 'Ask support to replace the partner API key.',
        }
      : {
          key: 'app_permission',
          ok: f.appPermission,
          detail:
            f.appPermission === null
              ? 'Could not check the number’s access'
              : f.appPermission
                ? 'whatsapp_business_messaging granted'
                : 'whatsapp_business_messaging missing',
          fix:
            f.appPermission === false
              ? 'Connect the number again and allow every permission in the Meta popup.'
              : null,
        },
    {
      key: 'meta_status',
      ok: calling.status === 'enabled',
      detail: `Calling at WhatsApp: ${calling.status}${calling.syncedAt ? '' : ' (never read)'}`,
      fix:
        calling.status === 'enabled' ? null : 'Turn calling on below once the checks above pass.',
    },
    {
      key: 'restrictions',
      ok: restrictions.length === 0,
      detail: restrictions.length ? restrictions.map((r) => r.type).join(', ') : 'None',
      fix: restrictions.length
        ? 'WhatsApp paused some calls from this number; it lifts the pause by itself (see the date).'
        : null,
    },
    {
      key: 'last_calls_webhook',
      ok: calling.lastCallsWebhookAt ? true : null,
      detail: calling.lastCallsWebhookAt
        ? `Last call event ${calling.lastCallsWebhookAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`
        : 'No call event has reached us yet',
      fix: null,
    },
    {
      key: 'media',
      ok: mediaOk,
      detail: !m.enabled
        ? 'Call audio is off on this server'
        : m.publicIpNeeded && !m.publicIpSet
          ? 'No public IP set for call audio'
          : m.portFree === false
            ? 'The call audio ports are taken on this server'
            : 'Call audio ready on this server',
      fix: mediaOk
        ? null
        : 'Server: WA_MEDIA_ENABLED=true, WA_MEDIA_PUBLIC_IP=<server public IP>, UDP 40000–40999 open (production.md).',
    },
    {
      key: 'prices',
      ok: f.pricesImported,
      detail:
        f.pricesImported === null
          ? 'No calling price card'
          : f.pricesImported
            ? "Meta's calling prices imported"
            : 'Placeholder calling prices in use',
      fix: f.pricesImported
        ? null
        : "Superadmin → WhatsApp billing → Calling rates: import Meta's INR card.",
    },
  ];
};

export const blockingProblem = (items: ReadinessItem[]): ReadinessItem | null =>
  items.find((i) => BLOCKING_KEYS.includes(i.key) && i.ok === false) ?? null;

/**
 * One port of the range binds here (no outbound probe). A taken port is `null`, not a
 * failure: this server's own live calls may hold it.
 */
const portBindable = (port: number): Promise<boolean | null> =>
  new Promise((resolve) => {
    const socket = createSocket('udp4');
    socket.once('error', () => {
      socket.close();
      resolve(null);
    });
    socket.bind(port, '127.0.0.1', () => {
      socket.close();
      resolve(true);
    });
  });

export interface ReadinessDeps {
  ctx: Pick<WhatsAppContext, 'meta' | 'redis' | 'env'> & { now?: () => Date };
  token: (channelId: Types.ObjectId | string) => Promise<{ token: string }>;
}

type MediaEnv = Pick<
  Env,
  'NODE_ENV' | 'WA_MEDIA_ENABLED' | 'WA_MEDIA_PUBLIC_IP' | 'WA_MEDIA_PORT_MIN' | 'WA_MEDIA_PORT_MAX'
>;

export const createCallingReadiness = (deps: ReadinessDeps) => {
  const { meta, redis } = deps.ctx;
  const env = deps.ctx.env as MediaEnv & Env;

  const cached = async (key: string, read: () => Promise<boolean>): Promise<boolean | null> => {
    const hit = await redis.get(key).catch(() => null);
    if (hit === '1' || hit === '0') return hit === '1';
    try {
      const value = await read();
      await redis.set(key, value ? '1' : '0', 'EX', CACHE_SEC).catch(() => undefined);
      return value;
    } catch {
      return null;
    }
  };

  const callsWebhook = () =>
    cached('wa:readiness:calls-webhook', async () => {
      // meta-only: our Meta app (managed numbers: see `read`)
      const subs = await meta.getAppSubscriptions();
      return subs.some(
        (s) => s.object === 'whatsapp_business_account' && s.active && s.fields.includes('calls'),
      );
    });

  const appPermission = (channelId: string) =>
    cached(`wa:readiness:scope:${channelId}`, async () => {
      const { token } = await deps.token(channelId);
      // meta-only: our Meta app (managed numbers: see `read`)
      const info = await meta.debugToken(token);
      return info.isValid && info.scopes.includes('whatsapp_business_messaging');
    });

  const pricesImported = async (): Promise<boolean | null> => {
    const card = await WhatsAppRateCardModel.findOne({ kind: 'calling' })
      .sort({ effectiveFrom: -1 })
      .select({ note: 1 })
      .lean<{ note: string | null }>();
    return card ? card.note !== PLACEHOLDER_CALLING_RATE_CARD_NOTE : null;
  };

  const read = async (
    channel: WhatsAppChannelDoc,
  ): Promise<{ ready: boolean; items: ReadinessItem[] }> => {
    const now = deps.ctx.now?.() ?? new Date();
    const managed = channel.provider === 'pinnacle';
    const [hook, scope, prices, port] = await Promise.all([
      managed ? Promise.resolve(Boolean(channel.pinnacle?.webhookSetAt)) : callsWebhook(),
      managed
        ? Promise.resolve(
            Boolean(channel.pinnacle?.keyCheckedAt) && channel.status !== 'needs_reconnect',
          )
        : appPermission(channel._id.toString()),
      pricesImported(),
      env.WA_MEDIA_ENABLED ? portBindable(env.WA_MEDIA_PORT_MAX) : Promise.resolve(null),
    ]);
    const items = readinessItems({
      channel,
      callsWebhook: hook,
      appPermission: scope,
      pricesImported: prices,
      media: {
        enabled: env.WA_MEDIA_ENABLED,
        publicIpNeeded: env.NODE_ENV === 'production',
        publicIpSet: Boolean(env.WA_MEDIA_PUBLIC_IP),
        portFree: port,
      },
      now,
    });
    return { ready: items.every((i) => !BLOCKING_KEYS.includes(i.key) || i.ok !== false), items };
  };

  return { read };
};
