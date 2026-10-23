import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { processWhatsAppJob } from '../../src/core/queues/workers/whatsapp.worker';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import {
  queueTemplateJobs,
  TEMPLATE_DAILY_SYNC_JOB,
  TEMPLATE_JOBS,
} from '../../src/modules/templates/jobs';
import { createWhatsAppService } from '../../src/modules/whatsapp/whatsapp.service';
import { createTestAccount } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { useTemplateWorld } from '../helpers/templates';
import { codeFor, fakeSignup, userActor } from '../helpers/whatsapp';

useTestDb();
const t = useTemplateWorld();

const job = (name: string, data: unknown) =>
  ({ name, data, attemptsMade: 0, opts: { attempts: 3 } }) as unknown as Job;

describe('template wiring', () => {
  it('queues sync / backfill with ids and retry options', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const jobs = queueTemplateJobs({ add } as never);
    await jobs.enqueueSync('c1', 'manual');
    await jobs.enqueueBackfill();
    expect(add).toHaveBeenNthCalledWith(
      1,
      'template.sync',
      { channelId: 'c1', reason: 'manual' },
      expect.objectContaining({ jobId: 'template-sync-c1', attempts: 3 }),
    );
    expect(add).toHaveBeenNthCalledWith(
      2,
      'templates.backfill',
      {},
      expect.objectContaining({ jobId: 'templates-backfill' }),
    );
  });

  it('the whatsapp worker runs template jobs only with a template context', async () => {
    await t.setup();
    const h = { ctx: t.w.ctx, service: t.w.svc };
    const run = processWhatsAppJob(h, undefined, t.state.tx);
    expect(await run(job(TEMPLATE_JOBS.backfill, {}))).toMatchObject({ processed: 0 });
    expect(await run(job(TEMPLATE_DAILY_SYNC_JOB, {}))).toMatchObject({
      queued: expect.any(Number),
    });
    expect(await run(job(TEMPLATE_JOBS.sync, { channelId: 'nope', reason: 'daily' }))).toEqual({
      skipped: 'channel',
    });
    await expect(processWhatsAppJob(h)(job(TEMPLATE_JOBS.sync, {}))).rejects.toThrow(
      'Unknown whatsapp job',
    );
  });

  it('a successful connect queues a template sync; a failing hook never fails the connect', async () => {
    const acc = await createTestAccount();
    const seen: string[] = [];
    const svc = createWhatsAppService(t.w.ctx, {
      onConnected: (c) => {
        seen.push(c._id.toString());
        return Promise.resolve();
      },
    });
    const r = await svc.connect({
      accountId: acc.account._id,
      actor: userActor(),
      mode: 'cloud_api',
      code: codeFor(fakeSignup()),
    });
    expect(seen).toEqual([r.channel.id]);
    const failing = createWhatsAppService(t.w.ctx, {
      onConnected: () => Promise.reject(new Error('queue down')),
    });
    const acc2 = await createTestAccount();
    const r2 = await failing.connect({
      accountId: acc2.account._id,
      actor: userActor(),
      mode: 'cloud_api',
      code: codeFor(fakeSignup()),
    });
    expect((await WhatsAppChannelModel.findById(r2.channel.id).lean())?.status).toBe('connected');
  });
});
