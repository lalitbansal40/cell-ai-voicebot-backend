/**
 * DEV ONLY — WhatsApp calling for "Demo Finance" on its seeded number (fake Meta):
 * calling enabled (callback permission on, inbound route `team`), two customers with
 * call permission (temporary + permanent, also at the fake Meta) and three past calls —
 * an agent call and an AI call the customer picked up (charged in 6-second pulses
 * through the billing engine, tone recordings) and a missed inbound call (free).
 * Idempotent: the settings are re-applied, the permissions and calls are added once
 * (the calls are marked `providerCallId` `seed-wa:*`).
 */
import type { Redis } from 'ioredis';
import { Types } from 'mongoose';

import type { Env } from '../src/config/env';
import { secretBoxKey } from '../src/core/ai/secret-box';
import { holdForWhatsAppCall, settleWhatsAppCall } from '../src/core/billing/engine';
import { callHoldMicros, callPrice } from '../src/core/billing/whatsapp-calls';
import { createMetaClient, type FakeMetaClient } from '../src/core/meta';
import { storageKey, type StorageProvider } from '../src/core/storage';
import { tone } from '../src/core/voice/audio/pcm';
import { wavBuffer } from '../src/core/voice/audio/wav';
import { AiAgentModel } from '../src/db/models/ai-agent.model';
import { CallModel } from '../src/db/models/call.model';
import { ContactModel } from '../src/db/models/contact.model';
import { WhatsAppCallPermissionModel } from '../src/db/models/whatsapp-call-permission.model';
import {
  defaultCalling,
  WA_ACTIVE_STATUSES,
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../src/db/models/whatsapp-channel.model';
import { openSecret, type WhatsAppContext } from '../src/modules/whatsapp/context';
import { callBreakdown, quoteCall } from '../src/modules/whatsapp-calling/billing';
import type { Logger } from '../src/shared/logger';

import { demoPhone } from './seed-contacts';
import { SEED_WHATSAPP_NUMBER } from './seed-whatsapp';

export const SEED_WA_CALL_MARKS = {
  agent: 'seed-wa:agent',
  ai: 'seed-wa:ai',
  missed: 'seed-wa:missed',
} as const;

export interface CallsWaSeedDeps {
  env: Env;
  ownerId: Types.ObjectId;
  redis: Redis;
  logger: Logger;
  storage: StorageProvider;
}

const DAY = 86_400_000;

/** A stereo 8 kHz WAV: the customer's 440 Hz left, the business's 1 kHz right. */
const toneRecording = (seconds: number): Buffer => {
  const rate = 8_000;
  const left = tone(seconds * 1000, rate, { hz: 440, amplitude: 3277 });
  const right = tone(seconds * 1000, rate, { hz: 1000, amplitude: 3277 });
  const stereo = new Int16Array(left.length * 2);
  for (let i = 0; i < left.length; i += 1) {
    stereo[i * 2] = left[i] ?? 0;
    stereo[i * 2 + 1] = right[i] ?? 0;
  }
  return wavBuffer(stereo, rate, 2);
};

export const seedCallsWa = async (
  accountId: Types.ObjectId,
  { env, ownerId, redis, logger, storage }: CallsWaSeedDeps,
): Promise<{ permissions: number; calls: number; skipped: string | null }> => {
  if (!env.WHATSAPP_ENABLED || env.META_PROVIDER !== 'fake') {
    return { permissions: 0, calls: 0, skipped: 'WhatsApp is off or uses the real Meta provider' };
  }
  const channel = await WhatsAppChannelModel.findOne({
    accountId,
    displayPhoneNumber: SEED_WHATSAPP_NUMBER,
    status: { $in: WA_ACTIVE_STATUSES },
  })
    .select('+tokenSealed')
    .lean<WhatsAppChannelDoc>();
  if (!channel?.phoneNumberId)
    return { permissions: 0, calls: 0, skipped: 'No demo WhatsApp number' };
  const meta = createMetaClient(env, { redis, logger }) as FakeMetaClient;
  const ctx: WhatsAppContext = { env, meta, redis, key: secretBoxKey(env) };
  const token = channel.tokenSealed ? openSecret(ctx, channel.tokenSealed) : '';
  const pnid = channel.phoneNumberId;

  // calling on at Meta and on our number
  await meta.updateCallingSettings(token, pnid, {
    status: 'ENABLED',
    callbackPermissionStatus: 'ENABLED',
  });
  // the whole sub-document (a number saved before migration 0013 has none)
  const current = channel.calling ?? defaultCalling();
  await WhatsAppChannelModel.updateOne(
    { _id: channel._id },
    {
      $set: {
        calling: {
          ...current,
          status: 'enabled',
          callbackPermission: true,
          inbound: { ...current.inbound, route: 'team' },
          syncedAt: new Date(),
        },
      },
    },
  );

  // two customers who allowed calls (temporary 7 days / permanent)
  const now = Date.now();
  const customers = await ContactModel.find({
    accountId,
    phoneE164: { $in: [demoPhone(4), demoPhone(5), demoPhone(6)] },
    deletedAt: null,
  }).lean<{ _id: Types.ObjectId; phoneE164: string }[]>();
  const byPhone = new Map(customers.map((c) => [c.phoneE164, c]));
  const allowed = [
    { phone: demoPhone(4), status: 'temporary' as const, expiresAt: new Date(now + 5 * DAY) },
    { phone: demoPhone(5), status: 'permanent' as const, expiresAt: null },
  ];
  if (await CallModel.exists({ accountId, providerCallId: SEED_WA_CALL_MARKS.agent })) {
    return { permissions: 0, calls: 0, skipped: null };
  }
  let permissions = 0;
  for (const p of allowed) {
    const contact = byPhone.get(p.phone);
    if (!contact) continue;
    await meta.setCallPermission(pnid, p.phone, p.status, p.expiresAt);
    await WhatsAppCallPermissionModel.updateOne(
      { accountId, channelId: channel._id, contactId: contact._id },
      {
        $set: { status: p.status, expiresAt: p.expiresAt, source: 'request_reply' },
        $push: {
          history: { status: p.status, at: new Date(now - 2 * DAY), source: 'request_reply' },
        },
      },
      { upsert: true },
    );
    permissions += 1;
  }

  const agent = await AiAgentModel.findOne({ accountId, deletedAt: null })
    .select({ _id: 1 })
    .lean<{ _id: Types.ObjectId }>();
  const plan = [
    {
      mark: SEED_WA_CALL_MARKS.agent,
      contact: byPhone.get(demoPhone(4)),
      mode: 'human' as const,
      direction: 'outbound' as const,
      talkSec: 47,
      at: now - 3 * 3_600_000,
    },
    {
      mark: SEED_WA_CALL_MARKS.ai,
      contact: byPhone.get(demoPhone(5)),
      mode: 'ai' as const,
      direction: 'outbound' as const,
      talkSec: 30,
      at: now - 2 * 3_600_000,
    },
    {
      mark: SEED_WA_CALL_MARKS.missed,
      contact: byPhone.get(demoPhone(6)),
      mode: 'human' as const,
      direction: 'inbound' as const,
      talkSec: 0,
      at: now - 3_600_000,
    },
  ];
  let calls = 0;
  for (const c of plan) {
    if (!c.contact) continue;
    const callId = new Types.ObjectId();
    const bic = c.direction === 'outbound';
    const quote = await quoteCall({
      accountId,
      phoneE164: c.contact.phoneE164,
      payer: channel.metaPayer,
    });
    const price = callPrice(quote, bic ? c.talkSec : 0);
    const queuedAt = new Date(c.at);
    const answeredAt = c.talkSec ? new Date(c.at + 4_000) : null;
    const endedAt = new Date(c.at + 4_000 + c.talkSec * 1000 + (c.talkSec ? 0 : 26_000));
    let recording = null;
    if (c.talkSec) {
      const key = storageKey({
        accountId: accountId.toString(),
        area: 'recordings',
        id: callId.toString(),
        ext: 'wav',
      });
      const body = toneRecording(c.talkSec);
      await storage.put(key, body, { contentType: 'audio/wav' });
      recording = {
        fileKey: key,
        durationSec: c.talkSec,
        sizeBytes: body.length,
        format: 'wav' as const,
      };
    }
    await CallModel.create({
      _id: callId,
      accountId,
      direction: c.direction,
      provider: 'whatsapp',
      providerCallId: c.mark,
      mode: c.mode,
      from: bic ? `whatsapp:${channel._id.toString()}` : c.contact.phoneE164,
      to: bic ? c.contact.phoneE164 : `whatsapp:${channel._id.toString()}`,
      contactId: c.contact._id,
      startedBy: bic ? ownerId : null,
      agentUserId: c.mode === 'human' && bic ? ownerId : null,
      source: c.mode === 'ai' && agent ? { kind: 'agent', agentId: agent._id } : { kind: null },
      status: c.talkSec ? 'completed' : 'no_answer',
      endReason: c.talkSec ? 'customer_hangup' : 'no_agent_available',
      durationSec: c.talkSec,
      recording,
      timestamps: { queuedAt, ringingAt: new Date(c.at + 1_000), answeredAt, endedAt },
      whatsapp: {
        channelId: channel._id,
        waCallId: `wacid.SEED${callId.toString().toUpperCase()}`,
        direction: bic ? 'BUSINESS_INITIATED' : 'USER_INITIATED',
        metaStatus: c.talkSec ? 'COMPLETED' : 'FAILED',
        metaDuration: c.talkSec || null,
        timeline: [
          { event: bic ? 'dialed' : 'connect', at: queuedAt },
          ...(answeredAt ? [{ event: 'accepted', at: answeredAt }] : []),
          { event: 'terminate', at: endedAt },
        ],
      },
      billing: {
        whatsapp: {
          payer: channel.metaPayer,
          market: quote.market,
          perMinuteMicros: quote.perMinuteMicros,
          pulses: price.pulses,
          metaCostMicros: price.metaCostMicros,
          markupMicros: price.markupMicros,
          platformFeeMicros: price.platformFeeMicros,
          status: bic ? 'settled' : 'free',
          durationSource: bic ? 'meta' : null,
        },
      },
      cost: { telephonyMicros: price.totalMicros, totalMicros: price.totalMicros },
    });
    if (bic && price.totalMicros > 0) {
      // the money moves through the engine like a real call: hold at dial, settle on Meta's duration
      const hold = await holdForWhatsAppCall({
        accountId,
        callId: callId.toString(),
        amountMicros: callHoldMicros(quote, quote.holdMinutes),
        breakdown: { waMarket: quote.market, waPerMinuteMicros: quote.perMinuteMicros },
      });
      const holdId = hold.entries[0]?._id;
      if (holdId) {
        await settleWhatsAppCall({
          accountId,
          holdId,
          callId: callId.toString(),
          amountMicros: price.totalMicros,
          breakdown: callBreakdown(quote, price, c.talkSec, null),
          note: null,
        });
        await CallModel.updateOne({ _id: callId }, { $set: { holdId } });
      }
    }
    calls += 1;
  }
  return { permissions, calls, skipped: null };
};
