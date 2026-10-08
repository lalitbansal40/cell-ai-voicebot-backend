import type { Job, Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import {
  CONTACT_JOB_HANDLERS,
  processContactJob,
  type ContactJobContext,
} from '../../src/core/queues/workers/contacts.worker';
import {
  CONTACT_JOB_NAMES,
  isContactJobName,
  queueContactJobs,
  unavailableContactJobs,
} from '../../src/modules/contacts/jobs';
import { createLogger } from '../../src/shared/logger';
import { recordingContactJobs, useTempStorage } from '../helpers/contacts';

const storage = useTempStorage();
const ctx: ContactJobContext = {
  storage,
  jobs: recordingContactJobs().jobs,
  logger: createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
};
const job = (name: string, data: unknown = {}) => ({ name, data }) as Job;

describe('contacts worker', () => {
  it('dispatches by job name with the context', async () => {
    const handler = vi.fn().mockResolvedValue({ done: 1 });
    const run = processContactJob(ctx, { 'field.delete_values': handler });
    await expect(run(job('field.delete_values', { accountId: 'a', key: 'k' }))).resolves.toEqual({
      done: 1,
    });
    expect(handler).toHaveBeenCalledWith({ accountId: 'a', key: 'k' }, ctx, expect.anything());
  });

  it('throws for unknown or not-registered jobs', async () => {
    await expect(processContactJob(ctx, {})(job('import.run'))).rejects.toThrow(
      'Unknown contacts job "import.run"',
    );
    await expect(processContactJob(ctx)(job('nope'))).rejects.toThrow('Unknown contacts job');
    expect(typeof CONTACT_JOB_HANDLERS).toBe('object');
  });
});

describe('contact jobs', () => {
  it('knows its job names', () => {
    expect(CONTACT_JOB_NAMES).toContain('import.validate');
    expect(isContactJobName('export.run')).toBe(true);
    expect(isContactJobName('email.send')).toBe(false);
  });

  it('adds jobs to the queue with retry options and ids-only data', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const jobs = queueContactJobs({ add } as unknown as Queue);
    await jobs.enqueue('list.delete_members', { accountId: 'a', listId: 'l' });
    expect(add).toHaveBeenCalledWith(
      'list.delete_members',
      { accountId: 'a', listId: 'l' },
      expect.objectContaining({ attempts: 3, removeOnComplete: true }),
    );
  });

  it('records jobs in tests and refuses without a queue', async () => {
    const rec = recordingContactJobs();
    await rec.jobs.enqueue('field.delete_values', { accountId: 'a', key: 'k' });
    expect(rec.queued).toEqual([
      { name: 'field.delete_values', data: { accountId: 'a', key: 'k' } },
    ]);
    await expect(
      unavailableContactJobs.enqueue('field.delete_values', { accountId: 'a', key: 'k' }),
    ).rejects.toThrow('not configured');
  });
});
