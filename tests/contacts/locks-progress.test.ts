import { Types } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/realtime/notify', () => ({ notifyAccount: vi.fn() }));

import { notifyAccount } from '../../src/core/realtime/notify';
import {
  acquireJobLock,
  jobLockKey,
  refreshJobLock,
  releaseJobLock,
} from '../../src/modules/contacts/locks';
import { createProgressReporter } from '../../src/modules/contacts/progress';
import { requireRedis } from '../helpers/redis';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('job locks', () => {
  it('one owner per account and kind; the owner may re-acquire, refresh and release', async () => {
    const { client } = await requireRedis();
    const account = new Types.ObjectId().toString();
    expect(jobLockKey('import', account)).toBe(`contacts:import-lock:${account}`);
    expect(jobLockKey('export', account)).toBe(`contacts:job-lock:${account}:export`);
    expect(await acquireJobLock('import', account, 'job-a', 5000)).toBe(true);
    expect(await acquireJobLock('import', account, 'job-b', 5000)).toBe(false);
    expect(await acquireJobLock('import', account, 'job-a', 5000)).toBe(true);
    expect(await acquireJobLock('bulk', account, 'job-b', 5000)).toBe(true);
    await refreshJobLock('import', account, 'job-a', 60_000);
    expect(await client.pttl(jobLockKey('import', account))).toBeGreaterThan(5000);
    await releaseJobLock('import', account, 'job-b'); // not the owner — no effect
    expect(await acquireJobLock('import', account, 'job-b', 5000)).toBe(false);
    await releaseJobLock('import', account, 'job-a');
    expect(await acquireJobLock('import', account, 'job-b', 5000)).toBe(true);
    await releaseJobLock('import', account, 'job-b');
    await releaseJobLock('bulk', account, 'job-b');
    await client.quit();
  });
});

describe('progress reporter', () => {
  it('throttles to one event per interval, always on status change or force', () => {
    vi.useFakeTimers({ now: new Date('2026-10-09T00:00:00Z') });
    const report = createProgressReporter('acc', 'import.progress', { importJobId: 'j1' }, 1000);
    report(0, 10, 'importing');
    report(1, 10, 'importing');
    report(2, 10, 'importing', true);
    vi.advanceTimersByTime(1000);
    report(3, 10, 'importing');
    report(4, 10, 'completed');
    expect(vi.mocked(notifyAccount).mock.calls).toEqual([
      [
        'acc',
        'import.progress',
        { importJobId: 'j1', processed: 0, total: 10, status: 'importing' },
      ],
      [
        'acc',
        'import.progress',
        { importJobId: 'j1', processed: 2, total: 10, status: 'importing' },
      ],
      [
        'acc',
        'import.progress',
        { importJobId: 'j1', processed: 3, total: 10, status: 'importing' },
      ],
      [
        'acc',
        'import.progress',
        { importJobId: 'j1', processed: 4, total: 10, status: 'completed' },
      ],
    ]);
  });
});
