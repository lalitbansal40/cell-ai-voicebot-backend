import { metaAppSecret, signWebhook, type FakeMetaClient } from '../../core/meta';
import { getLogger } from '../../shared/logger';

import type { WhatsAppContext } from './context';
import type { WhatsAppJobs } from './jobs';
import { receiveWebhook } from './webhooks.service';

/**
 * Fake provider only: the fake's auto status webhooks (sent → delivered → read) are
 * signed and handed to the real receiver — the same store / queue / worker path as
 * Meta's. Returns the shutdown hook (detaches and cancels pending timers).
 */
export const connectFakeStatusWebhooks = (deps: {
  ctx: WhatsAppContext;
  jobs: WhatsAppJobs;
}): (() => void) => {
  if (deps.ctx.meta.provider !== 'fake') return () => undefined;
  const fake = deps.ctx.meta as FakeMetaClient;
  fake.setWebhookEmitter(async (body) => {
    const raw = Buffer.from(JSON.stringify(body));
    try {
      await receiveWebhook(deps.ctx, deps.jobs, raw, signWebhook(raw, metaAppSecret(deps.ctx.env)));
    } catch (err) {
      getLogger().warn({ errName: (err as Error).name }, 'fake meta: status webhook not stored');
    }
  });
  return () => {
    fake.setWebhookEmitter(null);
    fake.stopStatusTimers();
  };
};
