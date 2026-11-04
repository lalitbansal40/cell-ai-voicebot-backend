import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AriClient } from '../src/core/telephony/sip/ari-client';
import type { SipCallLeg } from '../src/core/telephony/sip/leg';
import { PortPool } from '../src/core/telephony/sip/port-pool';
import { SipTelephonyProvider } from '../src/core/telephony/sip/provider';
import type { HangupCause, LegStatus } from '../src/core/telephony/types';
import { rms, tone } from '../src/core/voice/audio/pcm';
import { systemClock } from '../src/core/voice/clock';

/**
 * Real Asterisk + SIPp (the lab trunk, deploy/asterisk/lab). The last digit of the number
 * picks what the "phone" does (scenarios/uas.xml).
 */
const lab = path.resolve(__dirname, '../deploy/asterisk/lab');
const password =
  /^ARI_PASSWORD\s*=\s*(\S+)/m.exec(readFileSync(path.join(lab, '.env.lab'), 'utf8'))?.[1] ?? '';
/** Docker Desktop: the container reaches the Mac here; on Linux CI it is the bridge gateway. */
const advertise =
  process.env.SIP_LAB_ADVERTISE ??
  execFileSync(
    'docker',
    ['exec', 'cav-sip-lab-asterisk', 'getent', 'ahostsv4', 'host.docker.internal'],
    {
      encoding: 'utf8',
    },
  ).split(/\s+/)[0]!;

let ari: AriClient;
let line: SipTelephonyProvider;
let n = 0;

beforeAll(async () => {
  ari = new AriClient({
    url: 'http://127.0.0.1:18088',
    user: 'cav',
    password,
    app: 'cav-lab',
    reconnectMaxMs: 1000,
  });
  ari.connect();
  const end = Date.now() + 10_000;
  while (!ari.connected) {
    if (Date.now() > end) throw new Error('lab ARI not reachable: npm run sip:lab');
    await new Promise((r) => setTimeout(r, 50));
  }
  line = new SipTelephonyProvider(ari, new PortPool(34000, 34099), systemClock, {
    trunk: 'trunk',
    format: 'ulaw',
    ringTimeoutSec: 4,
    mediaTimeoutSec: 30,
    rtpBindHost: process.env.SIP_LAB_BIND ?? '127.0.0.1',
    advertiseHost: advertise,
    asteriskRtpHost: '127.0.0.1',
    defaultCallerId: '+911600000000',
    app: 'cav-lab',
  });
});

afterAll(() => ari.close());

const call = async (lastDigit: string, amd: 'off' | 'hangup' | 'leave_message' = 'off') => {
  n += 1;
  const callId = `lab${String(Date.now())}${String(n)}`;
  const leg = await line.startCall({ callId, to: `+91900000000${lastDigit}`, amd });
  const statuses: [LegStatus, HangupCause | undefined][] = [];
  const ended = new Promise<HangupCause | undefined>((resolve) =>
    leg.onStatus((s, c) => {
      statuses.push([s, c]);
      if (s === 'ended') resolve(c);
    }),
  );
  const answered = new Promise<void>((resolve) =>
    leg.onStatus((s) => s === 'answered' && resolve()),
  );
  await leg.dial();
  return { leg, statuses, ended, answered };
};

const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
  ]);

describe('SIP lab: real Asterisk and SIPp (T18.17)', () => {
  it('answers and carries audio both ways (SIPp echoes what we send)', async () => {
    const c = await call('1');
    await within(c.answered, 8000);
    const heard: Int16Array[] = [];
    c.leg.onAudio((f) => heard.push(f));
    await c.leg.play(tone(1000, 8000, { amplitude: 8000 }));
    const end = Date.now() + 3000;
    while (heard.filter((f) => rms(f) > 500).length < 10 && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(heard.filter((f) => rms(f) > 500).length).toBeGreaterThanOrEqual(10);
    await c.leg.hangup('normal');
    expect(await within(c.ended, 5000)).toBe('normal');
    expect(c.leg.metrics.packetsOut).toBeGreaterThanOrEqual(50);
    expect(c.leg.metrics.packetsIn).toBeGreaterThan(0);
  });

  it.each([
    ['2', 'busy'],
    ['4', 'rejected'],
    ['5', 'invalid_number'],
    ['0', 'media_error'],
  ] as const)('number ending %s ends %s before the answer', async (digit, cause) => {
    const c = await call(digit);
    expect(await within(c.ended, 8000)).toBe(cause);
    expect(c.statuses.some(([s]) => s === 'answered')).toBe(false);
  });

  it('a phone that rings out ends no_answer', async () => {
    const c = await call('3');
    expect(await within(c.ended, 12_000)).toBe('no_answer');
    expect(c.statuses.map(([s]) => s)).toContain('ringing');
  });

  it('the customer hanging up after the answer ends customer_hangup', async () => {
    const c = await call('7');
    await within(c.answered, 8000);
    expect(await within(c.ended, 10_000)).toBe('customer_hangup');
  });

  it('answering machine detection: a long greeting is a machine, a short hello a person', async () => {
    const machine = await call('6', 'hangup');
    expect(await within(machine.ended, 15_000)).toBe('machine');
    expect(machine.leg.metrics.amd).toBe('MACHINE');
    const person = await call('8', 'hangup');
    await within(person.answered, 15_000);
    expect(person.leg.metrics.amd).toBe('HUMAN');
    await person.leg.hangup('normal');
    await within(person.ended, 5000);
  });

  it('transfers to an agent on the same trunk', async () => {
    const c = await call('1');
    await within(c.answered, 8000);
    const result = await within(
      c.leg.transfer({ phone: '+919000000009', last4: '0009' }, 8),
      10_000,
    );
    expect(result).toBe('connected');
    await c.leg.hangup('normal');
    await within(c.ended, 5000);
  });

  it('an Asterisk restart mid-call ends the call and the line works again (T18.13)', async () => {
    const c = await call('1');
    await within(c.answered, 8000);
    execFileSync('docker', ['restart', '-t', '0', 'cav-sip-lab-asterisk']);
    // Asterisk clears its channels on the way down (Q.850 16); if it can't, the reconnect does
    expect(['customer_hangup', 'media_error']).toContain(await within(c.ended, 30_000));
    const end = Date.now() + 30_000;
    while (!ari.connected && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
    // the line works again once the trunk endpoint is loaded (a few seconds after ARI)
    let cause: HangupCause | undefined;
    for (let i = 0; i < 10 && cause !== 'busy'; i += 1) {
      cause = await within((await call('2')).ended, 10_000);
      if (cause !== 'busy') await new Promise((r) => setTimeout(r, 1000));
    }
    expect(cause).toBe('busy');
  });

  it('frees every port and leg after the calls', () => {
    expect(line.live).toBe(0);
  });
});

export type { SipCallLeg };
