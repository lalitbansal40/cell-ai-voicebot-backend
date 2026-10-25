/**
 * DEV ONLY — a connected demo WhatsApp number for "Demo Finance" through the real
 * connect path (fake Meta signup code → `connect()`), plus three simulated Meta
 * events through the real webhook receiver and processor (name approved, quality
 * upgrade, an inbound text kept for Phase 10). Idempotent: skipped when the demo
 * number is already active in the account.
 */
import type { Redis } from 'ioredis';
import type { Types } from 'mongoose';

import type { Env } from '../src/config/env';
import { secretBoxKey } from '../src/core/ai/secret-box';
import { buildFakeCode, createMetaClient, metaAppSecret, signWebhook } from '../src/core/meta';
import { WA_ACTIVE_STATUSES, WhatsAppChannelModel } from '../src/db/models/whatsapp-channel.model';
import type { WhatsAppContext } from '../src/modules/whatsapp/context';
import { buildSimulatorPayload, type SimulatorKind } from '../src/modules/whatsapp/simulator';
import { processWebhookEvent } from '../src/modules/whatsapp/webhook-processor';
import { receiveWebhook } from '../src/modules/whatsapp/webhooks.service';
import { createWhatsAppService } from '../src/modules/whatsapp/whatsapp.service';
import type { Logger } from '../src/shared/logger';

export const SEED_WHATSAPP_NUMBER = '+91 90000 12345';
const SEED_EVENTS: SimulatorKind[] = ['name_approved', 'quality_upgrade', 'inbound_text'];

export interface WhatsAppSeedDeps {
  /** Tests: the fake Meta's Redis key prefix (default: the dev server's keys). */
  metaPrefix?: string;
  env: Env;
  ownerId: Types.ObjectId;
  redis: Redis;
  logger: Logger;
}

export const seedWhatsApp = async (
  accountId: Types.ObjectId,
  { env, ownerId, redis, logger, metaPrefix }: WhatsAppSeedDeps,
): Promise<{ channels: number; events: number; skipped: string | null }> => {
  if (!env.WHATSAPP_ENABLED || env.META_PROVIDER !== 'fake') {
    return { channels: 0, events: 0, skipped: 'WhatsApp is off or uses the real Meta provider' };
  }
  const existing = await WhatsAppChannelModel.exists({
    accountId,
    displayPhoneNumber: SEED_WHATSAPP_NUMBER,
    status: { $in: WA_ACTIVE_STATUSES },
  });
  if (existing) return { channels: 0, events: 0, skipped: null };

  const ctx: WhatsAppContext = {
    env,
    meta: createMetaClient(env, { redis, logger, ...(metaPrefix ? { prefix: metaPrefix } : {}) }),
    redis,
    key: secretBoxKey(env),
  };
  const service = createWhatsAppService(ctx);
  const result = await service.connect({
    accountId,
    actor: { type: 'user', id: ownerId },
    mode: 'cloud_api',
    code: buildFakeCode({
      businessName: 'Demo Finance',
      phone: SEED_WHATSAPP_NUMBER,
      displayName: 'Demo Finance',
      mode: 'cloud_api',
      outcome: 'finish',
    }),
  });
  const channel = await WhatsAppChannelModel.findById(result.channel.id).lean();
  if (!channel) return { channels: 1, events: 0, skipped: null };

  // received and processed in this process (no worker needed for the seed)
  const queued: string[] = [];
  const jobs = { enqueueEvent: (id: string) => (queued.push(id), Promise.resolve()) };
  for (const kind of SEED_EVENTS) {
    const raw = Buffer.from(JSON.stringify(buildSimulatorPayload(kind, channel)));
    await receiveWebhook(ctx, jobs, raw, signWebhook(raw, metaAppSecret(env)));
  }
  for (const id of queued) {
    await processWebhookEvent({ ctx, service }, id, { finalAttempt: true });
  }
  return { channels: 1, events: queued.length, skipped: null };
};
