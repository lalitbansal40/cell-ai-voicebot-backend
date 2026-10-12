import { describe, expect, it, vi } from 'vitest';

import { issueMediaTicket } from '../../src/modules/calls/media-tickets';

describe('media tickets', () => {
  it('issues a media-channel ticket bound to the call', async () => {
    const issue = vi.fn(() =>
      Promise.resolve({ ticket: 'wst_abc', expiresAt: '2026-10-12T00:01:00.000Z' }),
    );
    const out = await issueMediaTicket({ userId: 'u', accountId: 'a', callId: 'c' }, { issue });
    expect(issue).toHaveBeenCalledWith({
      userId: 'u',
      accountId: 'a',
      callId: 'c',
      channel: 'media',
    });
    expect(out).toEqual({
      mediaTicket: 'wst_abc',
      expiresAt: '2026-10-12T00:01:00.000Z',
      wsPath: '/ws/media',
    });
    await expect(issueMediaTicket({ userId: 'u', accountId: 'a', callId: 'c' })).rejects.toThrow(
      'Realtime is not initialised',
    );
  });
});
