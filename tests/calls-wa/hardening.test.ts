import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Redis } from 'ioredis';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CALL_LIMITS } from '../../src/config/limits';
import { FakeWaUser } from '../../src/core/telephony/whatsapp/fake-user';
import { WhatsAppCallLeg } from '../../src/core/telephony/whatsapp/leg';
import { WhatsAppPeer } from '../../src/core/telephony/whatsapp/peer';
import { tone } from '../../src/core/voice/audio/pcm';
import { CallModel } from '../../src/db/models/call.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { WhatsAppCallPermissionModel } from '../../src/db/models/whatsapp-call-permission.model';
import { CallRecorder } from '../../src/modules/calls/recording';
import { WhatsAppCallBilling, type CallQuote } from '../../src/modules/whatsapp-calling/billing';
import { CallControlBus } from '../../src/modules/whatsapp-calling/bus';
import { sweepOrphanedWhatsAppCalls } from '../../src/modules/whatsapp-calling/owner-sweep';
import { createCallPermissions } from '../../src/modules/whatsapp-calling/permissions.service';
import { createLogger } from '../../src/shared/logger';
import { expectWalletConsistent } from '../helpers/billing';
import { fund } from '../helpers/calls';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { useInboxWorld } from '../helpers/inbox';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';
import { expectNoUdpHandles } from '../helpers/udp';

useTestDb();
useCapturedEmail();
const world = useInboxWorld();
const { state } = world;
const silent = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const prefix = `${uniquePrefix('wa-hard')}:`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const timings: Record<string, number> = {};
// HARDENING_TIMINGS=<file> keeps the numbers for the sign-off (no console output in tests)
const keep = (name: string, value: number) => {
  timings[name] = Math.round(value);
  if (process.env.HARDENING_TIMINGS)
    writeFileSync(process.env.HARDENING_TIMINGS, JSON.stringify(timings, null, 2));
};

let redis: Redis;
let url: string;
const subs: Redis[] = [];
beforeAll(async () => {
  ({ client: redis, url } = await requireRedis());
  await world.setup();
});
afterAll(async () => {
  for (const s of subs) s.disconnect();
  await flushPrefix(redis, prefix);
  await expectNoUdpHandles();
});

describe('WhatsApp calling hardening', () => {
  it('50 concurrent loopback calls with recording: every customer hears us, every recording closes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cav-wa-hard-'));
    const cpu = process.cpuUsage();
    const started = performance.now();
    const rss = process.memoryUsage().rss;
    const calls = await Promise.all(
      Array.from({ length: 50 }, async (_, i) => {
        const peer = new WhatsAppPeer({ role: 'business', bindAddress: '127.0.0.1' });
        const user = new FakeWaUser();
        const leg = new WhatsAppCallLeg({
          peer,
          signaling: { terminate: () => Promise.resolve() },
        });
        const recorder = await CallRecorder.open(dir, `hard-${String(i)}`, 24_000);
        leg.onAudio((f) => {
          recorder.customer(f);
          recorder.tick();
        });
        await peer.applyAnswer(await user.answer(await peer.createOffer()));
        await Promise.all([peer.connected, user.connected]);
        return { leg, user, recorder };
      }),
    );
    keep('fiftyCallsSetupMs', performance.now() - started);
    for (const c of calls) {
      c.leg.answered();
      c.user.startTalking();
    }
    await Promise.all(
      calls.map((c) => c.leg.play(tone(600, 24_000, { hz: 1_000, amplitude: 8_000 }))),
    );
    await sleep(300);
    const peakRss = process.memoryUsage().rss;
    for (const c of calls) expect(c.user.stats.heardTone).toBe(true);
    const closed = await Promise.all(
      calls.map(async (c) => {
        await c.leg.hangup('normal');
        await c.user.hangup();
        return c.recorder.close();
      }),
    );
    for (const r of closed) expect(r.dataBytes).toBeGreaterThan(0);
    const used = process.cpuUsage(cpu);
    keep('fiftyCallsTotalMs', performance.now() - started);
    keep('fiftyCallsCpuMs', (used.user + used.system) / 1000);
    keep('fiftyCallsRssGrowthMb', (peakRss - rss) / 1_048_576);
    rmSync(dir, { recursive: true, force: true });
  });

  it('1,000 permission replies (in parallel, some twice): one row each, history once per reply', async () => {
    const permissions = createCallPermissions({
      ctx: world.w.ctx,
      token: (id) => world.w.svc.getChannelToken(id),
      inbox: state.ix,
    });
    const accountId = state.acc.account._id;
    const contacts = await ContactModel.insertMany(
      Array.from({ length: 1_000 }, (_, i) => ({
        accountId,
        phoneE164: `+9190071${String(i).padStart(5, '0')}`,
        source: { type: 'manual' },
      })),
    );
    const at = new Date();
    const started = performance.now();
    const reply = (contactId: Types.ObjectId, i: number) =>
      permissions.onReply({
        channel: state.channel,
        contactId,
        reply: {
          response: i % 10 === 0 ? 'reject' : 'accept',
          isPermanent: i % 3 === 0,
          expiresAt: null,
          source: 'user_action',
        },
        contextId: null,
        at,
      });
    for (let i = 0; i < contacts.length; i += 50) {
      await Promise.all(
        contacts.slice(i, i + 50).flatMap((c, j) => {
          const n = i + j;
          // every 20th reply arrives twice at the same time (Meta redelivery)
          return n % 20 === 0 ? [reply(c._id, n), reply(c._id, n)] : [reply(c._id, n)];
        }),
      );
    }
    keep('thousandRepliesMs', performance.now() - started);
    const rows = await WhatsAppCallPermissionModel.find({ accountId }).lean();
    expect(rows).toHaveLength(1_000);
    const declined = rows.filter((r) => r.status === 'declined').length;
    expect(declined).toBe(100);
    expect(rows.filter((r) => r.status === 'permanent').length).toBeGreaterThan(250);
    for (const r of rows) expect(r.history.length).toBeLessThanOrEqual(2);
  });

  it('200 calls × 10 settle attempts in mixed order: each call is charged once', async () => {
    const accountId = state.acc.account._id;
    await fund(accountId);
    const quote: CallQuote = {
      market: 'IN',
      rateCardId: null,
      perMinuteMicros: 388_500,
      markupBps: 1500,
      fixedPerMinuteMicros: null,
      platformFeePerMinuteMicros: 0,
      payer: 'platform',
      holdMinutes: 1,
      holdExtendMinutes: 1,
    };
    const started = performance.now();
    const billings = await Promise.all(
      Array.from({ length: 200 }, async () => {
        const b = new WhatsAppCallBilling({
          accountId: accountId.toString(),
          callId: new Types.ObjectId().toString(),
          quote,
          charged: true,
          withAi: false,
          conversationId: null,
        });
        await b.hold();
        return b;
      }),
    );
    // terminate webhooks (Meta's duration), our late timer and redeliveries race per call
    const attempts = billings.flatMap((b, i) =>
      Array.from({ length: 10 }, (_, k) =>
        k % 3 === 0
          ? () => b.settleCallPart(30 + (i % 7), 'ours')
          : () => b.settleCallPart(30, 'meta'),
      ),
    );
    for (let i = attempts.length - 1; i > 0; i -= 1) {
      const j = (i * 7919) % (i + 1);
      [attempts[i], attempts[j]] = [attempts[j]!, attempts[i]!];
    }
    await Promise.all(attempts.map((a) => a()));
    keep('twoThousandSettlesMs', performance.now() - started);
    const captured = await LedgerEntryModel.find({
      accountId,
      type: 'whatsapp_call_charge',
      status: 'captured',
    }).lean();
    expect(captured).toHaveLength(200);
    expect(new Set(captured.map((c) => c.ref.id)).size).toBe(200);
    expect(
      await LedgerEntryModel.countDocuments({
        accountId,
        type: 'whatsapp_call_charge',
        status: 'held',
      }),
    ).toBe(0);
    for (const b of billings) expect(b.settledCall?.price.pulses).toBeGreaterThanOrEqual(5);
    await expectWalletConsistent(accountId);
  });

  it('3 nodes on one Redis with random owner kills: every orphaned call fails once, the rest live on', async () => {
    const nodes = await Promise.all(
      ['n1', 'n2', 'n3'].map(async (nodeId) => {
        const subscriber = new Redis(url);
        subs.push(subscriber);
        const bus = new CallControlBus({ redis, subscriber, prefix, nodeId });
        await bus.start();
        return bus;
      }),
    );
    const accountId = state.acc.account._id;
    const owned = new Map<string, string[]>([
      ['n1', []],
      ['n2', []],
      ['n3', []],
    ]);
    // 90 inbound calls race for a claim on the three nodes: one owner each
    for (let i = 0; i < 90; i += 1) {
      const waCallId = `wacid.HARD${String(i)}`;
      const claims = await Promise.all(nodes.map((n) => n.claimInbound(waCallId)));
      expect(claims.filter(Boolean)).toHaveLength(1);
      const winner = nodes[claims.indexOf(true)]!;
      await winner.own(waCallId, () => undefined);
      owned.get(winner.nodeId)?.push(waCallId);
      await CallModel.create({
        accountId,
        direction: 'inbound',
        provider: 'whatsapp',
        from: '+919000000101',
        to: 'whatsapp:x',
        source: { kind: null },
        status: 'in_progress',
        timestamps: { queuedAt: new Date(), answeredAt: new Date() },
        whatsapp: { channelId: state.channel._id, waCallId, direction: 'USER_INITIATED' },
      });
    }
    // a pseudo-random node dies: its keys expire (no heartbeat any more)
    const victim = nodes[Number(process.hrtime.bigint() % 3n)]!;
    await victim.stop();
    for (const waCallId of owned.get(victim.nodeId) ?? [])
      await redis.del(`${prefix}call:wa:owner:${waCallId}`);
    const terminated: string[] = [];
    const sweep = () =>
      sweepOrphanedWhatsAppCalls({
        bus: nodes.find((n) => n !== victim)!,
        terminate: (call) => {
          terminated.push(call.whatsapp?.waCallId ?? '');
          return Promise.resolve();
        },
        logger: silent,
        now: new Date(Date.now() + CALL_LIMITS.maxCallSecHard * 1000),
      });
    const orphans = owned.get(victim.nodeId)?.length ?? 0;
    const [a, b] = await Promise.all([sweep(), sweep()]);
    expect((a?.failed ?? 0) + (b?.failed ?? 0)).toBe(orphans);
    expect(terminated.sort()).toEqual([...(owned.get(victim.nodeId) ?? [])].sort());
    expect(await CallModel.countDocuments({ accountId, status: 'in_progress' })).toBe(90 - orphans);
    expect(await sweep()).toEqual({ failed: 0 });
    for (const n of nodes) if (n !== victim) await n.stop();
  });
});
