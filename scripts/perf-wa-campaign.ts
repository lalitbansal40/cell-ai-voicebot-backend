/** Isolated fake-Meta campaign benchmark: 1,000 recipients each on 18/75 senders.
 * Two campaigns share each sender; both numbers run independently. No customer traffic.
 * Uses cav_perf / Redis 9 only, through perf-common's development-only guards.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import type { Types } from 'mongoose';

import type { FakeSentMessage } from '../src/core/meta/fake.client';
import { ContactModel } from '../src/db/models/contact.model';
import { LedgerEntryModel } from '../src/db/models/ledger-entry.model';
import { MessageModel } from '../src/db/models/message.model';
import { WhatsAppCampaignRecipientModel } from '../src/db/models/whatsapp-campaign-recipient.model';
import { WhatsAppCampaignModel } from '../src/db/models/whatsapp-campaign.model';
import { WhatsAppChannelModel } from '../src/db/models/whatsapp-channel.model';
import {
  PLACEHOLDER_MARKETS,
  WhatsAppRateCardModel,
} from '../src/db/models/whatsapp-rate-card.model';

import { BASE, seedWorld, sleep, startPerf, type PerfWorld } from './perf-common';

const main = async () => {
  const run = await startPerf({ AI_PROVIDER: 'fake', PAYMENT_PROVIDER: 'fake' });
  try {
    await WhatsAppRateCardModel.create({
      kind: 'messaging',
      effectiveFrom: new Date(0),
      source: 'manual',
      markets: PLACEHOLDER_MARKETS,
    });
    const request = async <T>(w: PerfWorld, path: string, body?: unknown): Promise<T> => {
      const response = await fetch(`${BASE}/api/v1${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${w.ownerToken}`,
          'content-type': 'application/json',
          'Idempotency-Key': randomUUID(),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.ok(response.ok, `${path}: HTTP ${String(response.status)}`);
      return ((await response.json()) as { data: T }).data;
    };
    const worlds = await Promise.all([seedWorld(() => ''), seedWorld(() => '')]);
    const groups: {
      cap: number;
      world: PerfWorld;
      channel: { _id: Types.ObjectId };
      campaigns: string[];
      attempts: Map<string, number>;
    }[] = [];
    for (const [index, world] of worlds.entries()) {
      const cap = index === 0 ? 18 : 75;
      const channel = await WhatsAppChannelModel.findOne({ accountId: world.accountId }).lean();
      assert.ok(channel);
      await WhatsAppChannelModel.updateOne(
        { _id: channel._id },
        {
          $set: {
            mode: cap === 18 ? 'coexistence' : 'cloud_api',
            isOnBizApp: cap === 18,
            messageClassificationKnown: true,
            messagingLimitTier: 'TIER_10K',
            qualityRating: 'GREEN',
          },
        },
      );
      const template = await request<{ id: string }>(world, '/whatsapp/templates', {
        channelId: channel._id.toString(),
        name: `perf_instant_${randomUUID().slice(0, 8)}`,
        language: 'en',
        category: 'UTILITY',
        components: [{ type: 'BODY', text: 'Your account update is ready.' }],
      });
      const contacts = await ContactModel.insertMany(
        Array.from({ length: 1000 }, (_, i) => ({
          accountId: world.accountId,
          phoneE164: `+919${String(index + 6)}${String(50_000 + i).padStart(8, '0')}`,
          name: 'Synthetic recipient',
          source: { type: 'manual' },
        })),
      );
      const campaigns: string[] = [];
      for (let offset = 0; offset < 1000; offset += 500) {
        const campaign = await request<{ id: string }>(world, '/whatsapp-campaigns', {
          name: `Synthetic ${String(cap)} sender`,
          channelId: channel._id.toString(),
          variants: [{ key: 'A', templateId: template.id, splitPct: 100 }],
          audience: {
            contactIds: contacts.slice(offset, offset + 500).map((c) => c._id.toString()),
          },
        });
        campaigns.push(campaign.id);
      }
      groups.push({ cap, world, channel, campaigns, attempts: new Map<string, number>() });
    }
    const collect = async () => {
      for (const group of groups) {
        const rows = await run.redis.lrange(`fake-meta-sent-${group.world.phoneNumberId}`, 0, -1);
        for (const raw of rows) {
          const attempt = JSON.parse(raw) as FakeSentMessage;
          assert.ok(
            Number.isFinite(Date.parse(attempt.attemptedAt)),
            'provider entry timestamp missing',
          );
          group.attempts.set(attempt.waMessageId, Date.parse(attempt.attemptedAt));
        }
      }
    };
    let observing = true;
    const observer = (async () => {
      while (observing) {
        await collect();
        await sleep(100);
      }
    })();
    try {
      const started = Date.now();
      for (const group of groups)
        for (const id of group.campaigns)
          await request(group.world, `/whatsapp-campaigns/${id}/start`, {});
      let restarted = false;
      const deadline = Date.now() + 240_000;
      while (true) {
        await collect();
        const slow = groups[0]!;
        if (!restarted && slow.attempts.size >= 50) {
          for (const group of groups)
            for (const id of group.campaigns)
              await request(group.world, `/whatsapp-campaigns/${id}/pause`, {});
          // Quiesce provider callbacks before a hard kill; queued work must survive Redis.
          await sleep(2500);
          await collect();
          const before = groups.map((g) => g.attempts.size);
          await sleep(200);
          await collect();
          assert.deepEqual(
            groups.map((g) => g.attempts.size),
            before,
            'paused campaign sent again',
          );
          await run.restart();
          for (const group of groups)
            for (const id of group.campaigns)
              await request(group.world, `/whatsapp-campaigns/${id}/resume`, {});
          restarted = true;
        }
        const active = await WhatsAppCampaignModel.countDocuments({
          _id: { $in: groups.flatMap((g) => g.campaigns) },
          status: { $ne: 'completed' },
        });
        if (!active) break;
        if (Date.now() >= deadline) {
          console.info(
            JSON.stringify(
              await WhatsAppCampaignModel.find({ _id: { $in: groups.flatMap((g) => g.campaigns) } })
                .select({ status: 1, pauseReason: 1, counters: 1 })
                .lean(),
            ),
          );
          console.info(
            JSON.stringify(
              await WhatsAppCampaignRecipientModel.aggregate([
                { $group: { _id: '$status', n: { $sum: 1 } } },
              ]),
            ),
          );
          throw new Error('campaign benchmark did not drain');
        }
        await sleep(100);
      }
      await sleep(2500); // fake delivered/read hooks settle charges
      for (const group of groups) {
        await collect();
        const times = [...group.attempts.values()].sort((a, b) => a - b);
        let peak = 0;
        let left = 0;
        for (let i = 0; i < times.length; i++) {
          while (times[left]! <= times[i]! - 1000) left++;
          peak = Math.max(peak, i - left + 1);
        }
        assert.equal(times.length, 1000, 'provider attempts missing or duplicated');
        assert.ok(peak <= group.cap, `rolling cap ${String(group.cap)} exceeded: ${String(peak)}`);
        const messages = await MessageModel.find({
          accountId: group.world.accountId,
          externalRef: { $in: group.campaigns.map((id) => `wac:${id}`) },
        }).lean();
        console.info(
          JSON.stringify({
            cap: group.cap,
            attempts: times.length,
            messages: messages.length,
            recipientCount: await WhatsAppCampaignRecipientModel.countDocuments({
              campaignId: { $in: group.campaigns },
            }),
            counted: await WhatsAppCampaignRecipientModel.countDocuments({
              campaignId: { $in: group.campaigns },
              sentCounted: true,
            }),
          }),
        );
        assert.equal(messages.length, 1000, 'campaign messages count');
        assert.equal(
          new Set(messages.map((m) => m.clientId)).size,
          1000,
          'duplicate message identity',
        );
        assert.equal(
          new Set(messages.map((m) => m.waMessageId)).size,
          1000,
          'duplicate message identity',
        );
        assert.equal(
          await WhatsAppCampaignRecipientModel.countDocuments({
            campaignId: { $in: group.campaigns },
            sentCounted: true,
          }),
          1000,
          'recipient send count',
        );
        const campaigns = await WhatsAppCampaignModel.find({
          _id: { $in: group.campaigns },
        }).lean();
        assert.equal(
          campaigns.reduce((sum, c) => sum + c.counters.sent, 0),
          1000,
          'campaign sent total',
        );
        const ids = messages.flatMap((m) => [
          m._id.toString(),
          ...(m.clientId ? [m.clientId] : []),
        ]);
        const charges = await LedgerEntryModel.find({
          accountId: group.world.accountId,
          type: 'whatsapp_charge',
          status: 'captured',
          'ref.id': { $in: ids },
        })
          .select({ amountMicros: 1 })
          .lean<{ amountMicros: number }[]>();
        const captured = messages.filter((m) => m.billing?.status === 'captured');
        assert.equal(captured.length, 1000, 'delivery charges did not settle');
        assert.equal(charges.length, captured.length);
        assert.equal(
          charges.reduce((sum, c) => sum + c.amountMicros, 0),
          captured.reduce((sum, m) => sum + (m.billing?.priceMicros ?? 0), 0),
        );
        console.info(
          JSON.stringify({
            cap: group.cap,
            recipients: 1000,
            peakRollingSecond: peak,
            elapsedMs: times.at(-1)! - times[0]!,
            duplicateClientIds: 0,
            capturedCharges: charges.length,
            restart: restarted,
          }),
        );
      }
      console.info(JSON.stringify({ verdict: 'PASS', wallClockMs: Date.now() - started }));
    } finally {
      observing = false;
      await observer;
    }
  } finally {
    await run.stop();
  }
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : 'Benchmark failed');
  process.exitCode = 1;
});
