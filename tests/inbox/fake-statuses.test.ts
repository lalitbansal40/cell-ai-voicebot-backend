import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { secretBoxKey } from '../../src/core/ai/secret-box';
import {
  buildFakeCode,
  buildMessagePayload,
  createFakeMetaClient,
  createMetaClient,
  fakeIds,
  type FakeMetaClient,
} from '../../src/core/meta';
import { MetaWebhookEventModel } from '../../src/db/models/meta-webhook-event.model';
import type { WhatsAppContext } from '../../src/modules/whatsapp/context';
import { connectFakeStatusWebhooks } from '../../src/modules/whatsapp/fake-statuses';
import type { WhatsAppJobs } from '../../src/modules/whatsapp/jobs';
import { useTestDb } from '../helpers/db';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';
import { testEnv } from '../helpers/test-app';

useTestDb();

let redis: Redis;
const prefix = uniquePrefix('fake-statuses');
const env = testEnv();

beforeAll(async () => {
  redis = (await requireRedis()).client;
  await MetaWebhookEventModel.createIndexes();
});
afterAll(async () => {
  await flushPrefix(redis, prefix);
  redis.disconnect();
});

const world = (statusDelaysMs: readonly [number, number, number] | null, jobs: WhatsAppJobs) => {
  const fake = createFakeMetaClient({
    redis,
    prefix,
    appSecret: env.FAKE_META_APP_SECRET ?? '',
    statusDelaysMs,
  });
  const ctx: WhatsAppContext = { env, meta: fake, redis, key: secretBoxKey(env) };
  return { fake, ctx, jobs };
};

const connectNumber = async (fake: FakeMetaClient, n: number) => {
  const s = {
    businessName: `Status Business ${String(n)}`,
    phone: `+91 90000 3${String(n).padStart(4, '0')}`,
    displayName: 'Test Business',
    mode: 'cloud_api' as const,
    outcome: 'finish' as const,
  };
  const { accessToken } = await fake.exchangeCode(buildFakeCode(s));
  return { token: accessToken, ids: fakeIds(s.businessName, s.phone) };
};

describe('fake Meta auto statuses → the real webhook receiver', () => {
  it('statuses are signed, stored once each and queued', async () => {
    const queued: string[] = [];
    const w = world([5, 10, 15], {
      enqueueEvent: (id) => {
        queued.push(id);
        return Promise.resolve();
      },
    });
    const stop = connectFakeStatusWebhooks(w);
    const { token, ids } = await connectNumber(w.fake, 1);
    const { waMessageId } = await w.fake.sendMessage(
      token,
      ids.phoneNumberId,
      buildMessagePayload('919000001300', { type: 'text', body: 'Test' }),
    );
    await vi.waitFor(async () => {
      expect(await MetaWebhookEventModel.countDocuments({ phoneNumberId: ids.phoneNumberId })).toBe(
        3,
      );
    });
    const events = await MetaWebhookEventModel.find({ phoneNumberId: ids.phoneNumberId }).lean();
    expect(events.every((e) => e.field === 'messages' && e.status === 'received')).toBe(true);
    expect(queued).toHaveLength(3);
    expect(waMessageId).toMatch(/^wamid\.FAKE/);
    stop();
  });

  it('a receiver failure is logged, not thrown; the hook detaches and cancels timers', async () => {
    const w = world([5, 5, 5], { enqueueEvent: () => Promise.reject(new Error('queue down')) });
    const stop = connectFakeStatusWebhooks(w);
    const { token, ids } = await connectNumber(w.fake, 2);
    await w.fake.sendMessage(
      token,
      ids.phoneNumberId,
      buildMessagePayload('919000001301', { type: 'text', body: 'Test' }),
    );
    await new Promise((r) => setTimeout(r, 40));
    // stored, queue failed (Meta would retry the webhook) — nothing crashed
    expect(await MetaWebhookEventModel.countDocuments({ phoneNumberId: ids.phoneNumberId })).toBe(
      3,
    );
    stop();
    const spy = vi.spyOn(w.fake, 'stopStatusTimers');
    stop();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('the real provider gets a no-op hook; createMetaClient passes the env delays and media origin', async () => {
    const graph = createMetaClient(
      {
        ...env,
        META_PROVIDER: 'meta',
        META_APP_ID: '1',
        META_APP_SECRET: 's'.repeat(32),
      },
      { redis },
    );
    const stop = connectFakeStatusWebhooks({
      ctx: { env, meta: graph, redis, key: secretBoxKey(env) },
      jobs: { enqueueEvent: () => Promise.resolve() },
    });
    expect(() => stop()).not.toThrow();

    const fake = createMetaClient(
      { ...env, FAKE_META_STATUS_DELAYS_MS: [1, 2, 3], APP_URL: 'http://localhost:5177' },
      { redis, prefix },
    ) as FakeMetaClient;
    const { token, ids } = await connectNumber(fake, 3);
    const mediaId = await fake.putMedia(Buffer.from('x'), 'image/png');
    expect((await fake.getMediaUrl(token, mediaId, ids.phoneNumberId)).url).toMatch(
      /^http:\/\/localhost:5177\/api\/v1\/dev\/meta\/media\//,
    );
  });
});
