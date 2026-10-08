import { describe, expect, it } from 'vitest';

import { getAppInfo } from '../../shared/app-info';

import { AppInfoSchema } from './system.schema';

describe('AppInfoSchema', () => {
  it('accepts the real getAppInfo() output', () => {
    expect(AppInfoSchema.parse(getAppInfo())).toEqual(getAppInfo());
  });

  it('rejects a payload with missing fields', () => {
    expect(AppInfoSchema.safeParse({ name: 'x' }).success).toBe(false);
  });

  it('rejects wrong field types', () => {
    const result = AppInfoSchema.safeParse({ name: 'x', version: 1, node: 'v24', env: 'dev' });
    expect(result.success).toBe(false);
  });
});
