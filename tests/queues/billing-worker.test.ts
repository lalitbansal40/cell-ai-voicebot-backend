import type { Job, Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import {
  BILLING_JOB_NAMES,
  BILLING_SCHEDULES,
  isBillingJobName,
  queueBillingJobs,
  unavailableBillingJobs,
} from '../../src/core/billing/jobs';
import {
  BILLING_JOB_HANDLERS,
  processBillingJob,
  type BillingJobContext,
} from '../../src/core/queues/workers/billing.worker';
import { createLogger } from '../../src/shared/logger';

const ctx: BillingJobContext = {
  jobs: unavailableBillingJobs,
  logger: createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
};
const job = (name: string, data: unknown = {}) => ({ name, data }) as Job;

describe('billing worker', () => {
  it('dispatches by job name with the context', async () => {
    const handler = vi.fn().mockResolvedValue({ released: 2 });
    const run = processBillingJob(ctx, { 'billing.reap_holds': handler });
    await expect(run(job('billing.reap_holds'))).resolves.toEqual({ released: 2 });
    expect(handler).toHaveBeenCalledWith({}, ctx, expect.anything());
  });

  it('throws for unknown or not-registered jobs', async () => {
    await expect(processBillingJob(ctx, {})(job('invoice.render'))).rejects.toThrow(
      'Unknown billing job "invoice.render"',
    );
    await expect(processBillingJob(ctx)(job('nope'))).rejects.toThrow('Unknown billing job');
    expect(Object.keys(BILLING_JOB_HANDLERS).sort()).toEqual([
      'billing.expire_orders',
      'billing.reap_holds',
      'billing.reconcile',
      'invoice.render',
      'notifications.purge',
    ]);
  });

  it('schedules every repeatable job with a UTC cron', () => {
    expect(BILLING_SCHEDULES.map((s) => s.name)).toEqual([
      'billing.reap_holds',
      'billing.reconcile',
      'billing.expire_orders',
      'notifications.purge',
    ]);
    expect(BILLING_SCHEDULES.find((s) => s.name === 'billing.reconcile')?.pattern).toBe(
      '0 21 * * *',
    );
    for (const s of BILLING_SCHEDULES) expect(isBillingJobName(s.name)).toBe(true);
  });
});

describe('billing jobs', () => {
  it('knows its job names', () => {
    expect(BILLING_JOB_NAMES).toContain('invoice.render');
    expect(isBillingJobName('email.send')).toBe(false);
  });

  it('adds jobs with retry options and refuses without a queue', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    await queueBillingJobs({ add } as unknown as Queue).enqueue('invoice.render', {
      accountId: 'a',
      invoiceId: 'i',
    });
    expect(add).toHaveBeenCalledWith(
      'invoice.render',
      { accountId: 'a', invoiceId: 'i' },
      expect.objectContaining({ attempts: 3, removeOnComplete: true }),
    );
    await expect(unavailableBillingJobs.enqueue('billing.reconcile', {})).rejects.toThrow(
      'not configured',
    );
  });
});
