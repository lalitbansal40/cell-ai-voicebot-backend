import { Types } from 'mongoose';

import type { AuthContext } from './auth-context';

/**
 * SAC: one place to read a login-as session. `view` = read-only, `act` = may work (Phase 19),
 * `full` = a superadmin acting as the owner everywhere (danger actions need a step-up).
 */
export type ImpersonationMode = 'view' | 'act' | 'full';

export interface ImpersonationFacts {
  active: boolean;
  mode: ImpersonationMode | null;
  impersonatorId: string | null;
  kind: 'superadmin' | 'reseller' | null;
}

export const impersonationOf = (auth: AuthContext | undefined): ImpersonationFacts =>
  auth?.impersonatorId
    ? {
        active: true,
        mode: auth.impersonationMode ?? 'view',
        impersonatorId: auth.impersonatorId,
        kind: auth.impersonatorKind ?? 'superadmin',
      }
    : { active: false, mode: null, impersonatorId: null, kind: null };

/** A superadmin `full` login-as session. */
export const isFullAccess = (auth: AuthContext | undefined): boolean =>
  Boolean(auth?.impersonatorId && auth.impersonationMode === 'full');

/** Login-as `view` (read-only). */
export const isViewOnly = (auth: AuthContext | undefined): boolean =>
  Boolean(auth?.impersonatorId && (auth.impersonationMode ?? 'view') === 'view');

/** SAC: the superadmin behind a request (stored next to `createdBy` / `sentBy`), else null. */
export const impersonatorOfReq = (req: {
  auth?: AuthContext | undefined;
}): Types.ObjectId | null =>
  req.auth?.impersonatorId ? new Types.ObjectId(req.auth.impersonatorId) : null;
