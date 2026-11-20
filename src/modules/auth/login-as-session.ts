import type { Request, RequestHandler } from 'express';

import { getEnv } from '../../config/env';
import { getAppRedis } from '../../core/queues/redis';
import { clearRingSession, isRingSession, setRingSession } from '../../core/realtime/ring-sessions';
import { AccountModel, type AccountDoc } from '../../db/models/account.model';
import { RoleModel, type RoleDoc } from '../../db/models/role.model';
import { UserModel, type UserDoc } from '../../db/models/user.model';
import { requireAuth, type AuthContext } from '../../shared/auth/auth-context';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TooManyAttemptsError,
} from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';
import { recordAudit } from '../audit/audit.service';

import {
  IMPERSONATION_FULL_MAX_MS,
  IMPERSONATION_FULL_STEP_MS,
  LOCKOUT_THRESHOLD,
  LOCKOUT_WINDOW_SEC,
  STEP_UP_TTL_SEC,
} from './auth.constants';
import { fullFacts } from './login-as';
import { spendMfaCode } from './mfa.service';
import { verifyPassword } from './password';
import { accessTokenFor, buildSessionBody, returnToFor, type AuthSession } from './session';

/**
 * SAC: the superadmin "Full access" login-as session — extend (4 h steps up to 12 h), step-up
 * (the superadmin's own password + two-step code, good for 5 minutes) for the danger actions,
 * and "Ring me too" (incoming calls of the account also ring this session).
 */

const redis = () => getAppRedis(getEnv().REDIS_URL, getLogger());

const stepUpKey = (sessionId: string) => `auth:stepup:${sessionId}`;
const stepUpFailKey = (impersonatorId: string) => `auth:stepup:fail:${impersonatorId}`;

/** The caller is a superadmin `full` login-as session (else 403). */
const requireFull = (req: Request): AuthContext & { impersonatorId: string; sessionId: string } => {
  const auth = requireAuth(req);
  if (
    !auth.impersonatorId ||
    auth.impersonationMode !== 'full' ||
    auth.impersonatorKind !== 'superadmin' ||
    !auth.sessionId
  ) {
    throw new ForbiddenError();
  }
  return { ...auth, impersonatorId: auth.impersonatorId, sessionId: auth.sessionId };
};

/** `true` while this session holds a step-up. */
export const hasStepUp = async (sessionId: string): Promise<boolean> =>
  (await redis().exists(stepUpKey(sessionId))) === 1;

/** Ring this `full` session too (WhatsApp / phone incoming calls of the account). */
export const isRingMeToo = (sessionId: string): Promise<boolean> =>
  isRingSession(redis(), sessionId);

const audit = async (
  auth: AuthContext & { impersonatorId: string },
  req: Request,
  action:
    | 'auth.login_as_full_extended'
    | 'auth.login_as_step_up'
    | 'auth.login_as_step_up_failed'
    | 'auth.login_as_ring_me_too',
  meta: Record<string, unknown> = {},
) => {
  const impersonator = await UserModel.findById(auth.impersonatorId)
    .select({ accountId: 1 })
    .lean<Pick<UserDoc, 'accountId'>>();
  const entry = {
    actor: { type: 'user' as const, id: auth.impersonatorId, platform: true },
    action,
    target: { type: 'account', id: auth.accountId },
    meta,
    ip: req.ip ?? null,
  };
  await recordAudit({ ...entry, accountId: auth.accountId });
  if (impersonator) await recordAudit({ ...entry, accountId: impersonator.accountId });
};

/**
 * `POST /auth/login-as/extend` — a new token for the same session: 4 more hours, never past
 * 12 hours from the start. Nothing left to give → 409.
 */
export const extendFullLoginAs = async (req: Request, now = new Date()): Promise<AuthSession> => {
  const auth = requireFull(req);
  const startedAt = auth.impersonationStartedAt ?? now;
  const cap = startedAt.getTime() + IMPERSONATION_FULL_MAX_MS;
  const until = Math.min(now.getTime() + IMPERSONATION_FULL_STEP_MS, cap);
  const current = auth.tokenExpiresAt?.getTime() ?? now.getTime();
  if (until <= current + 60_000) {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'Full access can last at most 12 hours.');
  }
  const owner = await UserModel.findById(auth.userId).lean<UserDoc>();
  const account = await AccountModel.findById(auth.accountId).lean<AccountDoc>();
  if (!owner || !account) throw new NotFoundError();
  const role = await RoleModel.findOne({
    _id: owner.roleId,
    accountId: account._id,
  }).lean<RoleDoc>();
  if (!role) throw new NotFoundError();
  const ttlSec = Math.max(60, Math.floor((until - now.getTime()) / 1000));
  const { token, expiresAt } = await accessTokenFor(owner, auth.sessionId, {
    impersonatorId: auth.impersonatorId,
    ttl: `${ttlSec}s`,
    mode: 'full',
    kind: 'superadmin',
    startedAt,
  });
  // the ring flag follows the session's new end
  if (await isRingMeToo(auth.sessionId)) {
    await setRingSession(redis(), {
      accountId: auth.accountId,
      sessionId: auth.sessionId,
      impersonatorId: auth.impersonatorId,
      ttlMs: expiresAt.getTime() - now.getTime(),
    });
  }
  await audit(auth, req, 'auth.login_as_full_extended', { expiresAt: expiresAt.toISOString() });
  return {
    accessToken: token,
    expiresIn: Math.max(0, Math.round((expiresAt.getTime() - now.getTime()) / 1000)),
    ...buildSessionBody(
      { user: owner, role, account },
      {
        impersonatorId: auth.impersonatorId,
        expiresAt: expiresAt.toISOString(),
        mode: 'full',
        kind: 'superadmin',
        returnTo: returnToFor('superadmin', auth.accountId),
        ...fullFacts(startedAt),
        ringMeToo: await isRingMeToo(auth.sessionId),
      },
    ),
  };
};

/**
 * `POST /auth/login-as/step-up` — the superadmin's own password (+ a two-step code when it is
 * on). 5 failures in 15 minutes → 429. Good for `STEP_UP_TTL_SEC` on this session.
 */
export const stepUpLoginAs = async (
  req: Request,
  input: { password: string; code?: string | undefined },
  now = new Date(),
): Promise<{ stepUpUntil: string }> => {
  const auth = requireFull(req);
  const failKey = stepUpFailKey(auth.impersonatorId);
  const [count, ttl] = await Promise.all([redis().get(failKey), redis().ttl(failKey)]);
  if (Number(count ?? 0) >= LOCKOUT_THRESHOLD) {
    throw new TooManyAttemptsError(ttl > 0 ? ttl : LOCKOUT_WINDOW_SEC);
  }
  const fail = async (code: 'REAUTH_FAILED' | 'MFA_INVALID' | 'MFA_REQUIRED') => {
    const n = await redis().incr(failKey);
    if (n === 1) await redis().expire(failKey, LOCKOUT_WINDOW_SEC);
    await audit(auth, req, 'auth.login_as_step_up_failed', { reason: code });
    throw new AppError(code);
  };
  const superadmin = await UserModel.findById(auth.impersonatorId)
    .select('+passwordHash +mfa')
    .lean<UserDoc>();
  if (!superadmin || superadmin.platformRole !== 'superadmin') throw new ForbiddenError();
  if (
    !superadmin.passwordHash ||
    !(await verifyPassword(superadmin.passwordHash, input.password)).ok
  ) {
    return fail('REAUTH_FAILED');
  }
  if (superadmin.mfa?.enabledAt) {
    if (!input.code) return fail('MFA_REQUIRED');
    try {
      await spendMfaCode(superadmin, input.code, now);
    } catch (err) {
      if (err instanceof AppError && err.code === 'MFA_INVALID') return fail('MFA_INVALID');
      throw err;
    }
  }
  await redis().del(failKey);
  await redis().set(stepUpKey(auth.sessionId), '1', 'EX', STEP_UP_TTL_SEC);
  await audit(auth, req, 'auth.login_as_step_up');
  return { stepUpUntil: new Date(now.getTime() + STEP_UP_TTL_SEC * 1000).toISOString() };
};

/** `PUT /auth/login-as/ring-me-too` — on until the session ends, off at once. */
export const setRingMeToo = async (req: Request, on: boolean): Promise<{ ringMeToo: boolean }> => {
  const auth = requireFull(req);
  if (on) {
    await setRingSession(redis(), {
      accountId: auth.accountId,
      sessionId: auth.sessionId,
      impersonatorId: auth.impersonatorId,
      ttlMs: Math.max(60_000, (auth.tokenExpiresAt?.getTime() ?? Date.now()) - Date.now()),
    });
  } else {
    await clearRingSession(redis(), { accountId: auth.accountId, sessionId: auth.sessionId });
  }
  await audit(auth, req, 'auth.login_as_ring_me_too', { on });
  return { ringMeToo: on };
};

/**
 * SAC D2: a danger action inside a `full` login-as needs a fresh step-up (428 `STEP_UP_REQUIRED`).
 * Outside `full` it passes (`view` / `act` are refused by the sensitive guard before this).
 */
export const requireStepUp = (): RequestHandler => async (req, _res, next) => {
  const auth = req.auth;
  if (auth?.impersonatorId && auth.impersonationMode === 'full') {
    if (!auth.sessionId || !(await hasStepUp(auth.sessionId))) {
      throw new AppError('STEP_UP_REQUIRED');
    }
  }
  next();
};
