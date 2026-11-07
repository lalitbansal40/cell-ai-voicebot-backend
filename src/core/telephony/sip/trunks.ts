import type { AriClient } from './ari-client';

/**
 * Accounts' own SIP trunks (no env change): the carrier login an account enters in the app
 * becomes PJSIP objects created at run time over ARI (sorcery memory wizard, see
 * `deploy/asterisk/conf/sorcery.conf`). Asterisk forgets them on restart, so the line pushes
 * every saved trunk again whenever ARI (re)connects.
 */

export interface TrunkSpec {
  host: string;
  port: number;
  transport: 'udp' | 'tcp';
  auth: 'ip' | 'register';
  username: string | null;
  /** Plain password (register only) — only ever sent to Asterisk, never logged. */
  password: string | null;
  trunkIps: string[];
  codecs: ('ulaw' | 'alaw')[];
}

interface TrunkObject {
  configClass: string;
  type: string;
  id: string;
  fields: { attribute: string; value: string }[];
}

/** The PJSIP endpoint name of an account's trunk (`PJSIP/<number>@acc-<accountId>`). */
export const trunkEndpointOf = (accountId: string): string => `acc-${accountId}`;

const f = (attribute: string, value: string | number) => ({ attribute, value: String(value) });

/** The PJSIP objects of a trunk, in creation order. */
export const trunkObjects = (accountId: string, t: TrunkSpec): TrunkObject[] => {
  const id = trunkEndpointOf(accountId);
  const register = t.auth === 'register' && t.username && t.password;
  const hostPort = `${t.host}:${String(t.port)}`;
  const out: TrunkObject[] = [];
  if (register) {
    out.push({
      configClass: 'res_pjsip',
      type: 'auth',
      id: `${id}-auth`,
      fields: [
        f('auth_type', 'userpass'),
        f('username', t.username as string),
        f('password', t.password as string),
      ],
    });
  }
  out.push({
    configClass: 'res_pjsip',
    type: 'aor',
    id,
    fields: [f('contact', `sip:${hostPort}`), f('qualify_frequency', 60)],
  });
  out.push({
    configClass: 'res_pjsip',
    type: 'endpoint',
    id,
    fields: [
      f('transport', `transport-${t.transport}`),
      f('context', 'cav-in'),
      f('disallow', 'all'),
      f('allow', (t.codecs.length ? t.codecs : ['ulaw', 'alaw']).join(',')),
      f('dtmf_mode', 'rfc4733'),
      f('direct_media', 'no'),
      f('rtp_symmetric', 'yes'),
      f('force_rport', 'yes'),
      f('rewrite_contact', 'yes'),
      f('send_pai', 'yes'),
      f('send_connected_line', 'no'),
      f('trust_id_outbound', 'yes'),
      f('aors', id),
      ...(register
        ? [
            f('outbound_auth', `${id}-auth`),
            f('from_user', t.username as string),
            f('from_domain', t.host),
          ]
        : []),
    ],
  });
  out.push({
    configClass: 'res_pjsip',
    type: 'identify',
    id: `${id}-identify`,
    fields: [f('endpoint', id), f('match', (t.trunkIps.length ? t.trunkIps : [t.host]).join(','))],
  });
  if (register) {
    out.push({
      configClass: 'res_pjsip',
      type: 'registration',
      id: `${id}-reg`,
      fields: [
        f('transport', `transport-${t.transport}`),
        f('outbound_auth', `${id}-auth`),
        f('server_uri', `sip:${hostPort}`),
        f('client_uri', `sip:${t.username as string}@${hostPort}`),
        f('contact_user', t.username as string),
        f('retry_interval', 30),
        f('forbidden_retry_interval', 300),
        f('expiration', 300),
      ],
    });
  }
  return out;
};

/** Every object type an account trunk may have, for removal (reverse order). */
const ALL_TYPES = (accountId: string) => {
  const id = trunkEndpointOf(accountId);
  return [
    { configClass: 'res_pjsip', type: 'registration', id: `${id}-reg` },
    { configClass: 'res_pjsip', type: 'identify', id: `${id}-identify` },
    { configClass: 'res_pjsip', type: 'endpoint', id },
    { configClass: 'res_pjsip', type: 'aor', id },
    { configClass: 'res_pjsip', type: 'auth', id: `${id}-auth` },
  ];
};

/** Removes an account's trunk from Asterisk (missing objects are fine). */
export const removeTrunk = async (ari: AriClient, accountId: string): Promise<void> => {
  for (const o of ALL_TYPES(accountId)) await ari.deleteConfig(o.configClass, o.type, o.id);
};

/** Creates / replaces an account's trunk in Asterisk (old objects first, so modes can change). */
export const pushTrunk = async (
  ari: AriClient,
  accountId: string,
  trunk: TrunkSpec,
): Promise<void> => {
  await removeTrunk(ari, accountId);
  for (const o of trunkObjects(accountId, trunk))
    await ari.putConfig(o.configClass, o.type, o.id, o.fields);
};

/** `online` (the carrier answers our checks), `offline`, `unknown`, or `null` (not in Asterisk). */
export const trunkState = (ari: AriClient, accountId: string): Promise<string | null> =>
  ari.endpointState(trunkEndpointOf(accountId));
