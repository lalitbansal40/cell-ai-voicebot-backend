/**
 * DEV ONLY — WhatsApp calling on loopback (`npm run dev:calls-wa -- --poc`, first
 * version, Phase 12 Batch 1): the fake Meta (dev Redis, own key prefix) places a
 * business-initiated call to the fake customer `…00028` (answers, presses `1` after
 * 3 s); our `WhatsAppCallLeg` sends the agent tone (1 kHz), the customer sends 440 Hz,
 * then we hang up. Prints numbers only — never SDP, ICE data, phones, names or tokens.
 * Refuses production and the real Meta provider. Later batches add the full API run.
 */
import { loadEnv } from '../src/config/env';
import {
  buildFakeCode,
  callsValueSchema,
  createFakeMetaClient,
  fakeIds,
  FAKE_CALL_KNOBS,
} from '../src/core/meta';
import { closeAllRedis, getAppRedis } from '../src/core/queues/redis';
import { WhatsAppCallLeg } from '../src/core/telephony/whatsapp/leg';
import { WhatsAppPeer } from '../src/core/telephony/whatsapp/peer';
import { LEG_RATE } from '../src/core/telephony/whatsapp/resample';
import { hasTone } from '../src/core/telephony/whatsapp/tones';
import { tone } from '../src/core/voice/audio/pcm';
import { createLogger } from '../src/shared/logger';

const env = loadEnv();
if (env.NODE_ENV === 'production') {
  console.error('dev:calls-wa refuses to run in production');
  process.exit(1);
}
if (env.META_PROVIDER !== 'fake' || !env.WHATSAPP_ENABLED) {
  console.error('dev:calls-wa needs WHATSAPP_ENABLED=true and META_PROVIDER=fake');
  process.exit(1);
}
if (!process.argv.includes('--poc')) {
  console.error('usage: npm run dev:calls-wa -- --poc');
  process.exit(1);
}

const logger = createLogger(env);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  const redis = getAppRedis(env.REDIS_URL, logger);
  const fake = createFakeMetaClient({
    redis,
    prefix: 'dev-calls-wa:',
    appSecret: env.FAKE_META_APP_SECRET ?? 'dev-fake-meta-app-secret',
    callDelaysMs: env.FAKE_META_CALL_DELAYS_MS ?? [100, 200, 800],
  });
  const signup = {
    businessName: 'Dev Calling Business',
    phone: '+91 90000 69001',
    displayName: 'Dev Calling',
    mode: 'cloud_api' as const,
    outcome: 'finish' as const,
  };
  const { accessToken } = await fake.exchangeCode(buildFakeCode(signup));
  const { phoneNumberId } = fakeIds(signup.businessName, signup.phone);
  await fake.updateCallingSettings(accessToken, phoneNumberId, { status: 'ENABLED' });
  const customer = `91900007${FAKE_CALL_KNOBS.pressesOne}`;
  await fake.setCallPermission(phoneNumberId, customer, 'temporary');

  const peer = new WhatsAppPeer({ role: 'business', bindAddress: '127.0.0.1' });
  let waCallId = '';
  const leg = new WhatsAppCallLeg({
    peer,
    signaling: { terminate: () => fake.terminateCall(accessToken, phoneNumberId, waCallId) },
  });
  const heard: Int16Array[] = [];
  const digits: string[] = [];
  leg.onAudio((f) => heard.push(f));
  leg.onDtmf((d) => digits.push(d));

  const t0 = performance.now();
  let acceptedAt = 0;
  let durationSec: number | null = null;
  const pendingAnswers: string[] = [];
  // the Meta webhooks of this call (the calls service handles them in Batch 2)
  fake.setWebhookEmitter((body) => {
    const changes = (body as { entry: { changes: { field: string; value: unknown }[] }[] }).entry
      .flatMap((e) => e.changes)
      .filter((c) => c.field === 'calls');
    for (const c of changes) {
      const v = callsValueSchema.parse(c.value);
      for (const e of v.calls ?? []) {
        if (e.event === 'connect' && e.session?.sdp) pendingAnswers.push(e.session.sdp);
        if (e.event === 'terminate') {
          durationSec = e.duration === null || e.duration === undefined ? null : Number(e.duration);
          leg.remoteEnded('customer_hangup');
        }
      }
      for (const s of v.statuses ?? []) {
        const status = (s as { status?: string }).status;
        if (status === 'RINGING') leg.ringing();
        if (status === 'ACCEPTED') {
          acceptedAt = performance.now();
          leg.answered();
        }
      }
    }
    return Promise.resolve();
  });

  ({ waCallId } = await fake.startCall(accessToken, phoneNumberId, {
    to: customer,
    sdpOffer: await peer.createOffer(),
    bizOpaque: 'dev_call',
  }));
  while (!pendingAnswers.length) await sleep(10);
  await peer.applyAnswer(pendingAnswers[0] ?? '');
  await peer.connected;
  const setupMs = Math.round(performance.now() - t0);
  while (!acceptedAt) await sleep(10);
  await leg.play(tone(4_000, LEG_RATE, { hz: 1_000, amplitude: 8_000 }));
  await sleep(300);
  const view = (await fake.fakeCalls(phoneNumberId)).find((c) => c.waCallId === waCallId);
  const metrics = leg.metrics;
  await leg.hangup('normal');
  await sleep(200);
  const all = new Int16Array(heard.reduce((n, h) => n + h.length, 0));
  let o = 0;
  for (const h of heard) {
    all.set(h, o);
    o += h.length;
  }
  console.log(
    JSON.stringify(
      {
        setupMs,
        answeredAfterMs: Math.round(acceptedAt - t0),
        customerHeardAgentTone: view?.heardTone ?? false,
        customerHeardLevelDbfs:
          view?.heardLevel === null || view === undefined ? null : Math.round(view.heardLevel),
        businessHeardCustomerTone: hasTone(all.subarray(all.length >> 2), LEG_RATE, 440, 1_000),
        dtmfReceived: digits.length,
        durationSec,
        packetsIn: metrics.packetsIn,
        packetsOut: metrics.packetsOut,
        lossPct: metrics.lossPct,
        jitterMs: metrics.jitterMs,
      },
      null,
      2,
    ),
  );
  fake.setWebhookEmitter(null);
  await fake.stopCalls();
  await closeAllRedis();
};

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error('dev:calls-wa failed:', (err as Error).name);
    process.exit(1);
  },
);
