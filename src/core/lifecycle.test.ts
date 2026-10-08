import { describe, expect, it, vi } from 'vitest';

import { createLogger } from '../shared/logger';

import { createLifecycle } from './lifecycle';

const silent = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });

describe('createLifecycle', () => {
  it('runs hooks in ascending order and exits with the given code', async () => {
    const calls: string[] = [];
    const exit = vi.fn();
    const lc = createLifecycle(silent, { exit });
    lc.onShutdown(
      'mongo',
      () => {
        calls.push('mongo');
      },
      50,
    );
    lc.onShutdown(
      'http',
      async () => {
        await Promise.resolve();
        calls.push('http');
      },
      10,
    );
    lc.onShutdown(
      'queues',
      () => {
        calls.push('queues');
      },
      30,
    );
    await lc.shutdown('test', 0);
    expect(calls).toEqual(['http', 'queues', 'mongo']);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('keeps going when a hook throws', async () => {
    const calls: string[] = [];
    const exit = vi.fn();
    const lc = createLifecycle(silent, { exit });
    lc.onShutdown(
      'a',
      () => {
        throw new Error('boom');
      },
      1,
    );
    lc.onShutdown(
      'b',
      () => {
        calls.push('b');
      },
      2,
    );
    await lc.shutdown('test', 1);
    expect(calls).toEqual(['b']);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('forces exit(1) when hooks exceed the timeout', async () => {
    const exit = vi.fn();
    const lc = createLifecycle(silent, { exit, timeoutMs: 20 });
    lc.onShutdown('stuck', () => new Promise<void>(() => undefined));
    await lc.shutdown('test', 0);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('is idempotent', async () => {
    const hook = vi.fn();
    const exit = vi.fn();
    const lc = createLifecycle(silent, { exit });
    lc.onShutdown('once', hook);
    await Promise.all([lc.shutdown('a'), lc.shutdown('b')]);
    await lc.shutdown('c');
    expect(hook).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
