import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import {
  assertSuppressionReady,
  isBlockedForOutreach,
  recordSuppression,
  suppressedPhones,
} from '../../src/modules/privacy/suppression';

const env = vi.hoisted(() => ({
  value: { NODE_ENV: 'production', SUPPRESSION_HMAC_KEY: undefined as string | undefined },
}));
vi.mock('../../src/config/env', async (original) => ({
  ...(await original<object>()),
  getEnv: () => env.value,
}));

describe('suppression without SUPPRESSION_HMAC_KEY in production', () => {
  const accountId = new Types.ObjectId();

  it('erase refuses with 503, and a deploy without the key keeps working', async () => {
    expect(() => assertSuppressionReady()).toThrow(
      expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE', status: 503 }) as Error,
    );
    await expect(recordSuppression(accountId, '+919800000000', 'erased')).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect((await suppressedPhones(accountId, ['+919800000000'])).size).toBe(0);
    expect(await isBlockedForOutreach(accountId, ['+919800000000'])).toBe(false);
  });
});
