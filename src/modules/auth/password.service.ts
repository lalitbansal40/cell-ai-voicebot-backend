import type { Request, Response } from 'express';

import { getEnv } from '../../config/env';
import { getEmail } from '../../core/email';
import { notifyUser } from '../../core/realtime/notify';
import { UserModel, type UserDoc } from '../../db/models/user.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { isFullAccess } from '../../shared/auth/impersonation';
import { AppError, UnauthenticatedError, ValidationError } from '../../shared/errors/app-error';
import { auditRequest, recordAudit } from '../audit/audit.service';

import { RESET_TTL_MS } from './auth.constants';
import { findUserByEmail } from './auth.service';
import { consumeResetToken, issueResetToken, peekResetToken } from './codes.service';
import { fullFacts } from './login-as';
import { hashPassword, validatePasswordPolicy, verifyPassword } from './password';
import { revokeAllForUser } from './refresh.service';
import {
  accessTokenFor,
  buildSessionBody,
  loadSessionParts,
  returnToFor,
  sessionFor,
  type AuthSession,
} from './session';

const frontendUrl = (path: string) => `${getEnv().FRONTEND_URL.replace(/\/+$/, '')}${path}`;

const sendPasswordChangedEmail = (user: Pick<UserDoc, '_id' | 'name' | 'email'>) =>
  getEmail().enqueue(
    'auth.password_changed',
    user.email,
    { name: user.name, at: new Date().toUTCString(), resetUrl: frontendUrl('/forgot-password') },
    { dedupeKey: `pwchanged:${user._id.toString()}:${Date.now()}` },
  );

/** Always 202 upstream: only active, verified users get a reset link. */
export const forgotPassword = async (req: Request, email: string): Promise<void> => {
  const user = await findUserByEmail(email);
  if (!user || user.status !== 'active' || !user.emailVerifiedAt || !user.passwordHash) return;
  const token = await issueResetToken(user._id);
  await getEmail().enqueue(
    'auth.reset_password',
    user.email,
    {
      name: user.name,
      resetUrl: frontendUrl(`/reset-password?token=${encodeURIComponent(token)}`),
      minutes: RESET_TTL_MS / 60_000,
    },
    { dedupeKey: `reset:${user._id.toString()}:${Date.now()}` },
  );
  await recordAudit({
    accountId: user.accountId,
    actor: { type: 'user', id: user._id },
    action: 'auth.password_reset_requested',
    ip: req.ip ?? null,
  });
};

/**
 * Sets a new password from a reset link. The token is checked first, the
 * password validated, and only then is the token used (a policy error does
 * not burn the link). Every session and access token of the user ends.
 */
export const resetPassword = async (
  req: Request,
  input: { token: string; password: string },
): Promise<void> => {
  const userId = await peekResetToken(input.token);
  const user = await UserModel.findById(userId).lean<UserDoc>();
  if (!user || user.status !== 'active') throw new AppError('AUTH_CODE_INVALID');
  const issues = validatePasswordPolicy(
    input.password,
    { email: user.email, name: user.name },
    'body.password',
  );
  if (issues.length) throw new ValidationError(issues);
  await consumeResetToken(input.token);

  await UserModel.updateOne(
    { _id: user._id },
    {
      $set: { passwordHash: await hashPassword(input.password), passwordChangedAt: new Date() },
      $inc: { tokenVersion: 1 },
    },
  );
  await revokeAllForUser(user._id, 'password_changed');
  notifyUser(
    user.accountId.toString(),
    user._id.toString(),
    'session.revoked',
    { reason: 'password_changed' },
    { close: true },
  );
  await sendPasswordChangedEmail(user);
  await recordAudit({
    accountId: user.accountId,
    actor: { type: 'user', id: user._id },
    action: 'auth.password_reset',
    ip: req.ip ?? null,
  });
};

/**
 * Change password while signed in: other sessions end, this one continues
 * with a new access token (tokenVersion changed).
 */
export const changePassword = async (
  req: Request,
  _res: Response,
  input: { currentPassword?: string | undefined; newPassword: string },
): Promise<AuthSession> => {
  const auth = requireAuth(req);
  const full = isFullAccess(auth);
  const user = await UserModel.findById(auth.userId).lean<UserDoc>();
  if (!user?.passwordHash) throw new UnauthenticatedError();
  // SAC: in superadmin full access the route's step-up stands in for the owner's password
  if (!full) {
    if (!input.currentPassword) throw new UnauthenticatedError('AUTH_INVALID_CREDENTIALS');
    const { ok } = await verifyPassword(user.passwordHash, input.currentPassword);
    if (!ok) throw new UnauthenticatedError('AUTH_INVALID_CREDENTIALS');
  }
  if (input.currentPassword && input.newPassword === input.currentPassword) {
    throw new ValidationError([
      { path: 'body.newPassword', message: 'Must be different from your current password.' },
    ]);
  }
  const issues = validatePasswordPolicy(
    input.newPassword,
    { email: user.email, name: user.name },
    'body.newPassword',
  );
  if (issues.length) throw new ValidationError(issues);

  await UserModel.updateOne(
    { _id: user._id },
    {
      $set: { passwordHash: await hashPassword(input.newPassword), passwordChangedAt: new Date() },
      $inc: { tokenVersion: 1 },
    },
  );
  // full access: every owner session ends (the login-as session is not one of them)
  await revokeAllForUser(
    user._id,
    'password_changed',
    full ? {} : { exceptFamilyId: auth.sessionId },
  );
  await sendPasswordChangedEmail(user);
  await auditRequest(req, 'auth.password_changed');
  if (full) return fullAccessSessionAfterChange(auth, user._id);
  return sessionFor(await loadSessionParts(user._id), auth.sessionId ?? '');
};

/**
 * SAC: the password change bumped the owner's token version — the superadmin keeps a login-as
 * token (same session, same end), never a plain owner session.
 */
const fullAccessSessionAfterChange = async (
  auth: ReturnType<typeof requireAuth>,
  userId: UserDoc['_id'],
): Promise<AuthSession> => {
  const parts = await loadSessionParts(userId);
  const end = auth.tokenExpiresAt?.getTime() ?? Date.now() + 60_000;
  const startedAt = auth.impersonationStartedAt ?? new Date();
  const { token, expiresAt } = await accessTokenFor(parts.user, auth.sessionId ?? '', {
    impersonatorId: auth.impersonatorId ?? '',
    ttl: `${Math.max(60, Math.floor((end - Date.now()) / 1000))}s`,
    mode: 'full',
    kind: 'superadmin',
    startedAt,
  });
  return {
    accessToken: token,
    expiresIn: Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 1000)),
    ...buildSessionBody(parts, {
      impersonatorId: auth.impersonatorId ?? '',
      expiresAt: expiresAt.toISOString(),
      mode: 'full',
      kind: 'superadmin',
      returnTo: returnToFor('superadmin', auth.accountId),
      ...fullFacts(startedAt),
    }),
  };
};
