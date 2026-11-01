/** Routes with no sign-in and no limiter of their own, and why that is fine. */
export const RATE_LIMIT_EXEMPT: Record<string, string> = {
  'GET /api/v1/api-keys/whoami': 'Needs an API key, so the per-key limit applies',
  'GET /health': 'Health check; cheap, no data',
  'GET /ready': 'Blocked at nginx; internal only',
  'GET /api/v1/health': 'Health check; cheap, no data',
  'GET /api/v1/ready': 'Blocked at nginx; internal only',
  'GET /api/v1/system/info': 'Static build info',
  'GET /api/v1/openapi.json': 'Built once and served from memory',
  'GET /api/v1/openapi.public.json': 'Built once and served from memory',
  'POST /api/v1/auth/logout': 'Origin checked; only ends the caller’s own session',
  'POST /api/v1/webhooks/razorpay': 'Signed with HMAC over raw bytes; size limited',
  'POST /api/v1/webhooks/meta': 'Signed with HMAC over raw bytes; size limited',
  'GET /api/v1/webhooks/meta': 'Verify token checked; returns a challenge only',
};

/** Signed-in routes costly enough to need a limiter of their own. */
export const RATE_LIMIT_REQUIRED = ['POST /api/v1/admin/accounts'];
