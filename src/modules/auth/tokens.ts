import { randomUUID } from 'node:crypto';

import { errors, jwtVerify, SignJWT } from 'jose';

import { UnauthenticatedError } from '../../shared/errors/app-error';

import { ACCESS_AUDIENCE, ISSUER } from './auth.constants';
import { getAuthSecrets } from './secrets';

export interface AccessClaims {
  /** userId */
  sub: string;
  /** accountId */
  acc: string;
  /** roleId */
  rid: string;
  /** user tokenVersion */
  tv: number;
  /** session id (refresh family, or `imp_…` for impersonation) */
  sid: string;
  /** impersonating superadmin's userId */
  imp?: string;
}

const key = () => new TextEncoder().encode(getAuthSecrets().access);

/** Signs a short-lived HS256 access token (ADR 0009). `ttl` like `15m`. */
export const signAccessToken = async (
  claims: AccessClaims,
  ttl: string,
): Promise<{ token: string; expiresAt: Date }> => {
  const { sub, ...rest } = claims;
  const jwt = new SignJWT({ ...rest })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(ACCESS_AUDIENCE)
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime(ttl);
  const token = await jwt.sign(key());
  const [, payload] = token.split('.');
  const { exp } = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as {
    exp: number;
  };
  return { token, expiresAt: new Date(exp * 1000) };
};

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Verifies signature, alg, issuer, audience and expiry. Expired → AUTH_TOKEN_EXPIRED. */
export const verifyAccessToken = async (token: string): Promise<AccessClaims> => {
  try {
    const { payload } = await jwtVerify(token, key(), {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: ACCESS_AUDIENCE,
      clockTolerance: 5,
    });
    const { sub, acc, rid, tv, sid, imp } = payload as Record<string, unknown>;
    if (
      !isString(sub) ||
      !isString(acc) ||
      !isString(rid) ||
      !isString(sid) ||
      typeof tv !== 'number'
    ) {
      throw new UnauthenticatedError();
    }
    return { sub, acc, rid, tv, sid, ...(isString(imp) ? { imp } : {}) };
  } catch (err) {
    if (err instanceof errors.JWTExpired) throw new UnauthenticatedError('AUTH_TOKEN_EXPIRED');
    throw new UnauthenticatedError();
  }
};
