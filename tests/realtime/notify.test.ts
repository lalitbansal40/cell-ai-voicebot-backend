import { afterEach, describe, expect, it, vi } from 'vitest';

import { setRealtime, tryGetRealtime, type Realtime } from '../../src/core/realtime';
import { notifyAccount, notifyUser } from '../../src/core/realtime/notify';

describe('notify helpers', () => {
  afterEach(() => setRealtime(undefined));

  it('are no-ops without a running realtime server', () => {
    expect(tryGetRealtime()).toBeUndefined();
    expect(() => notifyAccount('a', 'team.changed')).not.toThrow();
    expect(() => notifyUser('a', 'u', 'session.revoked')).not.toThrow();
  });

  it('forward to the realtime server and swallow failures', async () => {
    const pushToAccount = vi.fn(() => Promise.reject(new Error('redis down')));
    const pushToUser = vi.fn(() => Promise.resolve({}));
    setRealtime({ pushToAccount, pushToUser } as unknown as Realtime);
    notifyAccount('acc', 'team.changed', { x: 1 });
    notifyUser('acc', 'u1', 'session.revoked', { reason: 'r' }, { close: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(pushToAccount).toHaveBeenCalledWith('acc', 'team.changed', { x: 1 });
    expect(pushToUser).toHaveBeenCalledWith(
      'acc',
      'u1',
      'session.revoked',
      { reason: 'r' },
      { close: true },
    );
  });
});
