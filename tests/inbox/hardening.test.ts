import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { signWebhook } from '../../src/core/meta';
import { ConversationModel } from '../../src/db/models/conversation.model';
import { MessageModel } from '../../src/db/models/message.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import { importHistoryEvent } from '../../src/modules/inbox/coexistence-import';
import { INBOX_JOBS } from '../../src/modules/inbox/jobs';
import { downloadInboundMedia } from '../../src/modules/inbox/media.service';
import { sendMessage } from '../../src/modules/inbox/outbound.service';
import { runInboxRetention } from '../../src/modules/inbox/retention.job';
import { processSend } from '../../src/modules/inbox/send.job';
import { remuxWebmOpusToOgg } from '../../src/modules/inbox/voice/webm-to-ogg';
import { processWebhookEvent } from '../../src/modules/whatsapp/webhook-processor';
import { receiveWebhook } from '../../src/modules/whatsapp/webhooks.service';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { mediaFixture, useInboxWorld } from '../helpers/inbox';
import { buildWebm, longPacket } from '../helpers/webm';

useTestDb();
useCapturedEmail();
const world = useInboxWorld();
const { state } = world;

const timings: Record<string, number> = {};
const timed = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
  const started = performance.now();
  const out = await fn();
  timings[name] = Math.round(performance.now() - started);
  // HARDENING_TIMINGS=<file> keeps the numbers for the sign-off (no console output in tests)
  if (process.env.HARDENING_TIMINGS)
    writeFileSync(process.env.HARDENING_TIMINGS, JSON.stringify(timings, null, 2));
  return out;
};

const envelope = (channel: typeof state.channel, value: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: channel.wabaId,
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: (channel.displayPhoneNumber ?? '').replace(/\D/g, ''),
              phone_number_id: channel.phoneNumberId,
            },
            ...value,
          },
        },
      ],
    },
  ],
});
const customer = (i: number) => `9190004${String(i).padStart(5, '0')}`;

describe('inbox hardening', () => {
  it('1,000 customer messages across 50 conversations in 10 parallel deliveries: once each, ordered, exact unread, one bell per conversation', async () => {
    await world.setup();
    const now = Math.floor(Date.now() / 1000);
    const deliveries = Array.from({ length: 10 }, (_, d) => {
      const messages = Array.from({ length: 100 }, (_, i) => {
        const n = d * 100 + i;
        return {
          from: customer(n % 50),
          id: `wamid.H${String(n).padStart(6, '0')}`,
          timestamp: String(now - 1000 + n),
          type: 'text',
          text: { body: `Burst ${String(n)}` },
        };
      });
      return envelope(state.channel, { contacts: [], messages });
    });
    const ids: string[] = [];
    const jobs = { enqueueEvent: (id: string) => (ids.push(id), Promise.resolve()) };
    await timed('inbound1000', async () => {
      await Promise.all(
        deliveries.map((p) => {
          const raw = Buffer.from(JSON.stringify(p));
          return receiveWebhook(
            world.w.ctx,
            jobs,
            raw,
            signWebhook(raw, world.w.env.FAKE_META_APP_SECRET ?? ''),
          );
        }),
      );
      // ten workers in parallel, like the worker's concurrency
      await Promise.all(ids.map((id) => processWebhookEvent(state.h, id, { finalAttempt: true })));
    });
    expect(await MessageModel.countDocuments({ accountId: state.acc.account._id })).toBe(1000);
    const convs = await ConversationModel.find({ accountId: state.acc.account._id }).lean();
    expect(convs).toHaveLength(50);
    expect(convs.every((c) => c.unreadCount === 20)).toBe(true);
    // the list row is each customer's newest message, whatever order they were processed in
    for (const c of convs) {
      const newest = await MessageModel.findOne({ conversationId: c._id }).sort({ at: -1 }).lean();
      expect(c.lastMessage?.id).toEqual(newest?._id);
    }
    // resent deliveries add nothing
    ids.length = 0;
    await Promise.all(
      deliveries.map((p) => {
        const raw = Buffer.from(JSON.stringify(p));
        return receiveWebhook(
          world.w.ctx,
          jobs,
          raw,
          signWebhook(raw, world.w.env.FAKE_META_APP_SECRET ?? ''),
        );
      }),
    );
    expect(ids).toEqual([]);
    expect(await MessageModel.countDocuments({ accountId: state.acc.account._id })).toBe(1000);
    // owner, admin, manager, agent × 50 conversations, throttled to one bell each
    expect(
      await NotificationModel.countDocuments({
        accountId: state.acc.account._id,
        type: 'inbox.message_received',
      }),
    ).toBe(4 * 50);
  });

  it('200 sends in parallel across 20 conversations: one Meta call each, order kept per conversation', async () => {
    const { users } = await world.setup();
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 20; i += 1) {
      const raw = Buffer.from(
        JSON.stringify(
          envelope(state.channel, {
            messages: [
              {
                from: customer(100 + i),
                id: `wamid.S${String(i)}`,
                timestamp: String(now),
                type: 'text',
                text: { body: 'Hi' },
              },
            ],
          }),
        ),
      );
      const ids: string[] = [];
      await receiveWebhook(
        world.w.ctx,
        { enqueueEvent: (id) => (ids.push(id), Promise.resolve()) },
        raw,
        signWebhook(raw, world.w.env.FAKE_META_APP_SECRET ?? ''),
      );
      for (const id of ids) await processWebhookEvent(state.h, id, { finalAttempt: true });
    }
    world.jobs.sent.length = 0;
    const convs = await ConversationModel.find({ accountId: state.acc.account._id }).lean();
    const actor = { accountId: state.acc.account._id, userId: users.agent.user._id };
    await timed('send200', async () => {
      // queued in parallel (two requests per conversation at a time)
      for (let round = 0; round < 10; round += 1) {
        await Promise.all(
          convs.map((c) =>
            sendMessage(state.ix, actor, c._id.toString(), {
              clientId: randomUUID(),
              type: 'text',
              text: `Reply ${String(round)}`,
            }),
          ),
        );
      }
      // send jobs processed in parallel, a waiting job retried like the worker does
      const pending = world.jobs.sent.splice(0).filter((j) => j.name === INBOX_JOBS.messageSend);
      const run = async (id: string) => {
        for (let waits = 0; ; waits += 1) {
          // never exhaust the order wait here: the test checks the ordering guarantee itself
          const out = await processSend(state.ix, id, {
            finalAttempt: true,
            waits: Math.min(waits, 19),
          });
          if (out.kind !== 'wait') return out;
          await new Promise((r) => setTimeout(r, 5));
        }
      };
      await Promise.all(pending.map((j) => run(j.id)));
    });
    const sent = await world.w.fake.sentMessages(state.channel.phoneNumberId!);
    expect(sent).toHaveLength(200);
    expect(new Set(sent.map((s) => s.waMessageId)).size).toBe(200);
    for (const c of convs) {
      const msgs = await MessageModel.find({ conversationId: c._id, direction: 'out' })
        .sort({ at: 1, _id: 1 })
        .lean();
      expect(msgs.every((m) => m.status === 'accepted')).toBe(true);
      const order = msgs.map((m) => sent.findIndex((s) => s.waMessageId === m.waMessageId));
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    }
  });

  it('a media download that crashes mid-way resumes on the next attempt; nothing is stored twice', async () => {
    await world.setup();
    const mediaId = await world.w.fake.putMedia(mediaFixture('sample.jpg'), 'image/jpeg');
    const raw = Buffer.from(
      JSON.stringify(
        envelope(state.channel, {
          messages: [
            {
              from: customer(300),
              id: 'wamid.M1',
              timestamp: String(Math.floor(Date.now() / 1000)),
              type: 'image',
              image: { id: mediaId, mime_type: 'image/jpeg' },
            },
          ],
        }),
      ),
    );
    const ids: string[] = [];
    await receiveWebhook(
      world.w.ctx,
      { enqueueEvent: (id) => (ids.push(id), Promise.resolve()) },
      raw,
      signWebhook(raw, world.w.env.FAKE_META_APP_SECRET ?? ''),
    );
    for (const id of ids) await processWebhookEvent(state.h, id, { finalAttempt: true });
    const job = world.jobs.sent.find((j) => j.name === INBOX_JOBS.mediaDownload)!;
    const put = vi.spyOn(world.storage, 'put').mockRejectedValueOnce(new Error('disk full'));
    await expect(downloadInboundMedia(state.ix, job.id, { finalAttempt: false })).rejects.toThrow(
      'disk full',
    );
    expect(await downloadInboundMedia(state.ix, job.id, { finalAttempt: false })).toBe('ready');
    expect(await downloadInboundMedia(state.ix, job.id, { finalAttempt: false })).toBe('skipped');
    expect(put).toHaveBeenCalledTimes(2);
    put.mockRestore();
  });

  it('a 5,000-message history chunk imports once (time recorded)', async () => {
    await world.setup({ mode: 'coexistence' });
    const now = Math.floor(Date.now() / 1000);
    const threads = Array.from({ length: 50 }, (_, t) => ({
      id: customer(500 + t),
      messages: Array.from({ length: 100 }, (_, i) => ({
        from:
          i % 2 ? (state.channel.displayPhoneNumber ?? '').replace(/\D/g, '') : customer(500 + t),
        id: `wamid.HIST${String(t)}x${String(i)}`,
        timestamp: String(now - 86_400 + i),
        type: 'text',
        text: { body: `Old ${String(i)}` },
        history_context: { status: 'READ' },
      })),
    }));
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: state.channel.wabaId,
          changes: [
            {
              field: 'history',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: state.channel.phoneNumberId },
                history: [{ metadata: { phase: 0, chunk_order: 1, progress: 100 }, threads }],
              },
            },
          ],
        },
      ],
    };
    const raw = Buffer.from(JSON.stringify(payload));
    const ids: string[] = [];
    await receiveWebhook(
      world.w.ctx,
      { enqueueEvent: (id) => (ids.push(id), Promise.resolve()) },
      raw,
      signWebhook(raw, world.w.env.FAKE_META_APP_SECRET ?? ''),
    );
    for (const id of ids) await processWebhookEvent(state.h, id, { finalAttempt: true });
    const job = world.jobs.sent.find((j) => j.name === INBOX_JOBS.historyImport)!;
    const result = await timed('history5000', () => importHistoryEvent(state.ix, job.id));
    expect(result).toMatchObject({ conversations: 50, messages: 5000, duplicates: 0 });
    expect(
      await ConversationModel.countDocuments({
        accountId: state.acc.account._id,
        unreadCount: { $gt: 0 },
      }),
    ).toBe(0);
  });

  it('retention purges 20,000 old messages across 3 accounts and touches nothing else (time recorded)', async () => {
    await MessageModel.deleteMany({});
    const old = new Date(Date.now() - 100 * 86_400_000);
    const keepAt = new Date();
    const accounts = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()];
    const convIds = accounts.map(() => new Types.ObjectId());
    const rows = (n: number, at: Date) =>
      Array.from({ length: n }, (_, i) => {
        const a = i % 3;
        return {
          accountId: accounts[a],
          conversationId: convIds[a],
          channelId: new Types.ObjectId(),
          contactId: new Types.ObjectId(),
          direction: 'in',
          origin: 'customer',
          type: 'text',
          text: 'x',
          status: 'received',
          at,
        };
      });
    for (let i = 0; i < 20; i += 1) await MessageModel.insertMany(rows(1000, old), { lean: true });
    await MessageModel.insertMany(rows(300, keepAt), { lean: true });
    const result = await timed('retention20000', () => runInboxRetention(world.storage, 90));
    expect(result.messages).toBe(20_000);
    expect(await MessageModel.countDocuments({ accountId: { $in: accounts } })).toBe(300);
  });

  it('remuxes a 10-minute browser recording (time + memory recorded)', async () => {
    const recording = buildWebm({
      packets: Array.from({ length: 5_000 }, () => longPacket()),
      perCluster: 500,
    });
    const before = process.memoryUsage().heapUsed;
    const r = await timed('remux10min', () => remuxWebmOpusToOgg(recording));
    timings.remux10minHeapMb = Math.round((process.memoryUsage().heapUsed - before) / 1_048_576);
    expect(r.durationSec).toBeGreaterThan(590);
    expect(timings.remux10min).toBeLessThan(5_000);
  });
});
