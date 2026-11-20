import type { Request } from 'express';

import { getEnv } from '../../config/env';
import type { AccountDoc } from '../../db/models/account.model';
import { RoleModel, type RoleDoc } from '../../db/models/role.model';
import { UserModel, type UserDoc } from '../../db/models/user.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { ConflictError, ForbiddenError, NotFoundError } from '../../shared/errors/app-error';
import type { AuditAction } from '../audit/audit-actions';
import { recordAudit } from '../audit/audit.service';

import {
  IMPERSONATION_FULL_MAX_MS,
  IMPERSONATION_TTL,
  IMPERSONATION_TTL_FULL,
} from './auth.constants';
import { randomToken } from './hmac';
import {
  accessTokenFor,
  buildSessionBody,
  returnToFor,
  type AuthSession,
  type Impersonation,
} from './session';

export type LoginAsMode = 'view' | 'act' | 'full';
export type LoginAsKind = 'superadmin' | 'reseller';

/** SAC: `full` facts for the session body (start + the latest end). */
export const fullFacts = (startedAt: Date): Pick<Impersonation, 'startedAt' | 'maxUntil'> => ({
  startedAt: startedAt.toISOString(),
  maxUntil: new Date(startedAt.getTime() + IMPERSONATION_FULL_MAX_MS).toISOString(),
});

/**
 * Phase 19: one login-as for superadmins (view, act or — SAC — full) and resellers (act, own
 * customers only). Token for the account's owner, `imp_…` session, 30 min (`full`: 4 h,
 * extendable to 12 h), no refresh; nested refused; audited in the target account and in the
 * actor's account.
 */
export const startLoginAs = async (
  req: Request,
  account: AccountDoc,
  options: { mode: LoginAsMode; kind: LoginAsKind; action: AuditAction },
): Promise<AuthSession> => {
  const auth = requireAuth(req);
  if (auth.impersonatorId) {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'Stop the current login-as first.');
  }
  const full = options.mode === 'full';
  // SAC: full access is a superadmin-only mode, and can be switched off for the install
  if (full && (options.kind !== 'superadmin' || !getEnv().LOGIN_AS_FULL_ENABLED)) {
    throw new ForbiddenError();
  }
  // whole seconds: the token keeps the start in seconds, so `/auth/me` reads the same value
  const startedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  const owner = account.ownerId ? await UserModel.findById(account.ownerId).lean<UserDoc>() : null;
  if (!owner || owner.status !== 'active') {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      'This account has no active owner to log in as.',
    );
  }
  const role = await RoleModel.findOne({
    _id: owner.roleId,
    accountId: account._id,
  }).lean<RoleDoc>();
  if (!role) throw new NotFoundError();
  const { token, expiresAt } = await accessTokenFor(owner, `imp_${randomToken(9)}`, {
    impersonatorId: auth.userId,
    ttl: full ? IMPERSONATION_TTL_FULL : IMPERSONATION_TTL,
    mode: options.mode,
    kind: options.kind,
    ...(full ? { startedAt } : {}),
  });
  const meta = {
    ownerId: owner._id.toString(),
    expiresAt: expiresAt.toISOString(),
    mode: options.mode,
    ...(options.kind === 'reseller' ? { customerId: account._id.toString() } : {}),
  };
  const base = {
    actor: {
      type: 'user' as const,
      id: auth.userId ?? null,
      ...(options.kind === 'superadmin' ? { platform: true } : {}),
    },
    action: options.action,
    target: { type: 'account', id: account._id.toString() },
    meta,
    ip: req.ip ?? null,
  };
  await recordAudit({ ...base, accountId: account._id });
  await recordAudit({ ...base, accountId: auth.accountId });
  return {
    accessToken: token,
    expiresIn: Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 1000)),
    ...buildSessionBody(
      { user: owner, role, account },
      {
        impersonatorId: auth.userId ?? '',
        expiresAt: expiresAt.toISOString(),
        mode: options.mode,
        kind: options.kind,
        returnTo: returnToFor(options.kind, account._id.toString()),
        ...(full ? { ...fullFacts(startedAt), ringMeToo: false } : {}),
      },
    ),
  };
};
