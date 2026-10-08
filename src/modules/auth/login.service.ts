import type { Request, Response } from 'express';

import { notifyUser } from '../../core/realtime/notify';
import { RefreshTokenModel } from '../../db/models/refresh-token.model';
import { UserModel } from '../../db/models/user.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { AppError, NotFoundError, UnauthenticatedError } from '../../shared/errors/app-error';
import { auditRequest, recordAudit } from '../audit/audit.service';

import { REFRESH_COOKIE } from './auth.constants';
import { findUserByEmail, sendVerificationCode } from './auth.service';
import { hmacToken } from './hmac';
import { assertNotLocked, clearFailedLogins, registerFailedLogin } from './lockout';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password';
import {
  revokeAllForUser,
  revokeFamily,
  rotateRefresh,
  listActiveSessions,
  type ActiveSession,
} from './refresh.service';
import {
  buildSessionBody,
  clearRefreshCookie,
  loadSessionParts,
  requestMeta,
  sessionFor,
  setRefreshCookie,
  startSession,
  type AuthSession,
  type AuthSessionBody,
} from './session';

const invalidCredentials = () => new UnauthenticatedError('AUTH_INVALID_CREDENTIALS');

/**
 * Login. Order matters: lockout → unknown user (dummy hash, same timing) →
 * password → status. Account status (suspended) does not block login; the
 * session tells the UI, and writes are blocked by `authenticate`.
 */
export const login = async (
  req: Request,
  res: Response,
  input: { email: string; password: string },
): Promise<AuthSession> => {
  const email = input.email.trim().toLowerCase();
  await assertNotLocked(email);
  const user = await findUserByEmail(email);

  if (!user?.passwordHash) {
    await verifyAgainstDummy(input.password);
    await registerFailedLogin(email);
    throw invalidCredentials();
  }

  const { ok, needsRehash } = await verifyPassword(user.passwordHash, input.password);
  if (!ok) {
    await registerFailedLogin(email);
    await recordAudit({
      accountId: user.accountId,
      actor: { type: 'user', id: user._id },
      action: 'auth.login_failed',
      meta: { reason: 'bad_password' },
      ip: req.ip ?? null,
    });
    throw invalidCredentials();
  }
  if (user.status === 'disabled') throw new AppError('AUTH_USER_DISABLED');
  if (user.status !== 'active') throw invalidCredentials();
  if (!user.emailVerifiedAt) {
    await sendVerificationCode(user, { quiet: true });
    throw new AppError('AUTH_EMAIL_NOT_VERIFIED');
  }

  await clearFailedLogins(email);
  await UserModel.updateOne(
    { _id: user._id },
    {
      $set: {
        lastLoginAt: new Date(),
        ...(needsRehash ? { passwordHash: await hashPassword(input.password) } : {}),
      },
    },
  );
  await recordAudit({
    accountId: user.accountId,
    actor: { type: 'user', id: user._id },
    action: 'auth.login',
    ip: req.ip ?? null,
  });
  return startSession(req, res, user._id);
};

const cookieToken = (req: Request): string | undefined => {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

/** Rotates the refresh cookie and returns a fresh session. Any failure clears the cookie. */
export const refresh = async (req: Request, res: Response): Promise<AuthSession> => {
  const raw = cookieToken(req);
  try {
    if (!raw) throw new UnauthenticatedError();
    const { raw: next, doc } = await rotateRefresh(raw, requestMeta(req));
    const parts = await loadSessionParts(doc.userId).catch(async (err: unknown) => {
      await revokeFamily(doc.familyId, 'session_revoked');
      throw err;
    });
    if (parts.user.status === 'disabled') {
      await revokeFamily(doc.familyId, 'disabled');
      throw new AppError('AUTH_USER_DISABLED');
    }
    if (parts.user.status !== 'active' || !parts.user.emailVerifiedAt) {
      await revokeFamily(doc.familyId, 'session_revoked');
      throw new UnauthenticatedError('AUTH_SESSION_REVOKED');
    }
    setRefreshCookie(res, next);
    return await sessionFor(parts, doc.familyId);
  } catch (err) {
    clearRefreshCookie(res);
    throw err;
  }
};

/** Ends the cookie's session (idempotent — always clears the cookie). */
export const logout = async (req: Request, res: Response): Promise<void> => {
  const raw = cookieToken(req);
  clearRefreshCookie(res);
  if (!raw) return;
  const doc = await RefreshTokenModel.findOne({ tokenHash: hmacToken(raw) }).lean();
  if (!doc) return;
  if ((await revokeFamily(doc.familyId, 'logout')) === 0) return;
  await recordAudit({
    accountId: doc.accountId,
    actor: { type: 'user', id: doc.userId },
    action: 'auth.logout',
    ip: req.ip ?? null,
  });
};

/** Signs the user out everywhere: tokenVersion++ (access tokens die), all refresh families revoked. */
export const logoutAll = async (req: Request, res: Response): Promise<void> => {
  const auth = requireAuth(req);
  const userId = auth.userId ?? '';
  await UserModel.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
  await revokeAllForUser(userId, 'logout_all');
  clearRefreshCookie(res);
  notifyUser(auth.accountId, userId, 'session.revoked', { reason: 'logout_all' }, { close: true });
  await auditRequest(req, 'auth.logout_all');
};

/** `GET /auth/me` — the session without a token. */
export const me = async (req: Request): Promise<AuthSessionBody> => {
  const auth = requireAuth(req);
  const parts = await loadSessionParts(auth.userId ?? '');
  return buildSessionBody(
    parts,
    auth.impersonatorId
      ? {
          impersonatorId: auth.impersonatorId,
          expiresAt: (auth.tokenExpiresAt ?? new Date()).toISOString(),
        }
      : null,
  );
};

export const sessions = async (req: Request): Promise<(ActiveSession & { current: boolean })[]> => {
  const auth = requireAuth(req);
  const list = await listActiveSessions(auth.userId ?? '');
  return list.map((s) => ({ ...s, current: s.id === auth.sessionId }));
};

/** Revokes one of the caller's own sessions (another user's / unknown id → 404). */
export const revokeSession = async (
  req: Request,
  res: Response,
  familyId: string,
): Promise<void> => {
  const auth = requireAuth(req);
  const owned = await RefreshTokenModel.exists({ familyId, userId: auth.userId, revokedAt: null });
  if (!owned) throw new NotFoundError();
  await revokeFamily(familyId, 'session_revoked');
  if (familyId === auth.sessionId) clearRefreshCookie(res);
  await auditRequest(req, 'auth.session_revoked', { target: { type: 'session', id: familyId } });
};
