import { Redis } from 'ioredis';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { WHATSAPP_CALL_LIMITS } from '../../src/config/limits';
import { signWebhook } from '../../src/core/meta';
import { CallModel } from '../../src/db/models/call.model';
import { MetaWebhookEventModel } from '../../src/db/models/meta-webhook-event.model';
import type { CallsFastPathEvent } from '../../src/modules/whatsapp/context';
import { callsOf, receiveWebhook } from '../../src/modules/whatsapp/webhooks.service';
import {
  hasDeferredCallEvents,
  IGNORED_STALE,
  ignoreStaleCallEvents,
} from '../../src/modules/whatsapp-calling/backfill';
import {
  CallControlBus,
  createNodeId,
  type BusMessage,
} from '../../src/modules/whatsapp-calling/bus';
import { sweepOrphanedWhatsAppCalls } from '../../src/modules/whatsapp-calling/owner-sweep';
import { AppError } from '../../src/shared/errors/app-error';
import { createLogger } from '../../src/shared/logger';
import { useTestDb } from '../helpers/db';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';
import { useWhatsAppWorld, webhookFor } from '../helpers/whatsapp';

useTestDb();
const world = useWhatsAppWorld();
const prefix = `${uniquePrefix('call-bus')}:`;
const silent = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
let redis: Redis;
let url: string;
const subs: Redis[] = [];
const buses: CallControlBus[] = [];

beforeAll(async () => {
  ({ client: redis, url } = await requireRedis());
});
afterAll(async () => {
  for (const b of buses) await b.stop();
  for (const s of subs) s.disconnect();
  await flushPrefix(redis, prefix);
  redis.disconnect();
});

const bus = async (nodeId: string, capacity?: { active: number; max: number }) => {
  const subscriber = new Redis(url);
  subs.push(subscriber);
  const b = new CallControlBus({
    redis,
    subscriber,
    prefix,
    nodeId,
    ...(capacity ? { capacity: () => capacity } : {}),
  });
  await b.start();
  await b.start(); // idempotent
  buses.push(b);
  return b;
};

describe('call-control bus', () => {
  it('node ids name the host and process', () => {
    expect(createNodeId()).toMatch(new RegExp(`:${String(process.pid)}:[0-9a-f]{8}$`));
    expect(createNodeId()).not.toBe(createNodeId());
  });

  it('messages reach the owner of a call — locally or across nodes', async () => {
    const a = await bus('a1');
    const b = await bus('b1');
    const got: BusMessage[] = [];
    await a.own('wacid.ONE', (m) => {
      got.push(m);
    });
    expect(await b.ownerOf('wacid.ONE')).toBe('a1');
    const ttl = await redis.ttl(`${prefix}call:wa:owner:wacid.ONE`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(WHATSAPP_CALL_LIMITS.ownerTtlSec);
    const msg: BusMessage = { type: 'call', waCallId: 'wacid.ONE', action: 'answer' };
    expect(await b.toOwner('wacid.ONE', msg)).toBe('forwarded');
    expect(await a.toOwner('wacid.ONE', { ...msg, action: 'local' })).toBe('local');
    await vi.waitFor(() =>
      expect(got.map((m) => (m as { action: string }).action)).toEqual(
        expect.arrayContaining(['answer', 'local']),
      ),
    );
    expect(await b.toOwner('wacid.NOBODY', msg)).toBe('no_owner');
    // a node never deletes another node's ownership
    await b.release('wacid.ONE');
    expect(await a.ownerOf('wacid.ONE')).toBe('a1');
    await a.release('wacid.ONE');
    expect(await a.ownerOf('wacid.ONE')).toBeNull();
    // bad JSON on a channel is ignored
    await redis.publish(`${prefix}call:ctl:a1`, 'not json');
  });

  it('an inbound call is claimed by exactly one of three racing nodes; full nodes never claim', async () => {
    const nodes = await Promise.all([bus('n1'), bus('n2'), bus('n3')]);
    const seen: string[] = [];
    for (const n of nodes) {
      n.onInbound(async (m) => {
        if (m.type === 'calls_event' && (await n.claimInbound(m.waCallId))) seen.push(n.nodeId);
      });
    }
    await nodes[0]?.toAll({
      type: 'calls_event',
      eventId: 'e1',
      waCallId: 'wacid.IN1',
      kind: 'connect',
    });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toHaveLength(1);
    const results = await Promise.all(nodes.map((n) => n.claimInbound('wacid.IN2')));
    expect(results.filter(Boolean)).toHaveLength(1);
    const full = await bus('full', { active: 50, max: 50 });
    expect(await full.claimInbound('wacid.IN3')).toBe(false);
    expect(await nodes[1]?.claimInbound('wacid.IN3')).toBe(true);
  });

  it('first answer wins', async () => {
    const a = await bus('ans-a');
    const b = await bus('ans-b');
    const callId = new Types.ObjectId().toString();
    const [x, y] = await Promise.all([
      a.claimAnswer(callId, 'user-1'),
      b.claimAnswer(callId, 'user-2'),
    ]);
    expect(x).toBe(y);
    expect(await a.claimAnswer(callId, 'user-3')).toBe(x);
  });

  it('agent commands run on the media owner and keep their error codes across nodes', async () => {
    const media = await bus('cmd-media');
    const api = await bus('cmd-api');
    const callId = new Types.ObjectId().toString();
    const base = { callId, accountId: 'acc', userId: 'u1' };
    // nobody owns the call yet
    await expect(api.command({ ...base, action: 'answer' })).rejects.toMatchObject({
      code: 'CALL_NOT_ACTIVE',
    });
    await media.ownCall(callId);
    const seen: string[] = [];
    media.onCommand((command) => {
      seen.push(command.action);
      if (command.action === 'decline') return Promise.reject(new AppError('WHATSAPP_CALL_TAKEN'));
      return Promise.resolve({ ok: command.userId });
    });
    expect(await api.command({ ...base, action: 'answer' })).toEqual({ ok: 'u1' });
    expect(await media.command({ ...base, action: 'answer' })).toEqual({ ok: 'u1' });
    await expect(api.command({ ...base, action: 'decline' })).rejects.toMatchObject({
      code: 'WHATSAPP_CALL_TAKEN',
    });
    expect(seen).toEqual(['answer', 'answer', 'decline']);
    // an owner that never answers times out instead of hanging the request
    const silentNode = await bus('cmd-silent');
    const quiet = new Types.ObjectId().toString();
    await silentNode.ownCall(quiet);
    silentNode.onCommand(() => new Promise(() => undefined));
    await expect(
      api.command({ ...base, callId: quiet, action: 'hold' }, 200),
    ).rejects.toMatchObject({ code: 'CALL_NOT_ACTIVE' });
  });

  it('an agent holds one call at a time; only that call releases the claim', async () => {
    const a = await bus('agent-a');
    const b = await bus('agent-b');
    expect(await a.claimAgent('acc', 'u1', 'call-1')).toBe(true);
    expect(await b.claimAgent('acc', 'u1', 'call-1')).toBe(true); // the same call again
    expect(await b.claimAgent('acc', 'u1', 'call-2')).toBe(false);
    expect(await b.claimAgent('acc', 'u2', 'call-2')).toBe(true); // another agent
    expect(await b.claimAgent('other', 'u1', 'call-3')).toBe(true); // another account
    await b.releaseAgent('acc', 'u1', 'call-2'); // not its claim: kept
    expect(await a.claimAgent('acc', 'u1', 'call-2')).toBe(false);
    await a.releaseAgent('acc', 'u1', 'call-1');
    expect(await a.claimAgent('acc', 'u1', 'call-2')).toBe(true);
  });

  it('hangups find the node of any live call', async () => {
    const a = await bus('h-a');
    const b = await bus('h-b');
    const ended: string[] = [];
    a.onHangup((callId) => {
      if (callId !== 'call-1') return Promise.resolve(false);
      ended.push(callId);
      return Promise.resolve(true);
    });
    await a.ownCall('call-1');
    expect(await b.nodeOfCall('call-1')).toBe('h-a');
    expect(await b.hangup('call-1')).toBe('forwarded');
    await vi.waitFor(() => expect(ended).toEqual(['call-1']));
    expect(await a.hangup('call-1')).toBe('local');
    expect(await b.hangup('call-unknown')).toBe('not_live');
    await a.releaseCall('call-1');
    expect(await b.nodeOfCall('call-1')).toBeNull();
    // stop releases what the node held
    await a.ownCall('call-2');
    await a.own('wacid.TWO');
    await a.stop();
    expect(await b.nodeOfCall('call-2')).toBeNull();
    expect(await b.ownerOf('wacid.TWO')).toBeNull();
  });
});

describe('owner loss', () => {
  it('a live WhatsApp call without an owner is failed (server_shutdown) and terminated once', async () => {
    const a = await bus('sweep-a');
    const now = new Date(Date.now() + 60_000);
    const make = (waCallId: string, status = 'in_progress') =>
      CallModel.create(<Record<string, unknown>>{
        accountId: new Types.ObjectId(),
        direction: 'outbound',
        provider: 'whatsapp',
        from: 'whatsapp',
        to: 'whatsapp',
        mode: 'human',
        source: { kind: null },
        status,
        timestamps: { queuedAt: new Date(), answeredAt: new Date(Date.now() - 10_000) },
        whatsapp: { channelId: new Types.ObjectId(), waCallId, direction: 'BUSINESS_INITIATED' },
      });
    const orphan = await make('wacid.ORPHAN');
    const owned = await make('wacid.OWNED');
    const ended = await make('wacid.DONE', 'completed');
    await a.own('wacid.OWNED');
    const terminated: string[] = [];
    const deps = {
      bus: a,
      terminate: (c: { whatsapp: { waCallId: string | null } | null }) => {
        terminated.push(c.whatsapp?.waCallId ?? '');
        return c.whatsapp?.waCallId === 'wacid.ORPHAN'
          ? Promise.reject(new Error('meta down'))
          : Promise.resolve();
      },
      logger: silent,
      now,
    };
    expect(await sweepOrphanedWhatsAppCalls(deps as never)).toEqual({ failed: 1 });
    expect(await sweepOrphanedWhatsAppCalls(deps as never)).toEqual({ failed: 0 });
    expect(terminated).toEqual(['wacid.ORPHAN']);
    const o = await CallModel.findById(orphan._id).lean();
    expect(o).toMatchObject({ status: 'failed', endReason: 'server_shutdown' });
    expect(o?.whatsapp?.timeline.map((t) => t.event)).toEqual(['owner_lost']);
    expect((await CallModel.findById(owned._id).lean())?.status).toBe('in_progress');
    expect((await CallModel.findById(ended._id).lean())?.status).toBe('completed');
  });
});

describe('webhook fast path + Phase 9 calls backfill', () => {
  const channel = {
    wabaId: '102290129340398',
    phoneNumberId: '106540352242922',
    displayPhoneNumber: '919000000010',
  };
  const post = async (fixture: string, fast: CallsFastPathEvent[], fail = false) => {
    const raw = Buffer.from(JSON.stringify(webhookFor(fixture, channel)));
    const ids: string[] = [];
    const ctx = {
      ...world.ctx,
      callsFastPath: (e: CallsFastPathEvent) => {
        fast.push(e);
        return fail ? Promise.reject(new Error('redis down')) : Promise.resolve();
      },
    };
    const receipt = await receiveWebhook(
      ctx,
      { enqueueEvent: (id) => (ids.push(id), Promise.resolve()) },
      raw,
      signWebhook(raw, world.env.FAKE_META_APP_SECRET ?? ''),
    );
    return { receipt, ids };
  };

  it('a new calls event goes to the bus at once (ids + kinds) and is still queued for the worker', async () => {
    const fast: CallsFastPathEvent[] = [];
    const first = await post('calls-connect-bic.json', fast);
    expect(first.receipt.received).toBe(1);
    expect(first.ids).toHaveLength(1);
    expect(fast).toEqual([
      {
        eventId: first.ids[0],
        waCallId: 'wacid.HBgMOTE5MDAwMDAwMTAxFQIAEhggRDEyMzQ1Njc4OUFCQ0RFRjAA',
        kind: 'connect',
      },
    ]);
    // Meta redelivers: stored once, no second fast-path message
    const again = await post('calls-connect-bic.json', fast);
    expect(again.receipt.duplicates).toBe(1);
    expect(fast).toHaveLength(1);
    // statuses carry their status as the kind; a failing publish never fails Meta's request
    const status = await post('calls-status-ringing.json', fast, true);
    expect(status.receipt.received).toBe(1);
    expect(fast.at(-1)?.kind).toBe('RINGING');
    // other fields never use the fast path
    await post('call-permission-reply-temporary.json', fast);
    expect(fast).toHaveLength(2);
  });

  it('callsOf reads events and statuses, ignores junk', () => {
    expect(callsOf(null)).toEqual([]);
    expect(
      callsOf({
        calls: [{ id: 'x' }, { id: 'y', event: 'terminate' }],
        statuses: [{ id: 'z', status: 'accepted' }, {}],
      }),
    ).toEqual([
      { waCallId: 'y', kind: 'terminate' },
      { waCallId: 'z', kind: 'ACCEPTED' },
    ]);
  });

  it('calls events deferred before Phase 12 are marked ignored_stale once', async () => {
    const make = (field: string, status: string) =>
      MetaWebhookEventModel.create(<Record<string, unknown>>{
        key: new Types.ObjectId().toString(),
        object: 'whatsapp_business_account',
        field,
        payloadSealed: 'x',
        status,
        receivedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      });
    const stale = await make('calls', 'deferred');
    const other = await make('messages', 'deferred');
    expect(await hasDeferredCallEvents()).toBe(true);
    expect(await ignoreStaleCallEvents(world.ctx)).toBeGreaterThanOrEqual(1);
    expect(await hasDeferredCallEvents()).toBe(false);
    expect(await ignoreStaleCallEvents(world.ctx)).toBe(0);
    expect(await MetaWebhookEventModel.findById(stale._id).lean()).toMatchObject({
      status: 'ignored',
      error: IGNORED_STALE,
    });
    expect((await MetaWebhookEventModel.findById(other._id).lean())?.status).toBe('deferred');
  });
});
