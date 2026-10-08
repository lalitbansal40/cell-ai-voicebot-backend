import { QueueEvents, type Queue, type Worker } from 'bullmq';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createEmailService,
  EmailPermanentError,
  MemoryEmailProvider,
  type EmailJobData,
  type EmailSendResult,
} from '../../src/core/email';
import { QUEUES } from '../../src/core/queues/names';
import { closeAllQueues, createQueue } from '../../src/core/queues/queue-factory';
import { closeAllRedis, createRedis } from '../../src/core/queues/redis';
import { startEmailWorker } from '../../src/core/queues/workers/email.worker';
import { createLogger } from '../../src/shared/logger';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';

const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });

describe('email queue + worker (real Redis)', () => {
  let url: string;
  let cleanup: () => Promise<void>;
  const prefix = uniquePrefix('email');
  const provider = new MemoryEmailProvider();
  let queue: Queue<EmailJobData>;
  let worker: Worker<EmailJobData, EmailSendResult>;
  let events: QueueEvents;

  beforeAll(async () => {
    const r = await requireRedis();
    url = r.url;
    cleanup = async () => {
      await flushPrefix(r.client, prefix);
      r.client.disconnect();
    };
    queue = createQueue<EmailJobData>(QUEUES.email, { redisUrl: url, logger, prefix });
    worker = startEmailWorker({ redisUrl: url, logger, prefix, provider });
    events = new QueueEvents(QUEUES.email, {
      connection: createRedis(url, 'test:email-events', logger),
      prefix,
    });
    await events.waitUntilReady();
  });

  afterEach(() => {
    provider.clear();
    provider.failWith = undefined;
  });

  afterAll(async () => {
    await events.close();
    await closeAllQueues();
    await closeAllRedis();
    await cleanup();
  });

  it('enqueue → worker renders and sends through the provider', async () => {
    const service = createEmailService({ provider, queue, logger });
    const { jobId } = await service.enqueue('system.test', 'user@example.com', { name: 'Asha' });
    const job = await queue.getJob(jobId ?? '');
    const result = (await job?.waitUntilFinished(events, 10_000)) as EmailSendResult;
    expect(result.messageId).toBe('mem-1');
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]?.subject).toBe('Test email from Cell AI Voicebot');
    expect(provider.sent[0]?.html).toContain('Asha');
    // Removed on success — the recipient does not linger in Redis.
    expect(await queue.getJob(jobId ?? '')).toBeUndefined();
  });

  it('sends a dedupeKey only once', async () => {
    const service = createEmailService({ provider, queue, logger });
    const a = await service.enqueue(
      'system.test',
      'dedupe@example.com',
      { name: 'x' },
      {
        dedupeKey: 'welcome:dedupe-1',
      },
    );
    const b = await service.enqueue(
      'system.test',
      'dedupe@example.com',
      { name: 'x' },
      {
        dedupeKey: 'welcome:dedupe-1',
      },
    );
    expect(b.jobId).toBe(a.jobId);
    await expect.poll(() => provider.sent.length, { timeout: 10_000 }).toBe(1);
    // Still blocked after the first one completed (and was removed).
    await service.enqueue(
      'system.test',
      'dedupe@example.com',
      { name: 'x' },
      {
        dedupeKey: 'welcome:dedupe-1',
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(provider.sent).toHaveLength(1);
    expect(await queue.getJobCounts('waiting', 'active', 'delayed')).toEqual({
      waiting: 0,
      active: 0,
      delayed: 0,
    });
  });

  it('does not retry a permanent SMTP rejection', async () => {
    provider.failWith = new EmailPermanentError('SMTP rejected the message (550)');
    const service = createEmailService({ provider, queue, logger });
    const { jobId } = await service.enqueue('system.test', 'gone@example.com', { name: 'x' });
    await expect
      .poll(async () => queue.getJobState(jobId ?? ''), { timeout: 10_000 })
      .toBe('failed');
    const job = await queue.getJob(jobId ?? '');
    expect(job?.attemptsMade).toBe(1);
    expect(job?.failedReason).toBe('SMTP rejected the message (550)');
  });

  it('retries a transient failure and then delivers', async () => {
    let calls = 0;
    const original = provider.send.bind(provider);
    provider.send = (message) => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('ECONNRESET')) : original(message);
    };
    try {
      const job = await queue.add(
        'system.test',
        { template: 'system.test', to: 'retry@example.com', vars: { name: 'x' } },
        { attempts: 3, backoff: { type: 'fixed', delay: 50 }, removeOnComplete: true },
      );
      await job.waitUntilFinished(events, 10_000);
      expect(calls).toBe(2);
      expect(provider.sent.map((m) => m.to)).toEqual(['retry@example.com']);
    } finally {
      provider.send = original;
    }
  });

  it('fails an unknown template without retrying', async () => {
    const job = await queue.add(
      'nope',
      { template: 'nope', to: 'x@example.com', vars: {} } as unknown as EmailJobData,
      { attempts: 3, backoff: { type: 'fixed', delay: 50 } },
    );
    await expect.poll(async () => job.getState(), { timeout: 10_000 }).toBe('failed');
    expect((await queue.getJob(job.id ?? ''))?.attemptsMade).toBe(1);
  });

  it('uses the email concurrency of 2', () => {
    expect(worker.opts.concurrency).toBe(2);
  });
});
