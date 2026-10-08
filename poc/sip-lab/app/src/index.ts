/**
 * cav-lab ARI app (T0.16).
 *
 * SIP call enters Stasis("cav-lab") → answer → beep → mixing bridge with an
 * ExternalMedia channel that streams the call audio (G.711 μ-law RTP) to this
 * process on UDP :RTP_PORT. Logs DTMF, hangs up after CALL_SECONDS, writes
 * output/<callId>/{caller.wav, summary.json}. Optional ECHO=1 sends the audio back.
 */
import dgram from 'node:dgram';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

import { mulawWav, parseRtp } from './rtp.ts';

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing env ${name}`);
  return value;
};

const ARI_URL = env('ARI_URL', 'http://127.0.0.1:8088');
const ARI_USER = env('ARI_USER');
const ARI_PASSWORD = env('ARI_PASSWORD');
const APP = 'cav-lab';
const RTP_PORT = Number(env('RTP_PORT', '40000'));
/** host:port Asterisk (inside Docker) uses to reach this process. */
const EXTERNAL_HOST = env('EXTERNAL_HOST', `host.docker.internal:${RTP_PORT}`);
const CALL_SECONDS = Number(env('CALL_SECONDS', '15'));
const ECHO = env('ECHO', '0') === '1';
const TIMEOUT_MS = Number(env('LAB_TIMEOUT_MS', '90000'));
const OUTPUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'output');

const t0 = performance.now();
const now = () => Math.round(performance.now() - t0);
const timeline: { t: number; event: string; detail?: string }[] = [];
const note = (event: string, detail?: string) => {
  timeline.push({ t: now(), event, detail });
  console.info(`[${now()} ms] ${event}${detail ? ` — ${detail}` : ''}`);
};

const auth = `Basic ${Buffer.from(`${ARI_USER}:${ARI_PASSWORD}`).toString('base64')}`;
const ari = async (
  method: string,
  route: string,
  query: Record<string, string> = {},
): Promise<unknown> => {
  const url = new URL(`/ari${route}`, ARI_URL);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, { method, headers: { Authorization: auth } });
  const body = await res.text();
  if (!res.ok) throw new Error(`ARI ${method} ${route} → ${res.status} ${body}`);
  return body ? (JSON.parse(body) as unknown) : undefined;
};

// ── RTP receiver ──────────────────────────────────────────────────────────
const audio: Buffer[] = [];
const payloadTypes = new Set<number>();
let rtpPackets = 0;
let echoPackets = 0;
let firstRtpAt: number | undefined;
const udp = dgram.createSocket('udp4');
udp.on('message', (msg, rinfo) => {
  const packet = parseRtp(msg);
  if (!packet) return;
  rtpPackets += 1;
  firstRtpAt ??= now();
  if (rtpPackets === 1)
    note('first RTP packet', `from ${rinfo.address}:${rinfo.port}, pt=${packet.payloadType}`);
  payloadTypes.add(packet.payloadType);
  audio.push(Buffer.from(packet.payload));
  if (ECHO) {
    udp.send(msg, rinfo.port, rinfo.address);
    echoPackets += 1;
  }
});

// ── Call handling ─────────────────────────────────────────────────────────
interface Channel {
  id: string;
  name: string;
  caller?: { number?: string };
}

let callerId: string | undefined;
let externalId: string | undefined;
let bridgeId: string | undefined;
const dtmf: string[] = [];
const errors: string[] = [];
let finished = false;

const finish = async (reason: string): Promise<void> => {
  if (finished) return;
  finished = true;
  note('finish', reason);
  for (const [kind, id] of [
    ['channels', externalId],
    ['bridges', bridgeId],
  ] as const) {
    if (id) await ari('DELETE', `/${kind}/${id}`).catch(() => undefined);
  }
  const bytes = Buffer.concat(audio);
  const dir = path.join(OUTPUT_DIR, callerId ?? `no-call-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'caller.wav'), mulawWav(bytes));
  const summary = {
    reason,
    callerChannelId: callerId,
    externalMediaChannelId: externalId,
    externalHost: EXTERNAL_HOST,
    rtpPackets,
    audioSeconds: bytes.length / 8000,
    payloadTypes: [...payloadTypes],
    firstRtpAtMs: firstRtpAt,
    dtmf,
    echo: { enabled: ECHO, packetsSent: echoPackets },
    errors,
    timeline,
    ok: rtpPackets > 0 && dtmf.length > 0 && errors.length === 0,
  };
  writeFileSync(path.join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(
    path.join(OUTPUT_DIR, 'last-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.info(
    `\nSUMMARY ${summary.ok ? 'OK' : 'FAILED'}: rtpPackets=${rtpPackets} audio=${summary.audioSeconds}s dtmf=${dtmf.join('') || '-'} errors=${errors.length}`,
  );
  udp.close();
  events.close();
  process.exit(summary.ok ? 0 : 1);
};

const onCaller = async (channel: Channel): Promise<void> => {
  callerId = channel.id;
  note('StasisStart (caller)', `${channel.name} from ${channel.caller?.number ?? '?'}`);
  await ari('POST', `/channels/${channel.id}/answer`);
  note('answered');
  setTimeout(() => {
    note('hangup timer', `${CALL_SECONDS}s`);
    ari('DELETE', `/channels/${channel.id}`).catch((err: Error) =>
      errors.push(`hangup: ${err.message}`),
    );
  }, CALL_SECONDS * 1000);
  // `tone:` cadences repeat forever and a playing channel can't join a bridge,
  // so stop the beep after 800 ms.
  try {
    const playback = (await ari('POST', `/channels/${channel.id}/play`, {
      media: 'tone:440/800',
    })) as { id: string };
    await new Promise((r) => setTimeout(r, 800));
    await ari('DELETE', `/playbacks/${playback.id}`).catch(() => undefined);
    note('beep played');
  } catch (err) {
    errors.push(`play: ${(err as Error).message}`);
  }
  const bridge = (await ari('POST', '/bridges', { type: 'mixing', name: 'cav-lab' })) as {
    id: string;
  };
  bridgeId = bridge.id;
  const external = (await ari('POST', '/channels/externalMedia', {
    app: APP,
    external_host: EXTERNAL_HOST,
    format: 'ulaw',
    encapsulation: 'rtp',
    transport: 'udp',
    direction: 'both',
  })) as Channel;
  externalId = external.id;
  note('ExternalMedia created', `${external.name} → ${EXTERNAL_HOST}`);
  await ari('POST', `/bridges/${bridge.id}/addChannel`, {
    channel: `${channel.id},${external.id}`,
  });
  note('bridged caller + external media');
};

const events = new WebSocket(
  `${ARI_URL.replace(/^http/, 'ws')}/ari/events?app=${APP}&api_key=${encodeURIComponent(`${ARI_USER}:${ARI_PASSWORD}`)}`,
);

events.on('open', () => note('ARI events connected', `app=${APP}, waiting for a call to 100…`));
events.on('error', (err) => {
  errors.push(`events: ${err.message}`);
  void finish('ARI events error');
});
events.on('message', (raw) => {
  const e = JSON.parse(raw.toString()) as { type: string; channel?: Channel; digit?: string };
  switch (e.type) {
    case 'StasisStart':
      if (!e.channel) return;
      if (e.channel.name.startsWith('UnicastRTP/')) {
        note('StasisStart (external media)', e.channel.name);
        return;
      }
      onCaller(e.channel).catch((err: Error) => {
        errors.push(`call setup: ${err.message}`);
        void finish('call setup failed');
      });
      break;
    case 'ChannelDtmfReceived':
      if (e.digit) {
        dtmf.push(e.digit);
        note('DTMF', e.digit);
      }
      break;
    case 'StasisEnd':
      if (e.channel?.id === callerId) void finish('caller left Stasis');
      break;
    default:
  }
});

udp.bind(RTP_PORT, '0.0.0.0', () =>
  note('RTP listener', `udp :${RTP_PORT} (echo ${ECHO ? 'on' : 'off'})`),
);
setTimeout(() => {
  errors.push(`timeout after ${TIMEOUT_MS} ms`);
  void finish('timeout');
}, TIMEOUT_MS).unref();
