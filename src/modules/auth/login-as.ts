import type { Request } from 'express';

import type { AccountDoc } from '../../db/models/account.model';
import { RoleModel, type RoleDoc } from '../../db/models/role.model';
import { UserModel, type UserDoc } from '../../db/models/user.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { ConflictError, NotFoundError } from '../../shared/errors/app-error';
import type { AuditAction } from '../audit/audit-actions';
import { recordAudit } from '../audit/audit.service';

import { IMPERSONATION_TTL } from './auth.constants';
import { randomToken } from './hmac';
import { accessTokenFor, buildSessionBody, returnToFor, type AuthSession } from './session';

export type LoginAsMode = 'view' | 'act';
export type LoginAsKind = 'superadmin' | 'reseller';

/**
 * Phase 19: one login-as for superadmins (view or act) and resellers (act, own customers
 * only). Token for the account's owner, `imp_…` session, 1 h, no refresh; nested refused;
 * audited in the target account and in the actor's account.
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
    ttl: IMPERSONATION_TTL,
    mode: options.mode,
    kind: options.kind,
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
      },
    ),
  };
};
