/**
 * Recorded voice is available after deployment without Cell24x7 environment setup.
 * Accounts connect their own API key in the dashboard; tokens stay encrypted in MongoDB
 * and each account's webhook secret is generated when its webhook is registered.
 * These are public provider defaults, never credentials.
 */
export const VOICE_API_CONFIG = Object.freeze({
  enabled: true,
  provider: 'cell24x7' as const,
  baseUrl: 'https://voice.truebeeps.com/api/v1/voice/partner',
  callerId: '9999999999',
  batchSize: 200,
  lines: 4,
  pollSec: 120,
  fakeDelayMs: 2000,
});
