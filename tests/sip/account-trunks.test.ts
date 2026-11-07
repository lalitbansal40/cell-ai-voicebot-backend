import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AriClient } from '../../src/core/telephony/sip/ari-client';
import {
  pushTrunk,
  removeTrunk,
  trunkEndpointOf,
  trunkObjects,
  trunkState,
  type TrunkSpec,
} from '../../src/core/telephony/sip/trunks';

import { FakeAri, waitFor } from './fake-ari';

/** Accounts' own SIP trunks: PJSIP objects created over ARI (no env change). */

const ACC = '6650a1b2c3d4e5f6a7b8c9d2';
const IP: TrunkSpec = {
  host: '203.0.113.20',
  port: 5060,
  transport: 'udp',
  auth: 'ip',
  username: null,
  password: null,
  trunkIps: [],
  codecs: ['alaw'],
};
const REG: TrunkSpec = {
  ...IP,
  host: 'sip.carrier.in',
  auth: 'register',
  username: 'acme01',
  password: 'trunk-pass-77',
  trunkIps: ['203.0.113.30/32'],
};

let ari: FakeAri;
let client: AriClient;

beforeEach(async () => {
  ari = await new FakeAri().start();
  client = new AriClient({ url: ari.url, user: 'cav', password: 'x'.repeat(24), app: 'cav-api' });
  client.connect();
  await waitFor(() => client.connected);
});
afterEach(async () => {
  client.close();
  await ari.stop();
});

const field = (o: { fields: { attribute: string; value: string }[] }, a: string) =>
  o.fields.find((x) => x.attribute === a)?.value;

describe('account SIP trunks', () => {
  it('IP trunk: aor, endpoint (dialplan cav-in) and identify by the host', () => {
    const objects = trunkObjects(ACC, IP);
    expect(objects.map((o) => `${o.configClass}/${o.type}/${o.id}`)).toEqual([
      `res_pjsip/aor/acc-${ACC}`,
      `res_pjsip/endpoint/acc-${ACC}`,
      `res_pjsip/identify/acc-${ACC}-identify`,
    ]);
    const [aor, endpoint, identify] = objects;
    expect(field(aor!, 'contact')).toBe('sip:203.0.113.20:5060');
    expect(field(endpoint!, 'context')).toBe('cav-in');
    expect(field(endpoint!, 'allow')).toBe('alaw');
    expect(field(endpoint!, 'outbound_auth')).toBeUndefined();
    expect(field(identify!, 'match')).toBe('203.0.113.20');
  });

  it('register trunk: auth + registration, the endpoint authenticates out', () => {
    const objects = trunkObjects(ACC, REG);
    expect(objects.map((o) => o.type)).toEqual([
      'auth',
      'aor',
      'endpoint',
      'identify',
      'registration',
    ]);
    const reg = objects.at(-1)!;
    expect(field(reg, 'client_uri')).toBe('sip:acme01@sip.carrier.in:5060');
    expect(field(reg, 'outbound_auth')).toBe(`acc-${ACC}-auth`);
    expect(field(objects[2]!, 'from_user')).toBe('acme01');
    expect(field(objects[3]!, 'match')).toBe('203.0.113.30/32');
  });

  it('pushes over ARI (old objects first) and reads the state', async () => {
    ari.on((c) =>
      c.method === 'GET' && c.path === `/endpoints/PJSIP/${trunkEndpointOf(ACC)}`
        ? { status: 200, body: { state: 'online' } }
        : undefined,
    );
    await pushTrunk(client, ACC, REG);
    const puts = ari.calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => c.path)).toEqual([
      `/asterisk/config/dynamic/res_pjsip/auth/acc-${ACC}-auth`,
      `/asterisk/config/dynamic/res_pjsip/aor/acc-${ACC}`,
      `/asterisk/config/dynamic/res_pjsip/endpoint/acc-${ACC}`,
      `/asterisk/config/dynamic/res_pjsip/identify/acc-${ACC}-identify`,
      `/asterisk/config/dynamic/res_pjsip/registration/acc-${ACC}-reg`,
    ]);
    expect(ari.calls.filter((c) => c.method === 'DELETE')).toHaveLength(5);
    // removal tolerates objects Asterisk does not have
    ari.on((c) => (c.method === 'DELETE' ? { status: 404 } : undefined));
    await expect(removeTrunk(client, ACC)).resolves.toBeUndefined();
    expect(await trunkState(client, ACC)).toBe('online');
  });
});
