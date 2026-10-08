import { afterEach, describe, expect, it, vi } from 'vitest';

import { getAppInfo } from './index';

describe('getAppInfo', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the backend app name', () => {
    expect(getAppInfo().name).toBe('cell-ai-voicebot-backend');
  });

  it('reports the running Node major version (24)', () => {
    expect(getAppInfo().node).toMatch(/^v24\./);
  });

  it('defaults env to development when NODE_ENV is not set', () => {
    vi.stubEnv('NODE_ENV', undefined);
    expect(getAppInfo().env).toBe('development');
  });

  it('uses NODE_ENV when set', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(getAppInfo().env).toBe('production');
  });
});
