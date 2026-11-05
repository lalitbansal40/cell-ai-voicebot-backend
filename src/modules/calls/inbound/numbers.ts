/**
 * Numbers of an incoming trunk call (Phase 20, D4): the dialed number (DID) and the
 * caller as the trunk sends them — `0…`, 10 digits, `91…`, `+91…`, or a SIP URI
 * (`sip:+911600000001@host`) — to E.164. A hidden caller is `null`.
 */

const HIDDEN = /^(anonymous|restricted|private|unknown|unavailable)$/i;

const digitsOf = (raw: string): string => {
  const trimmed = raw.trim();
  // `sip:<user>@host` / `<sip:…>`: the user part
  const uri = /sip:([^@;>]+)/i.exec(trimmed);
  return (uri ? (uri[1] ?? '') : trimmed).replace(/[^\d+]/g, '');
};

/** E.164 of a number in Indian trunk formats (`defaultCc` for national numbers); null if not one. */
export const normalizeTrunkNumber = (raw: string, defaultCc = '91'): string | null => {
  if (!raw || HIDDEN.test(raw.trim())) return null;
  let d = digitsOf(raw);
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = `${defaultCc}${d.slice(1)}`;
  else if (d.length === 10) d = `${defaultCc}${d}`;
  if (d.includes('+') || !/^[1-9]\d{7,14}$/.test(d)) return null;
  return `+${d}`;
};

/** The dialed number (DID); a missing / malformed one → null (the call is refused). */
export const normalizeDid = (raw: string): string | null => normalizeTrunkNumber(raw);

/** The caller; hidden / malformed → null (no contact is made, no spam counter). */
export const normalizeCaller = (raw: string): string | null => normalizeTrunkNumber(raw);
