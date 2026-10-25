import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildFakeCode,
  buildMessagePayload,
  callsValueSchema,
  createFakeMetaClient,
  fakeIds,
  FAKE_CALL_KNOBS,
  type FakeMetaClient,
  type FakeSignup,
} from '../../src/core/meta';
import { createOpusCodec, OPUS_FRAME_SAMPLES } from '../../src/core/telephony/whatsapp/codec';
import { DtmfReceiver } from '../../src/core/telephony/whatsapp/dtmf';
import { DTMF_PT, OPUS_PT, WhatsAppPeer } from '../../src/core/telephony/whatsapp/peer';
import { hasTone } from '../../src/core/telephony/whatsapp/tones';
import { tone } from '../../src/core/voice/audio/pcm';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';
import { expectNoUdpHandles } from '../helpers/udp';

let redis: Redis;
let fake: FakeMetaClient;
const prefix = uniquePrefix('fake-calling');
const emitted: Record<string, unknown>[] = [];
const peers: WhatsAppPeer[] = [];

beforeAll(async () => {
  redis = (await requireRedis()).client;
  fake = createFakeMetaClient({
    redis,
    prefix,
    appSecret: 'fake-secret',
    statusDelaysMs: [5, 10, 15],
    callDelaysMs: [5, 10, 30],
  });
  fake.setWebhookEmitter((body) => {
    emitted.push(body);
    return Promise.resolve();
  });
});
afterAll(async () => {
  await fake.stopCalls();
  fake.stopStatusTimers();
  await Promise.all(peers.map((p) => p.close()));
  await flushPrefix(redis, prefix);
  redis.disconnect();
  await expectNoUdpHandles();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async <T>(
  fn: () => T | undefined | null | Promise<T | undefined | null>,
  ms = 5_000,
): Promise<T> => {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== null && v !== false) return v;
    if (Date.now() > until) throw new Error('timed out');
    await sleep(10);
  }
};

interface Change {
  field: string;
  value: Record<string, unknown>;
}
const changes = (): Change[] =>
  emitted.flatMap((b) => (b as { entry: { changes: Change[] }[] }).entry.flatMap((e) => e.changes));
const callEvents = (waCallId: string) =>
  changes()
    .filter((c) => c.field === 'calls')
    .map((c) => callsValueSchema.parse(c.value))
    .flatMap((v) => [
      ...(v.calls ?? [])
        .filter((e) => e.id === waCallId)
        .map((e) => ({ kind: e.event, e, errors: v.errors ?? [] })),
      ...(v.statuses ?? [])
        .filter((s) => (s as { id?: string }).id === waCallId)
        .map((s) => ({ kind: (s as { status: string }).status, e: null, errors: [] })),
    ]);
const kinds = (waCallId: string) => callEvents(waCallId).map((x) => x.kind);

let n = 0;
const connect = async (mode: FakeSignup['mode'] = 'cloud_api') => {
  n += 1;
  const s: FakeSignup = {
    businessName: `Calling Business ${String(n)}`,
    phone: `+91 90000 6${String(n).padStart(4, '0')}`,
    displayName: 'Test Business',
    mode,
    outcome: 'finish',
  };
  const { accessToken } = await fake.exchangeCode(buildFakeCode(s));
  const ids = fakeIds(s.businessName, s.phone);
  if (mode === 'cloud_api') {
    await fake.updateCallingSettings(accessToken, ids.phoneNumberId, { status: 'ENABLED' });
  }
  return { token: accessToken, phone: ids.phoneNumberId };
};
const customer = (knob: string) => `91900007${knob}`;

/** Our business side: offer → start → Meta's answer from the connect webhook. */
const dial = async (token: string, phone: string, to: string) => {
  const peer = new WhatsAppPeer({ role: 'business', bindAddress: '127.0.0.1' });
  peers.push(peer);
  const { waCallId } = await fake.startCall(token, phone, {
    to,
    sdpOffer: await peer.createOffer(),
    bizOpaque: 'call_test',
  });
  const answer = await waitFor(
    () => callEvents(waCallId).find((x) => x.kind === 'connect')?.e?.session?.sdp,
  );
  await peer.applyAnswer(answer);
  return { peer, waCallId };
};

describe('fake Meta calling — business-initiated calls', () => {
  it('needs calling on and a permission at Meta; knobs 00029 / 00030', async () => {
    const { token, phone } = await connect();
    const offer = 'v=0';
    await expect(
      fake.startCall(token, phone, { to: customer('00099'), sdpOffer: offer }),
    ).rejects.toMatchObject({ code: 138006 });
    await fake.setCallPermission(phone, customer(FAKE_CALL_KNOBS.connectFails), 'permanent');
    await expect(
      fake.startCall(token, phone, { to: customer(FAKE_CALL_KNOBS.connectFails), sdpOffer: offer }),
    ).rejects.toMatchObject({ code: 138004 });
    await fake.setCallPermission(phone, customer(FAKE_CALL_KNOBS.noPermission), 'permanent');
    await expect(
      fake.startCall(token, phone, { to: customer(FAKE_CALL_KNOBS.noPermission), sdpOffer: offer }),
    ).rejects.toMatchObject({ code: 138006 });
    expect(
      (await fake.getCallPermissions(token, phone, customer(FAKE_CALL_KNOBS.noPermission))).status,
    ).toBe('no_permission');
    await fake.updateCallingSettings(token, phone, { status: 'DISABLED' });
    await expect(
      fake.startCall(token, phone, { to: customer('00098'), sdpOffer: offer }),
    ).rejects.toMatchObject({ code: 138000 });
    const app = await connect('coexistence');
    await expect(
      fake.updateCallingSettings(app.token, app.phone, { status: 'ENABLED' }),
    ).rejects.toMatchObject({ code: 138013 });
  });

  it('connect → RINGING → ACCEPTED, two-way audio, terminate with the measured duration', async () => {
    const { token, phone } = await connect();
    const to = customer('00042');
    await fake.setCallPermission(phone, to, 'temporary');
    const { peer, waCallId } = await dial(token, phone, to);
    await peer.connected;
    await waitFor(() => kinds(waCallId).includes('ACCEPTED'));
    expect(kinds(waCallId).slice(0, 3)).toEqual(['connect', 'RINGING', 'ACCEPTED']);
    // business → customer: the agent tone (1 kHz); customer → business: 440 Hz
    const heard: Int16Array[] = [];
    const codec = createOpusCodec();
    peer.onPacket((p) => {
      if (p.payloadType === OPUS_PT) heard.push(codec.decode(p.payload));
    });
    const agent = tone(1_200, 48_000, { hz: 1_000, amplitude: 8_000 });
    for (let i = 0; i + OPUS_FRAME_SAMPLES <= agent.length; i += OPUS_FRAME_SAMPLES) {
      peer.sendPacket(OPUS_PT, codec.encode(agent.subarray(i, i + OPUS_FRAME_SAMPLES)), {
        samples: OPUS_FRAME_SAMPLES,
      });
      await sleep(20);
    }
    const calls = await fake.fakeCalls(phone);
    expect(calls[0]).toMatchObject({
      waCallId,
      toLast4: '0042',
      direction: 'BUSINESS_INITIATED',
      state: 'accepted',
      heardTone: true,
      connected: true,
    });
    expect(calls[0]?.heardLevel).toBeGreaterThan(-30);
    const all = new Int16Array(heard.reduce((s, h) => s + h.length, 0));
    let o = 0;
    for (const h of heard) {
      all.set(h, o);
      o += h.length;
    }
    expect(hasTone(all.subarray(all.length >> 2), 48_000, 440, 1_000)).toBe(true);
    await sleep(1_100);
    await fake.terminateCall(token, phone, waCallId);
    await fake.terminateCall(token, phone, waCallId); // idempotent
    const terminate = callEvents(waCallId).filter((x) => x.kind === 'terminate');
    expect(terminate).toHaveLength(1);
    expect(terminate[0]?.e).toMatchObject({
      status: 'COMPLETED',
      biz_opaque_callback_data: 'call_test',
      to_user_id: expect.stringMatching(/^IN\./) as string,
    });
    expect(Number(terminate[0]?.e?.duration)).toBeGreaterThanOrEqual(2);
    expect((await fake.fakeCalls(phone))[0]).toMatchObject({
      state: 'ended',
      endStatus: 'COMPLETED',
    });
    codec.destroy();
    // call analytics: one answered business call today, priced per 6-second pulse
    const wabaId = (await fake.listOwnedWabas(token))[0]?.id ?? '';
    const points = await fake.getCallAnalytics(token, wabaId, {
      start: new Date(Date.now() - 86_400_000),
      end: new Date(Date.now() + 86_400_000),
    });
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ direction: 'BUSINESS_INITIATED', country: 'IN', count: 1 });
    expect(points[0]?.cost).toBeGreaterThan(0);
    // a connected call resets the request counters and is counted (100 / 24 h)
    const p = await fake.getCallPermissions(token, phone, to);
    expect(p.actions.find((a) => a.action === 'start_call')?.limits[0]?.currentUsage).toBe(1);
    // a second live call with the same customer is refused (138003)
    const second = await dial(token, phone, to);
    const extra = new WhatsAppPeer({ role: 'business', bindAddress: '127.0.0.1' });
    peers.push(extra);
    await expect(
      fake.startCall(token, phone, { to, sdpOffer: await extra.createOffer() }),
    ).rejects.toMatchObject({ code: 138003 });
    await fake.terminateCall(token, phone, second.waCallId);
  });

  it('00021 rejects (REJECTED + terminate FAILED); 00020 answers after 2 s', async () => {
    const { token, phone } = await connect();
    const rejects = customer(FAKE_CALL_KNOBS.rejects);
    await fake.setCallPermission(phone, rejects, 'permanent');
    const r = await dial(token, phone, rejects);
    await waitFor(() => kinds(r.waCallId).includes('terminate'));
    expect(kinds(r.waCallId)).toEqual(['connect', 'RINGING', 'REJECTED', 'terminate']);
    expect(callEvents(r.waCallId).at(-1)?.e?.status).toBe('FAILED');

    const slow = customer(FAKE_CALL_KNOBS.answersAfter2s);
    await fake.setCallPermission(phone, slow, 'permanent');
    const started = Date.now();
    const s = await dial(token, phone, slow);
    await waitFor(() => kinds(s.waCallId).includes('ACCEPTED'), 5_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    await fake.terminateCall(token, phone, s.waCallId);
  });

  it('00022 never answers: four unanswered calls revoke the permission', async () => {
    const { token, phone } = await connect();
    const to = customer(FAKE_CALL_KNOBS.neverAnswers);
    await fake.setCallPermission(phone, to, 'permanent');
    for (let i = 0; i < 4; i += 1) {
      const { waCallId } = await dial(token, phone, to);
      await waitFor(() => kinds(waCallId).includes('RINGING'));
      await fake.terminateCall(token, phone, waCallId);
      expect(callEvents(waCallId).at(-1)?.e).not.toHaveProperty('duration');
    }
    expect((await fake.getCallPermissions(token, phone, to)).status).toBe('no_permission');
  });

  it('00021: four rejected calls count as not picked up and revoke the permission too', async () => {
    const { token, phone } = await connect();
    const to = customer(FAKE_CALL_KNOBS.rejects);
    await fake.setCallPermission(phone, to, 'permanent');
    for (let i = 0; i < 4; i += 1) {
      const { waCallId } = await dial(token, phone, to);
      await waitFor(() => kinds(waCallId).includes('terminate'));
    }
    expect((await fake.getCallPermissions(token, phone, to)).status).toBe('no_permission');
  });

  it('00027 hangs up after 5 s; 00028 presses 1 three seconds after media starts', async () => {
    const { token, phone } = await connect();
    const presses = customer(FAKE_CALL_KNOBS.pressesOne);
    await fake.setCallPermission(phone, presses, 'permanent');
    const p = await dial(token, phone, presses);
    const digits: string[] = [];
    const rx = new DtmfReceiver((d) => digits.push(d));
    p.peer.onPacket((pkt) => {
      if (pkt.payloadType === DTMF_PT) rx.push(pkt.payload, pkt.timestamp);
    });
    await waitFor(() => digits.length > 0, 6_000);
    expect(digits).toEqual(['1']);
    // the fake records the digit once its end packets are out
    await waitFor(async () => (await fake.fakeCalls(phone))[0]?.dtmfSent === '1' || undefined);
    await fake.terminateCall(token, phone, p.waCallId);

    const hangs = customer(FAKE_CALL_KNOBS.hangsUpAfter5s);
    await fake.setCallPermission(phone, hangs, 'permanent');
    const h = await dial(token, phone, hangs);
    await waitFor(() => kinds(h.waCallId).includes('ACCEPTED'));
    const accepted = Date.now();
    await waitFor(() => kinds(h.waCallId).includes('terminate'), 8_000);
    expect(Date.now() - accepted).toBeGreaterThanOrEqual(4_800);
    expect(callEvents(h.waCallId).at(-1)?.e).toMatchObject({ status: 'COMPLETED', duration: 5 });
  });
});

describe('fake Meta calling — user-initiated calls', () => {
  it('user_call → offer; pre_accept + accept (same SDP) → media; user hangup', async () => {
    const { token, phone } = await connect();
    const from = customer('00051');
    const { waCallId } = await fake.userCall(phone, from, {
      name: 'Test Customer',
      ctaPayload: 'loan_42',
    });
    const connectEv = callEvents(waCallId).find((x) => x.kind === 'connect');
    expect(connectEv?.e).toMatchObject({
      direction: 'USER_INITIATED',
      from,
      cta_payload: 'loan_42',
      from_user_id: expect.stringMatching(/^IN\./) as string,
    });
    const peer = new WhatsAppPeer({ role: 'business', bindAddress: '127.0.0.1' });
    peers.push(peer);
    const answer = await peer.answer(connectEv?.e?.session?.sdp ?? '');
    await fake.preAcceptCall(token, phone, waCallId, answer);
    await fake.acceptCall(token, phone, waCallId, answer, 'call_uic');
    await peer.connected;
    const got: number[] = [];
    peer.onPacket((p) => got.push(p.payloadType));
    await waitFor(() => got.length > 10);
    // UIC: no ACCEPTED status from Meta (statuses are for business-initiated calls)
    expect(kinds(waCallId)).toEqual(['connect']);
    expect(await fake.userDtmf(waCallId, '9')).toBe(true);
    expect(await fake.userHangup(waCallId)).toBe(true);
    expect(await fake.userHangup(waCallId)).toBe(false);
    expect(await fake.userDtmf(waCallId, '9')).toBe(false);
    expect(callEvents(waCallId).at(-1)?.e).toMatchObject({
      event: 'terminate',
      status: 'COMPLETED',
    });
  });

  it('accept with another SDP than pre_accept fails the call (138007); reject ends it', async () => {
    const { token, phone } = await connect();
    const a = await fake.userCall(phone, customer('00052'));
    const offer = callEvents(a.waCallId).find((x) => x.kind === 'connect')?.e?.session?.sdp ?? '';
    const p1 = new WhatsAppPeer({ role: 'business', bindAddress: '127.0.0.1' });
    const p2 = new WhatsAppPeer({ role: 'business', bindAddress: '127.0.0.1' });
    peers.push(p1, p2);
    await fake.preAcceptCall(token, phone, a.waCallId, await p1.answer(offer));
    await expect(
      fake.acceptCall(token, phone, a.waCallId, await p2.answer(offer)),
    ).rejects.toMatchObject({ code: 138007 });
    const term = callEvents(a.waCallId).find((x) => x.kind === 'terminate');
    expect(term?.e?.status).toBe('FAILED');
    expect(term?.errors[0]?.code).toBe(138007);

    const b = await fake.userCall(phone, customer('00053'));
    await fake.rejectCall(token, phone, b.waCallId);
    await fake.rejectCall(token, phone, b.waCallId);
    expect(kinds(b.waCallId)).toEqual(['connect', 'terminate']);
    await expect(fake.acceptCall(token, phone, b.waCallId, 'v=0')).rejects.toMatchObject({
      code: 138021,
    });
    await expect(fake.acceptCall(token, phone, 'wacid.NOPE', 'v=0')).rejects.toMatchObject({
      code: 100,
    });
  });

  it('a user call grants callback permission when the number has it on', async () => {
    const { token, phone } = await connect();
    await fake.updateCallingSettings(token, phone, { callbackPermissionStatus: 'ENABLED' });
    const from = customer('00054');
    const { waCallId } = await fake.userCall(phone, from);
    await waitFor(() =>
      changes().find(
        (c) =>
          c.field === 'messages' &&
          JSON.stringify(c.value).includes('automatic') &&
          JSON.stringify(c.value).includes(waCallId),
      ),
    );
    expect((await fake.getCallPermissions(token, phone, from)).status).toBe('temporary');
    await fake.userHangup(waCallId);
  });
});

describe('fake Meta calling — permissions, requests, settings', () => {
  const requestReply = (wamid: string) =>
    changes().find(
      (c) =>
        c.field === 'messages' &&
        JSON.stringify(c.value).includes('call_permission_reply') &&
        JSON.stringify(c.value).includes(`"id":"${wamid}"`),
    );

  it('request limits 1 / day and 2 / week; reply knobs 00023 / 00024 / 00025', async () => {
    const { token, phone } = await connect();
    const send = (to: string) =>
      fake.sendMessage(
        token,
        phone,
        buildMessagePayload(to, { type: 'call_permission_request', body: 'Call?' }),
      );
    const temp = customer(FAKE_CALL_KNOBS.permissionTemporary);
    const sent = await send(temp);
    const reply = await waitFor(() => requestReply(sent.waMessageId));
    expect(JSON.stringify(reply.value)).toContain('"response":"accept"');
    expect((await fake.getCallPermissions(token, phone, temp)).status).toBe('temporary');
    // the counter holds even after the answer: a second request today is refused
    const perm = await fake.getCallPermissions(token, phone, temp);
    const req = perm.actions.find((a) => a.action === 'send_call_permission_request');
    expect(req?.canPerform).toBe(false);
    expect(req?.limits[0]).toMatchObject({ timePeriod: 'PT24H', maxAllowed: 1, currentUsage: 1 });
    expect(req?.limits[0]?.limitExpiresAt).toBeInstanceOf(Date);
    await expect(send(temp)).rejects.toMatchObject({ code: 138009 });

    const permanent = customer(FAKE_CALL_KNOBS.permissionPermanent);
    const s2 = await send(permanent);
    await waitFor(() => requestReply(s2.waMessageId));
    expect((await fake.getCallPermissions(token, phone, permanent)).status).toBe('permanent');
    await expect(send(permanent)).rejects.toMatchObject({ code: 138017 });

    const declines = customer(FAKE_CALL_KNOBS.permissionDeclines);
    const s3 = await send(declines);
    const r3 = await waitFor(() => requestReply(s3.waMessageId));
    expect(JSON.stringify(r3.value)).toContain('"response":"reject"');
    expect((await fake.getCallPermissions(token, phone, declines)).status).toBe('no_permission');

    // other numbers: no reply (the simulator answers)
    const quiet = customer('00055');
    const s4 = await send(quiet);
    await sleep(80);
    expect(requestReply(s4.waMessageId)).toBeUndefined();
  });

  it('00026 old client: the request / call button fails 131026', async () => {
    const { token, phone } = await connect();
    const old = customer(FAKE_CALL_KNOBS.oldClient);
    const sent = await fake.sendMessage(
      token,
      phone,
      buildMessagePayload(old, { type: 'voice_call', body: 'Call us' }),
    );
    const failed = await waitFor(() =>
      changes().find(
        (c) =>
          c.field === 'messages' &&
          JSON.stringify(c.value).includes(sent.waMessageId) &&
          JSON.stringify(c.value).includes('"status":"failed"'),
      ),
    );
    expect(JSON.stringify(failed.value)).toContain('131026');
  });

  it('temporary permissions expire after their time', async () => {
    const { token, phone } = await connect();
    const to = customer('00056');
    await fake.setCallPermission(phone, to, 'temporary', new Date(Date.now() + 30));
    expect((await fake.getCallPermissions(token, phone, to)).expiresAt).toBeInstanceOf(Date);
    await sleep(60);
    expect((await fake.getCallPermissions(token, phone, to)).status).toBe('no_permission');
  });

  it('settings round-trip; a status change sends account_settings_update; restrictions show', async () => {
    const { token, phone } = await connect();
    const before = changes().length;
    await fake.updateCallingSettings(token, phone, {
      callIconVisibility: 'DISABLE_ALL',
      iconCountries: ['IN'],
      callHours: {
        status: 'ENABLED',
        timezoneId: 'Asia/Kolkata',
        weekly: [{ day: 'MONDAY', open: '0900', close: '1800' }],
        holidays: [],
      },
    });
    const s = await fake.getPhoneSettings(token, phone);
    expect(s).toMatchObject({
      status: 'ENABLED',
      callIconVisibility: 'DISABLE_ALL',
      iconCountries: ['IN'],
      callHours: { weekly: [{ day: 'MONDAY', open: '0900', close: '1800' }] },
    });
    const update = await waitFor(() =>
      changes()
        .slice(before)
        .find(
          (c) =>
            c.field === 'account_settings_update' &&
            JSON.stringify(c.value).includes('DISABLE_ALL'),
        ),
    );
    expect(JSON.stringify(update.value)).toContain(phone);
    // call hours only → no webhook (Meta fires for status / icon / callback / SIP)
    const mid = changes().length;
    await fake.updateCallingSettings(token, phone, {
      callHours: { status: 'DISABLED', timezoneId: 'Asia/Kolkata', weekly: [], holidays: [] },
    });
    await sleep(30);
    expect(
      changes()
        .slice(mid)
        .some((c) => c.field === 'account_settings_update'),
    ).toBe(false);
    await expect(
      fake.updateCallingSettings(token, phone, {
        callHours: {
          status: 'ENABLED',
          timezoneId: 'Asia/Kolkata',
          weekly: [{ day: 'MONDAY', open: '1800', close: '0900' }],
          holidays: [],
        },
      }),
    ).rejects.toMatchObject({ code: 100 });

    await fake.setCallingRestriction(phone, {
      type: 'RESTRICTED_BUSINESS_INITIATED_CALLING',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect((await fake.getPhoneSettings(token, phone)).restrictions[0]).toMatchObject({
      type: 'RESTRICTED_BUSINESS_INITIATED_CALLING',
      reason: 'Paused after negative feedback',
    });
    await fake.setCallingRestriction(phone, null);
    expect((await fake.getPhoneSettings(token, phone)).restrictions).toEqual([]);
  });

  it('calling methods need the number’s token; the call log never shows the full phone', async () => {
    const { phone } = await connect();
    await expect(fake.getPhoneSettings('fake_tok_bad', phone)).rejects.toMatchObject({ code: 190 });
    const view = JSON.stringify(await fake.fakeCalls(phone));
    expect(view).not.toMatch(/91900007\d{5}/);
    expect(fake.calls.map((c) => c.op)).toEqual(
      expect.arrayContaining(['startCall', 'getPhoneSettings', 'updateCallingSettings']),
    );
  });

  it('stopCalls hangs up every fake customer', async () => {
    const { token, phone } = await connect();
    const to = customer('00057');
    await fake.setCallPermission(phone, to, 'permanent');
    const { peer, waCallId } = await dial(token, phone, to);
    await peer.connected;
    await fake.stopCalls();
    // shutdown sends no webhooks: the stored state stays as it was
    expect((await fake.fakeCalls(phone)).find((c) => c.waCallId === waCallId)?.state).not.toBe(
      'ended',
    );
    expect(await fake.userDtmf(waCallId, '1')).toBe(false);
  });
});
