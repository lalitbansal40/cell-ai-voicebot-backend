import { BlockList, isIP } from 'node:net';

import type { Env } from '../../config/env';

/** Where an outgoing request may go (custom functions, knowledge URL sources). */
export interface GuardPolicy {
  /** `https` only (production). */
  httpsOnly: boolean;
  /** Loopback / private ranges allowed (dev `AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS`). */
  allowPrivate: boolean;
  /** Extra ports allowed besides 80 / 443 / 8000–8999 (dev mock API, test stubs). */
  extraPorts?: readonly number[];
}

export type BlockReason = 'scheme' | 'port' | 'private' | 'reserved' | 'invalid';

/** Blocked even when private hosts are allowed: link-local (cloud metadata), "this network", multicast, reserved. */
const ALWAYS = new BlockList();
ALWAYS.addSubnet('0.0.0.0', 8, 'ipv4');
ALWAYS.addSubnet('169.254.0.0', 16, 'ipv4');
ALWAYS.addSubnet('224.0.0.0', 4, 'ipv4');
ALWAYS.addSubnet('240.0.0.0', 4, 'ipv4');
ALWAYS.addAddress('255.255.255.255', 'ipv4');
ALWAYS.addAddress('::', 'ipv6');
ALWAYS.addSubnet('fe80::', 10, 'ipv6');
ALWAYS.addSubnet('ff00::', 8, 'ipv6');

/** Loopback / private / shared ranges — allowed only outside production when enabled. */
const PRIVATE = new BlockList();
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4');
PRIVATE.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.0.0.0', 24, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('198.18.0.0', 15, 'ipv4');
PRIVATE.addAddress('::1', 'ipv6');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
const MAPPED_HEX = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

/** `::ffff:10.0.0.1` / `::ffff:a00:1` → `10.0.0.1`; anything else unchanged. */
export const unmapIpv4 = (ip: string): string => {
  const dotted = MAPPED_V4.exec(ip);
  if (dotted?.[1]) return dotted[1];
  const hex = MAPPED_HEX.exec(ip);
  if (hex?.[1] && hex[2]) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return ip;
};

/** Why an IP address may not be called (`null` = allowed). */
export const addressBlockReason = (address: string, policy: GuardPolicy): BlockReason | null => {
  const ip = unmapIpv4(address.replace(/^\[|\]$/g, ''));
  const family = isIP(ip);
  if (!family) return 'invalid';
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (ALWAYS.check(ip, type)) return 'reserved';
  if (PRIVATE.check(ip, type)) return policy.allowPrivate ? null : 'private';
  return null;
};

export const portAllowed = (port: number, policy: GuardPolicy): boolean =>
  port === 80 ||
  port === 443 ||
  (port >= 8000 && port <= 8999) ||
  (policy.extraPorts ?? []).includes(port);

/** Effective port of a parsed URL. */
export const urlPort = (url: URL): number =>
  url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;

/**
 * Checks everything known before DNS: scheme, port, credentials, and literal
 * IP / `localhost` hosts. Names are checked again after resolution.
 */
export const urlBlockReason = (url: URL, policy: GuardPolicy): BlockReason | null => {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'scheme';
  if (policy.httpsOnly && url.protocol !== 'https:') return 'scheme';
  if (url.username || url.password || !url.hostname) return 'invalid';
  if (!portAllowed(urlPort(url), policy)) return 'port';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return addressBlockReason(host, policy);
  const lower = host.toLowerCase().replace(/\.$/, '');
  if (lower === 'localhost' || lower.endsWith('.localhost')) {
    return policy.allowPrivate ? null : 'private';
  }
  return null;
};

/**
 * Policy from env (PHASE_5_PLAN §1c): https only and no private hosts in
 * production; outside production the backend port is allowed for the mock API.
 */
export const outgoingPolicy = (
  env: Pick<Env, 'NODE_ENV' | 'AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS' | 'APP_URL'>,
  extraPorts: readonly number[] = [],
): GuardPolicy => {
  const production = env.NODE_ENV === 'production';
  const appPort = Number(new URL(env.APP_URL || 'http://localhost').port) || null;
  return {
    httpsOnly: production,
    allowPrivate: env.AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS,
    extraPorts: production ? [] : [5100, 3100, ...(appPort ? [appPort] : []), ...extraPorts],
  };
};
