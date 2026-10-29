import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID (26 chars, Crockford base32): 48-bit milliseconds + 80 random bits — sortable by time. */
export const ulid = (now: number = Date.now()): string => {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i += 1) {
    time = (CROCKFORD[t % 32] ?? '0') + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(10);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let rand = '';
  for (let i = 0; i < 16; i += 1) {
    rand = (CROCKFORD[Number(bits & 31n)] ?? '0') + rand;
    bits >>= 5n;
  }
  return time + rand;
};

export const ULID_FORMAT = /^[0-9A-HJKMNP-TV-Z]{26}$/;
