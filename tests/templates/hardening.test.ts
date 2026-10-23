import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { adjust, credit, holdForWhatsApp } from '../../src/core/billing/engine';
import { parseMetaRateCsv } from '../../src/core/billing/whatsapp';
import { reapWhatsAppHolds } from '../../src/core/billing/whatsapp-reaper';
import { ContactModel } from '../../src/db/models/contact.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { MessageModel } from '../../src/db/models/message.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { WhatsAppTemplateModel } from '../../src/db/models/whatsapp-template.model';
import { upsertConversation } from '../../src/modules/inbox/conversation-store';
import { sendMessage } from '../../src/modules/inbox/outbound.service';
import { applyStatuses } from '../../src/modules/inbox/status.service';
import { recordingTemplateJobs } from '../../src/modules/templates/jobs';
import { createTemplate, syncTemplates } from '../../src/modules/templates/template.service';
import { createWhatsAppBillingHook } from '../../src/modules/whatsapp-billing/billing-hook';
import { expectWalletConsistent } from '../helpers/billing';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { useInboxWorld } from '../helpers/inbox';
import { userActor } from '../helpers/whatsapp';

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
const PRICE = 140_000;
const tx = () => ({ wa: world.w.ctx, jobs: recordingTemplateJobs(), storage: world.storage });

describe('templates + billing hardening (PHASE_11_PROMPT T11.6 §8)', () => {
  it('500 template sends to 50 contacts on a wallet that runs out: exact holds, no overspend', async () => {
    await world.setup();
    const accountId = state.acc.account._id;
    // exactly 250 sends fit: ₹35 / ₹0.14
    const balance = (await WalletModel.findOne({ accountId }).lean())!.balanceMicros;
    await adjust({
      accountId,
      direction: 'debit',
      amountMicros: balance - 250 * PRICE,
      reason: 'hardening: leave ₹35',
      createdBy: accountId,
      idempotencyKey: `hard-adjust-${accountId.toString()}`,
    });
    const t = await createTemplate(tx(), accountId, userActor(), {
      channelId: state.channel._id.toString(),
      name: 'bulk_reminder_instant',
      language: 'en',
      category: 'UTILITY',
      components: [
        { type: 'BODY', text: 'Hi {{1}}, your EMI is due.', example: { body_text: [['A']] } },
      ],
    });
    const conversations: Awaited<ReturnType<typeof upsertConversation>>[] = [];
    for (let i = 0; i < 50; i += 1) {
      const waId = `9190000${String(70000 + i)}`;
      const contact = await ContactModel.create({
        accountId,
        phoneE164: `+${waId}`,
        source: { type: 'whatsapp' },
        whatsapp: { waId },
      });
      conversations.push(
        await upsertConversation({
          key: { accountId, channelId: state.channel._id, waId },
          contactId: contact._id,
          source: 'outbound',
        }),
      );
    }
    // 25 sends at a time (a burst from several agents) — the wallet runs out in the middle
    const send = (i: number) =>
      sendMessage(
        state.ix,
        { accountId, userId: state.acc.account._id },
        conversations[i % 50]!._id.toString(),
        {
          clientId: randomUUID(),
          type: 'template',
          templateId: t.id,
          variables: { '1': 'Asha' },
        },
      );
    const results = await timed('500 template sends (50 contacts, wallet runs out)', async () => {
      const all: PromiseSettledResult<unknown>[] = [];
      for (let start = 0; start < 500; start += 25) {
        all.push(
          ...(await Promise.allSettled(Array.from({ length: 25 }, (_, k) => send(start + k)))),
        );
      }
      return all;
    });
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const refused = results.filter(
      (r) =>
        r.status === 'rejected' &&
        (r.reason as { code?: string }).code === 'WALLET_INSUFFICIENT_BALANCE',
    ).length;
    expect(ok).toBe(250);
    expect(refused).toBe(250);
    expect(await MessageModel.countDocuments({ accountId, type: 'template' })).toBe(250);
    expect(
      await LedgerEntryModel.countDocuments({ accountId, type: 'whatsapp_charge', status: 'held' }),
    ).toBe(250);
    const w = (await WalletModel.findOne({ accountId }).lean())!;
    expect(w.balanceMicros - w.holdMicros).toBe(0);
    await expectWalletConsistent(accountId);
  });

  for (const part of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    it(`10,000 status webhooks with pricing (part ${String(part)} / 10): captured exactly once each`, async () => {
      if (part === 1 || !state.acc) await world.setup();
      state.ix.billing = createWhatsAppBillingHook();
      const accountId = state.acc.account._id;
      await credit({
        accountId,
        type: 'topup',
        amountMicros: 1_000 * 1_000_000,
        ref: { type: 'manual', id: 'h' },
        idempotencyKey: `hard-${String(part)}-${accountId.toString()}`,
      });
      const messages = [];
      for (let i = 0; i < 100; i += 1) {
        const clientId = randomUUID();
        const h = await holdForWhatsApp({
          accountId,
          clientId,
          amountMicros: PRICE,
          breakdown: {},
          ref: { type: 'whatsapp_message', id: clientId },
        });
        messages.push({
          accountId,
          channelId: state.channel._id,
          contactId: new Types.ObjectId(),
          conversationId: new Types.ObjectId(),
          direction: 'out',
          origin: 'agent',
          type: 'text',
          status: 'accepted',
          waMessageId: `wamid.HARD${String(part)}x${String(i)}${clientId.slice(0, 6)}`,
          clientId,
          at: new Date(),
          billing: {
            payer: 'platform',
            market: 'IN',
            category: 'service',
            estimateMicros: PRICE,
            priceMicros: PRICE,
            holdId: h.entries[0]!._id,
            status: 'held',
            at: new Date(),
          },
        });
      }
      const docs = await MessageModel.insertMany(messages);
      const pricing = {
        billable: true,
        pricing_model: 'PMP',
        category: 'service',
        type: 'regular',
      };
      // 10 statuses per message: sent, delivered ×4 (redeliveries), read ×4, a late sent
      const kinds = [
        'sent',
        'delivered',
        'delivered',
        'read',
        'delivered',
        'read',
        'delivered',
        'read',
        'read',
        'sent',
      ];
      const statuses = docs.flatMap((m) =>
        kinds.map((status, k) => ({
          id: m.waMessageId,
          status,
          timestamp: String(1_800_000_000 + k),
          pricing,
        })),
      );
      await timed(`1,000 statuses (part ${String(part)})`, async () => {
        for (let i = 0; i < statuses.length; i += 500) {
          await applyStatuses(state.ix, state.channel, statuses.slice(i, i + 500));
        }
      });
      const ids = docs.map((d) => d._id);
      expect(
        await MessageModel.countDocuments({ _id: { $in: ids }, 'billing.status': 'captured' }),
      ).toBe(100);
      expect(
        await LedgerEntryModel.countDocuments({
          accountId,
          idempotencyKey: { $in: ids.map((id) => `wa-capture-${id.toString()}`) },
        }),
      ).toBe(100);
      await expectWalletConsistent(accountId);
    });
  }

  it('a sync of 1,000 templates (10 pages)', async () => {
    await world.setup();
    const waba = state.channel.wabaId;
    for (let i = 0; i < 1000; i += 1) {
      await world.w.fake.createTemplate(state.token, waba, {
        name: `bulk_${String(i)}_instant`,
        language: 'en',
        category: 'UTILITY',
        parameterFormat: 'positional',
        components: [{ type: 'BODY', text: 'Hello there.' }],
      });
    }
    const calls = world.w.fake.calls.length;
    const res = await timed('sync of 1,000 templates', () =>
      syncTemplates(tx(), state.channel._id, 'manual'),
    );
    expect(res).toMatchObject({ created: 1000, deleted: 0 });
    expect(world.w.fake.calls.slice(calls).filter((c) => c.op === 'listTemplates')).toHaveLength(
      10,
    );
    expect(await WhatsAppTemplateModel.countDocuments({ accountId: state.acc.account._id })).toBe(
      1000,
    );
  });

  it('a CSV of 250 markets parses', async () => {
    const rows = [
      'Market,Calling codes,Marketing,Utility,Authentication,Authentication international,Service',
    ];
    for (let i = 0; i < 249; i += 1) {
      const code = String(1000 + i);
      rows.push(
        `Market ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))},${code},0.8,0.1,0.1,,0.05`,
      );
    }
    rows.push('Other,,1,0.5,0.5,,0.2');
    const res = await timed('CSV of 250 markets', () =>
      parseMetaRateCsv(Buffer.from(rows.join('\n'))),
    );
    expect(res.errors).toEqual([]);
    expect(res.markets).toHaveLength(250);
  });

  it('the reaper over 5,000 stale holds', async () => {
    await world.setup();
    const accountId = state.acc.account._id;
    const old = new Date(Date.now() - 80 * 3_600_000);
    // stale holds as the engine leaves them (the wallet's hold matches the rows)
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      accountId,
      type: 'whatsapp_charge',
      direction: 'debit',
      status: 'held',
      amountMicros: 10_000,
      currency: 'INR',
      ref: { type: 'whatsapp_message', id: `stale-${String(i)}` },
      idempotencyKey: `wa-hold-stale-${String(i)}-${accountId.toString()}`,
      createdAt: old,
      updatedAt: old,
    }));
    await LedgerEntryModel.collection.insertMany(rows);
    await WalletModel.updateOne({ accountId }, { $inc: { holdMicros: 5000 * 10_000 } });
    const total = await timed('reaper over 5,000 stale holds', async () => {
      let released = 0;
      for (let i = 0; i < 6; i += 1) released += (await reapWhatsAppHolds()).released;
      return released;
    });
    expect(total).toBe(5000);
    expect((await WalletModel.findOne({ accountId }).lean())?.holdMicros).toBe(0);
    await expectWalletConsistent(accountId);
  });
});
