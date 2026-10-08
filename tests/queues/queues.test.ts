import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closeAllQueues,
  createQueue,
  createWorker,
  settleWithin,
} from '../../src/core/queues/queue-factory';
import { closeAllRedis } from '../../src/core/queues/redis';
import { processSystemJob, startSystemWorker } from '../../src/core/queues/workers/system.worker';
import { createLogger } from '../../src/shared/logger';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';

const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });

describe('BullMQ queue factory', () => {
  let url: string;
  let cleanup: () => Promise<void>;
  const prefix = uniquePrefix('queues');

  beforeAll(async () => {
    const r = await requireRedis();
    url = r.url;
    cleanup = async () => {
      await flushPrefix(r.client, prefix);
      r.client.disconnect();
    };
  });

  afterAll(async () => {
    await closeAllQueues();
    await closeAllRedis();
    await cleanup();
  });

  it('processes a job end to end', async () => {
    const queue = createQueue<{ x: number }>('double', { redisUrl: url, logger, prefix });
    const worker = createWorker<{ x: number }, number>(
      'double',
      (job) => Promise.resolve(job.data.x * 2),
      {
        redisUrl: url,
        logger,
        prefix,
      },
    );
    const done = new Promise<number>((resolve) =>
      worker.once('completed', (_job, result) => resolve(result)),
    );
    await queue.add('double', { x: 21 });
    expect(await done).toBe(42);
  });

  it('retries a failing job `attempts` times, then marks it failed', async () => {
    let calls = 0;
    const queue = createQueue('flaky', { redisUrl: url, logger, prefix });
    const worker = createWorker(
      'flaky',
      () => {
        calls += 1;
        return Promise.reject(new Error('nope'));
      },
      { redisUrl: url, logger, prefix },
    );
    const failed = new Promise<Job | undefined>((resolve) =>
      worker.on('failed', (job) => {
        if (job && job.attemptsMade >= 2) resolve(job);
      }),
    );
    await queue.add('flaky', {}, { attempts: 2, backoff: { type: 'fixed', delay: 10 } });
    const job = await failed;
    expect(calls).toBe(2);
    expect(job?.failedReason).toBe('nope');
  });

  it('logs worker errors instead of crashing', () => {
    const lines: string[] = [];
    const capture = createLogger(
      { NODE_ENV: 'test', LOG_LEVEL: 'error' },
      { write: (line: string) => lines.push(line) },
    );
    const worker = createWorker('noisy', () => Promise.resolve(), {
      redisUrl: url,
      logger: capture,
      prefix,
    });
    worker.emit('error', new Error('redis hiccup'));
    expect(lines.join('')).toContain('worker error');
    expect(lines.join('')).toContain('redis hiccup');
  });

  it('closeAllQueues gives up after the timeout instead of hanging', async () => {
    const lines: string[] = [];
    const capture = createLogger(
      { NODE_ENV: 'test', LOG_LEVEL: 'warn' },
      { write: (line: string) => lines.push(line) },
    );
    let release: () => void = () => undefined;
    const queue = createQueue('stuck', { redisUrl: url, logger, prefix });
    const worker = createWorker(
      'stuck',
      () => new Promise<void>((resolve) => (release = resolve)),
      { redisUrl: url, logger, prefix },
    );
    const active = new Promise<void>((resolve) => worker.once('active', () => resolve()));
    await queue.add('stuck', {});
    await active;
    const started = Date.now();
    await closeAllQueues({ timeoutMs: 300, logger: capture });
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(lines.join('')).toContain('workers did not close in time');
    release();
  });

  it('closeAllQueues waits for an active job to finish', async () => {
    let finished = false;
    const queue = createQueue('slow', { redisUrl: url, logger, prefix });
    const worker = createWorker(
      'slow',
      async () => {
        await new Promise((r) => setTimeout(r, 300));
        finished = true;
      },
      { redisUrl: url, logger, prefix },
    );
    const active = new Promise<void>((resolve) => worker.once('active', () => resolve()));
    await queue.add('slow', {});
    await active;
    await closeAllQueues();
    expect(finished).toBe(true);
  });
});

describe('system worker', () => {
  it('processes heartbeat jobs and rejects unknown ones', async () => {
    const result = await processSystemJob({ name: 'heartbeat' } as Job);
    expect(result.ok).toBe(true);
    expect(Date.parse(result.at)).not.toBeNaN();
    await expect(processSystemJob({ name: 'other' } as Job)).rejects.toThrow(/Unknown system job/);
  });

  it('starts, schedules a heartbeat and completes it', async () => {
    const r = await requireRedis();
    const prefix = uniquePrefix('system');
    const { queue, worker } = await startSystemWorker({ redisUrl: r.url, logger, prefix });
    const completed = await new Promise<{ ok: boolean }>((resolve) =>
      worker.once('completed', (_job, result) => resolve(result)),
    );
    expect(completed.ok).toBe(true);
    expect((await queue.getJobSchedulers()).map((s) => s.key)).toContain('system-heartbeat');
    await closeAllQueues();
    await closeAllRedis();
    await flushPrefix(r.client, prefix);
    r.client.disconnect();
  });
});

describe('settleWithin', () => {
  it('is true when the work resolves or rejects in time', async () => {
    expect(await settleWithin(Promise.resolve('ok'), 1_000)).toBe(true);
    expect(await settleWithin(Promise.reject(new Error('close failed')), 1_000)).toBe(true);
  });

  it('is false when the work does not settle in time', async () => {
    expect(await settleWithin(new Promise(() => undefined), 20)).toBe(false);
  });
});
