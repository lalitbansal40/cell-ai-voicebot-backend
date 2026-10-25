import type { JobsOptions, Queue } from 'bullmq';

/** Background jobs on the `billing` queue (PHASE_4_PLAN §1f). Job data = ids only. */
export interface BillingJobData {
  'invoice.render': { accountId: string; invoiceId: string };
  'billing.reap_holds': Record<string, never>;
  'billing.reconcile': Record<string, never>;
  'billing.expire_orders': Record<string, never>;
  'notifications.purge': Record<string, never>;
  /** Phase 11 — WhatsApp message holds older than `holdMaxAgeMs` are released. */
  'billing.whatsapp_reap_holds': Record<string, never>;
  /** Phase 11 — our captured charges vs Meta's pricing analytics, last 3 days. */
  'billing.whatsapp_reconcile': Record<string, never>;
  /** Phase 12 — WhatsApp call holds left by a dead process. */
  'billing.whatsapp_call_reap_holds': Record<string, never>;
  /** Phase 12 — Meta's late call durations beside the time we charged. */
  'billing.whatsapp_call_reconcile': Record<string, never>;
}

export type BillingJobName = keyof BillingJobData;

export const BILLING_JOB_NAMES = [
  'invoice.render',
  'billing.reap_holds',
  'billing.reconcile',
  'billing.expire_orders',
  'notifications.purge',
  'billing.whatsapp_reap_holds',
  'billing.whatsapp_reconcile',
  'billing.whatsapp_call_reap_holds',
  'billing.whatsapp_call_reconcile',
] as const satisfies readonly BillingJobName[];

export const isBillingJobName = (value: string): value is BillingJobName =>
  (BILLING_JOB_NAMES as readonly string[]).includes(value);

/** Repeatable billing jobs (UTC crons; 21:00 UTC = 02:30 IST). */
export const BILLING_SCHEDULES = [
  { name: 'billing.reap_holds', pattern: '*/5 * * * *' },
  { name: 'billing.reconcile', pattern: '0 21 * * *' },
  { name: 'billing.expire_orders', pattern: '0 * * * *' },
  { name: 'notifications.purge', pattern: '45 3 * * *' },
  { name: 'billing.whatsapp_reap_holds', pattern: '*/30 * * * *' },
  // 03:00 IST
  { name: 'billing.whatsapp_reconcile', pattern: '30 21 * * *' },
  { name: 'billing.whatsapp_call_reap_holds', pattern: '*/15 * * * *' },
  { name: 'billing.whatsapp_call_reconcile', pattern: '10 * * * *' },
] as const satisfies readonly { name: BillingJobName; pattern: string }[];

/** Enqueues billing jobs — the API depends on this interface, not on BullMQ. */
export interface BillingJobs {
  enqueue<N extends BillingJobName>(name: N, data: BillingJobData[N]): Promise<void>;
}

const JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 3600 },
};

export const queueBillingJobs = (queue: Queue): BillingJobs => ({
  async enqueue(name, data) {
    await queue.add(name, data, JOB_OPTIONS);
  },
});

/** Used when an app is built without a queue (tests that never enqueue). */
export const unavailableBillingJobs: BillingJobs = {
  enqueue() {
    return Promise.reject(new Error('Billing jobs are not configured for this app'));
  },
};
