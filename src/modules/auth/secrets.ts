import { getEnv } from '../../config/env';
import { getLogger } from '../../shared/logger';

const DEV_ACCESS = 'dev-only-access-secret-change-me-0123456789abcdef';
const DEV_REFRESH = 'dev-only-refresh-secret-change-me-0123456789abcdef';

let cached: { access: string; refresh: string } | undefined;
let warned = false;

/**
 * JWT access secret + refresh/HMAC secret. Production requires both (env
 * rules); elsewhere fixed development values are used with a warning.
 */
export const getAuthSecrets = (): { access: string; refresh: string } => {
  if (cached) return cached;
  const env = getEnv();
  const access = env.JWT_ACCESS_SECRET ?? (env.NODE_ENV === 'production' ? undefined : DEV_ACCESS);
  const refresh =
    env.JWT_REFRESH_SECRET ?? (env.NODE_ENV === 'production' ? undefined : DEV_REFRESH);
  if (!access || !refresh) throw new Error('JWT secrets are required in production');
  if (!warned && (!env.JWT_ACCESS_SECRET || !env.JWT_REFRESH_SECRET)) {
    warned = true;
    getLogger().warn('auth: JWT secrets not set — using development defaults');
  }
  cached = { access, refresh };
  return cached;
};

/** Tests only. */
export const resetAuthSecretsForTests = (): void => {
  cached = undefined;
  warned = false;
};
