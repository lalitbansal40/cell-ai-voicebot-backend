import { hash, verify } from '@node-rs/argon2';

import type { ErrorDetail } from '../../shared/errors/app-error';

import { ARGON2_PARAMS, PASSWORD_MAX, PASSWORD_MIN } from './auth.constants';
import { COMMON_PASSWORDS } from './common-passwords';

const PARAMS_TAG = `m=${ARGON2_PARAMS.memoryCost},t=${ARGON2_PARAMS.timeCost},p=${ARGON2_PARAMS.parallelism}`;

export const hashPassword = (password: string): Promise<string> => hash(password, ARGON2_PARAMS);

/** `needsRehash` when the stored hash used other argon2 parameters. */
export const verifyPassword = async (
  passwordHash: string,
  password: string,
): Promise<{ ok: boolean; needsRehash: boolean }> => {
  try {
    const ok = await verify(passwordHash, password);
    return { ok, needsRehash: ok && !passwordHash.includes(PARAMS_TAG) };
  } catch {
    return { ok: false, needsRehash: false };
  }
};

let dummyHash: Promise<string> | undefined;

/**
 * Runs a full argon2 verify against a throw-away hash so a login for an
 * unknown email takes as long as a real one (no enumeration by timing).
 */
export const verifyAgainstDummy = async (password: string): Promise<false> => {
  dummyHash ??= hash('dummy-password-for-timing-only', ARGON2_PARAMS);
  await verify(await dummyHash, password).catch(() => false);
  return false;
};

/** NIST-style policy: length + not your email / name + not a common password. */
export const validatePasswordPolicy = (
  password: string,
  context: { email?: string; name?: string } = {},
  path = 'password',
): ErrorDetail[] => {
  const issues: string[] = [];
  const lower = password.toLowerCase();
  if (password.length < PASSWORD_MIN) issues.push(`Must be at least ${PASSWORD_MIN} characters.`);
  if (password.length > PASSWORD_MAX) issues.push(`Must be at most ${PASSWORD_MAX} characters.`);
  const email = context.email?.trim().toLowerCase();
  if (email) {
    const local = email.split('@')[0] ?? '';
    if (lower === email || (local.length >= 4 && lower.includes(local))) {
      issues.push('Must not contain your email address.');
    }
  }
  const name = context.name?.trim().toLowerCase();
  if (name && name.length >= 3 && lower === name.replace(/\s+/g, '')) {
    issues.push('Must not be your name.');
  }
  if (COMMON_PASSWORDS.has(lower)) issues.push('This password is too common.');
  return issues.map((message) => ({ path, message }));
};
