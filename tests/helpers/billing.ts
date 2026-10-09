import type { BillingJobData, BillingJobName, BillingJobs } from '../../src/core/billing/jobs';

/** Billing jobs that are recorded instead of queued (tests). */
export const recordingBillingJobs = () => {
  const queued: { name: BillingJobName; data: BillingJobData[BillingJobName] }[] = [];
  const jobs: BillingJobs = {
    enqueue(name, data) {
      queued.push({ name, data });
      return Promise.resolve();
    },
  };
  return { jobs, queued };
};
