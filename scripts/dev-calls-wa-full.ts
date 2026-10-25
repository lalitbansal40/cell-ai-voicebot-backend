/**
 * DEV ONLY — WhatsApp calling end to end (`npm run dev:calls-wa`, Phase 12 Batch 2) on
 * the dev database / Redis with the fake Meta: starts the real server on a random port
 * and drives it over HTTP like the app would — enable calling on the demo number →
 * request call permission from `…00023` (the fake customer allows) → an AI call to
 * `…00028` (the customer presses 1; the Loan recovery flow) → an inbound call that rings
 * the team and an agent answers on the media socket → a missed inbound call → the
 * wallet lines. Needs `npm run db:seed` first. Prints ids, statuses and numbers only —
 * never SDP, phones, names, digits or tokens.
 */
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { WebSocket } from 'ws';

import type { Env } from '../src/config/env';
import { FAKE_CALL_KNOBS } from '../src/core/meta';
import { AccountModel } from '../src/db/models/account.model';
import { ContactModel } from '../src/db/models/contact.model';
import { FlowModel } from '../src/db/models/flow.model';
import { MessageModel } from '../src/db/models/message.model';
import { NotificationModel } from '../src/db/models/notification.model';
import { RoleModel } from '../src/db/models/role.model';
import { UserModel } from '../src/db/models/user.model';
import { WA_ACTIVE_STATUSES, WhatsAppChannelModel } from '../src/db/models/whatsapp-channel.model';
import { signAccessToken } from '../src/modules/auth/tokens';
import { startServer } from '../src/server';
import { createLogger } from '../src/shared/logger';

import { SEED_FLOW_NAMES } from './seed-flows';
import { SEED_WHATSAPP_NUMBER } from './seed-whatsapp';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const runFull = async (env: Env): Promise<void> => {
  const logger = createLogger({ ...env, LOG_LEVEL: 'warn' });
  const step = (msg: string) => console.error(`dev:calls-wa — ${msg}`);
  const running = await startServer({
    env,
    logger,
    port: 0,
    installSignalHandlers: false,
    queuePrefix: 'dev-calls-wa',
    exit: () => undefined,
  });
  const base = `http://127.0.0.1:${String(running.port)}`;
  const out: Record<string, unknown> = {};
  let restore: () => Promise<void> = () => Promise.resolve();
  try {
    const account = await AccountModel.findOne({ slug: 'demo-finance' }).lean<{
      _id: Types.ObjectId;
    }>();
    if (!account) throw new Error('No "Demo Finance" account — run npm run db:seed');
    const channel = await WhatsAppChannelModel.findOne({
      accountId: account._id,
      displayPhoneNumber: SEED_WHATSAPP_NUMBER,
      status: { $in: WA_ACTIVE_STATUSES },
    }).lean<{ _id: Types.ObjectId }>();
    if (!channel) throw new Error('No demo WhatsApp number — run npm run db:seed');
    const channelId = channel._id.toString();
    const roleOf = async (key: string) =>
      (await RoleModel.findOne({ accountId: account._id, key }).select({ _id: 1 }).lean())?._id;
    const userWith = async (key: string) =>
      UserModel.findOne({ accountId: account._id, roleId: await roleOf(key), status: 'active' })
        .select({ _id: 1, accountId: 1, roleId: 1, tokenVersion: 1 })
        .lean<{
          _id: Types.ObjectId;
          accountId: Types.ObjectId;
          roleId: Types.ObjectId;
          tokenVersion: number;
        }>();
    const owner = await userWith('owner');
    const agent = (await userWith('agent')) ?? owner;
    if (!owner || !agent) throw new Error('No active owner / agent in Demo Finance');
    const tokenOf = async (u: NonNullable<typeof owner>) =>
      (
        await signAccessToken(
          {
            sub: u._id.toString(),
            acc: u.accountId.toString(),
            rid: u.roleId.toString(),
            tv: u.tokenVersion,
            sid: `dev_calls_wa_${randomUUID()}`,
          },
          '30m',
        )
      ).token;
    const ownerToken = await tokenOf(owner);
    const agentToken = await tokenOf(agent);
    const api = async (token: string, method: string, path: string, body?: unknown) => {
      const res = await fetch(`${base}/api/v1${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        data?: Record<string, unknown>;
        error?: { code?: string };
      };
      return { status: res.status, data: json.data ?? {}, code: json.error?.code ?? null };
    };
    const sim = (kind: string, extra: Record<string, unknown> = {}) =>
      api(ownerToken, 'POST', '/dev/meta/webhooks', { channelId, kind, ...extra });
    const until = async <T>(
      what: string,
      fn: () => Promise<T | null | undefined | false>,
      ms = 30_000,
    ) => {
      const end = Date.now() + ms;
      for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(200);
      }
    };
    const contactFor = async (digits: string) => {
      const phoneE164 = `+${digits}`;
      const found = await ContactModel.findOne({
        accountId: account._id,
        phoneE164,
        deletedAt: null,
      }).lean<{ _id: Types.ObjectId }>();
      return (
        found ??
        (await ContactModel.create({
          accountId: account._id,
          phoneE164,
          source: { type: 'manual' },
        }))
      )._id.toString();
    };
    const callOf = async (id: string) => (await api(ownerToken, 'GET', `/calls/${id}`)).data;
    const ended = (id: string) =>
      until(
        'the call to end',
        async () => {
          const c = await callOf(id);
          return (
            ['completed', 'failed', 'no_answer', 'busy', 'canceled'].includes(String(c.status)) && c
          );
        },
        60_000,
      );
    const balance = async () =>
      Number((await api(ownerToken, 'GET', '/wallet')).data.balanceMicros ?? 0);
    const before = await balance();

    // 0. the dev number reaches Meta's 2,000 messaging limit (calling needs it); the demo
    // calling window opens every day for this run (TRAI 09:00–21:00 IST still applies)
    const tier = await sim('call_tier_update');
    step(`messaging limit 2,000 → HTTP ${String(tier.status)}`);
    const accountDoc = await AccountModel.findById(account._id)
      .select({ 'settings.callingWindow': 1 })
      .lean<{ settings?: { callingWindow?: { days?: number[] } } }>();
    const days = accountDoc?.settings?.callingWindow?.days ?? null;
    await AccountModel.updateOne(
      { _id: account._id },
      { $set: { 'settings.callingWindow.days': [0, 1, 2, 3, 4, 5, 6] } },
    );
    restore = async () => {
      if (days)
        await AccountModel.updateOne(
          { _id: account._id },
          { $set: { 'settings.callingWindow.days': days } },
        );
    };

    // 1. calling on (Meta first), inbound rings the team for 10 s
    // (the worker applies the tier webhook a moment later)
    let enabled = { status: 0, data: {} as Record<string, unknown>, code: null as string | null };
    await until('calling to be available', async () => {
      enabled = await api(ownerToken, 'PATCH', `/whatsapp/channels/${channelId}/calling`, {
        status: 'enabled',
        inbound: { route: 'team', ringTimeoutSec: 10, ringUserIds: null },
      });
      return enabled.status === 200;
    });
    step(`calling settings → HTTP ${String(enabled.status)} (${String(enabled.data.status)})`);

    // 2. permission request in the window (the customer wrote first) → allowed by the fake
    const asker = `91900007${FAKE_CALL_KNOBS.permissionTemporary}`;
    const askerId = await contactFor(asker);
    await sim('inbound_text', { from: asker, text: 'Hello' });
    const request = await api(ownerToken, 'POST', '/whatsapp/call-permissions/request', {
      channelId,
      contactId: askerId,
    });
    // a second run finds the permission from the first (409 WHATSAPP_CALL_PERMISSION_EXISTS)
    step(
      `permission request → HTTP ${String(request.status)} (${String(typeof request.data.kind === 'string' ? request.data.kind : request.code)})`,
    );
    const permission = await until('the permission reply', async () => {
      const p = await api(
        ownerToken,
        'GET',
        `/whatsapp/call-permissions?channelId=${channelId}&contactId=${askerId}&refresh=true`,
      );
      return p.data.canCall === true && p.data;
    });
    out.permission = { status: permission.status, canCall: permission.canCall };

    // 3. an AI call (the Loan recovery flow): the customer presses 1 after the greeting
    const presser = `91900007${FAKE_CALL_KNOBS.pressesOne}`;
    const presserId = await contactFor(presser);
    await sim('inbound_text', { from: presser, text: 'Hi' });
    await api(ownerToken, 'POST', '/whatsapp/call-permissions/request', {
      channelId,
      contactId: presserId,
    });
    await sim('permission_reply_accept', { from: presser });
    await until('the second permission', async () => {
      const p = await api(
        ownerToken,
        'GET',
        `/whatsapp/call-permissions?channelId=${channelId}&contactId=${presserId}&refresh=true`,
      );
      return p.data.canCall === true;
    });
    const flow = await FlowModel.findOne({
      accountId: account._id,
      name: SEED_FLOW_NAMES.loan,
      deletedAt: null,
    })
      .select({ _id: 1 })
      .lean<{ _id: Types.ObjectId }>();
    if (!flow) throw new Error('No Loan recovery flow — run npm run db:seed');
    const aiCall = await api(ownerToken, 'POST', '/whatsapp/calls', {
      channelId,
      contactId: presserId,
      mode: 'ai',
      program: { kind: 'flow', id: flow._id.toString() },
    });
    step(`AI call → HTTP ${String(aiCall.status)}${aiCall.code ? ` ${aiCall.code}` : ''}`);
    if (aiCall.status === 201) {
      const aiId = String(aiCall.data.callId);
      await until(
        'the AI call to connect',
        async () => (await callOf(aiId)).status === 'in_progress',
      );
      // the customer pressed 1 after the greeting (knob); they hang up after the AI answers
      await sleep(15_000);
      await sim('user_hangup');
      const done = await ended(aiId);
      const timeline = (await api(ownerToken, 'GET', `/calls/${aiId}/events?limit=200`)).data;
      const items = (
        Array.isArray(timeline) ? timeline : ((timeline as { items?: unknown[] }).items ?? [])
      ) as {
        type?: string;
      }[];
      out.aiKeys = items.filter((e) => e.type === 'dtmf').length;
      out.aiCall = {
        status: done.status,
        endReason: done.endReason,
        durationSec: done.durationSec,
        metaDuration: (done.whatsapp as { metaDuration?: number } | null)?.metaDuration ?? null,
      };
    }

    // 4. the agent is online (events socket = presence) and answers an inbound call
    const wsTicket = await api(agentToken, 'POST', '/ws/tickets');
    const events = new WebSocket(
      `${base.replace('http', 'ws')}/ws/events?ticket=${String(wsTicket.data.ticket)}`,
    );
    await new Promise<void>((resolve, reject) => {
      events.once('open', () => resolve());
      events.once('error', reject);
    });
    await sleep(500);
    const caller = '919000071001';
    await contactFor(caller);
    const ring = await api(ownerToken, 'POST', '/dev/meta/calls/user-call', {
      channelId,
      from: caller,
    });
    step(`customer calls the number → HTTP ${String(ring.status)}`);
    const inbound = await until('the inbound call to ring', async () => {
      const list = await api(
        ownerToken,
        'GET',
        '/calls?provider=whatsapp&direction=inbound&limit=5',
      );
      const rows = list.data as unknown as
        { id: string; status: string }[] | { items?: { id: string; status: string }[] };
      const items = Array.isArray(rows) ? rows : (rows.items ?? []);
      return items.find((c) => c.status === 'ringing');
    });
    let answer = { status: 0, data: {} as Record<string, unknown>, code: null as string | null };
    await until(
      'the ring to reach the agent',
      async () => {
        answer = await api(agentToken, 'POST', `/whatsapp/calls/${inbound.id}/answer`);
        return answer.status === 200;
      },
      10_000,
    );
    const media = new WebSocket(
      `${base.replace('http', 'ws')}${String(answer.data.wsPath)}?ticket=${String(answer.data.mediaTicket)}`,
    );
    let agentHeard = 0;
    media.on('message', (data, binary) => {
      if (binary) agentHeard += 1;
      else if (
        Buffer.from(data as Buffer)
          .toString('utf8')
          .includes('call.config')
      )
        media.send(JSON.stringify({ type: 'call.ready', sampleRate: 24_000 }));
    });
    const silence = Buffer.alloc(960);
    const talk = setInterval(() => {
      if (media.readyState === WebSocket.OPEN) media.send(silence);
    }, 20);
    await until(
      'the agent to be connected',
      async () => (await callOf(inbound.id)).status === 'in_progress',
    );
    await sleep(3_000);
    await sim('user_hangup');
    const answered = await ended(inbound.id);
    clearInterval(talk);
    media.close();
    out.inboundAnswered = {
      status: answered.status,
      durationSec: answered.durationSec,
      agentFramesHeard: agentHeard,
    };

    // 5. nobody answers: missed after the 10 s ring
    events.close();
    await sleep(500);
    const missedRing = await api(ownerToken, 'POST', '/dev/meta/calls/user-call', {
      channelId,
      from: '919000071002',
    });
    step(`second customer call → HTTP ${String(missedRing.status)}`);
    const missed = await until(
      'the missed call',
      async () => {
        const list = await api(
          ownerToken,
          'GET',
          '/calls?provider=whatsapp&direction=inbound&limit=5',
        );
        const rows = list.data as unknown as
          | { id: string; status: string; endReason: string }[]
          | { items?: { id: string; status: string; endReason: string }[] };
        const items = Array.isArray(rows) ? rows : (rows.items ?? []);
        return items.find(
          (c) => c.id !== inbound.id && c.status !== 'ringing' && c.status !== 'in_progress',
        );
      },
      40_000,
    );
    const bubble = await MessageModel.findOne({
      'call.callId': new Types.ObjectId(missed.id),
    }).lean();
    out.missed = {
      status: missed.status,
      endReason: missed.endReason,
      bubble: bubble?.call?.outcome ?? null,
      bells: await NotificationModel.countDocuments({
        accountId: account._id,
        type: 'call.whatsapp_missed',
      }),
    };

    // 6. money
    const ledger = await api(
      ownerToken,
      'GET',
      '/wallet/ledger?type=whatsapp_call_charge&limit=10',
    );
    const rows = (
      Array.isArray(ledger.data)
        ? ledger.data
        : ((ledger.data as { items?: unknown[] }).items ?? [])
    ) as {
      status: string;
      amountMicros: number;
    }[];
    out.wallet = {
      beforeMicros: before,
      afterMicros: await balance(),
      callCharges: rows.filter((r) => r.status === 'captured').map((r) => r.amountMicros),
    };
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await restore();
    await running.lifecycle.shutdown('dev:calls-wa', 0);
  }
};
