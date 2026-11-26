/**
 * PIN: limits of the superadmin "Partner API (Pinnacle)" reference. Constants only (no env):
 * changed by a release.
 */
export const PARTNER_API_CONFIG = Object.freeze({
  /** Reveals of a managed number's API key per superadmin per hour. */
  revealsPerHour: 5,
  /** The revealed key is shown this long in the browser, then masked again. */
  revealShowSec: 60,
  /** "Try it" reads per superadmin per 10 minutes. */
  tryPer10Min: 20,
  /** Longest answer body shown by Try it (characters, after masking). */
  tryBodyMaxChars: 20_000,
});
