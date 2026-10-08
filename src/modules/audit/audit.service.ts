import type { Request } from 'express';
import { Types } from 'mongoose';

import { AuditLogModel, type AuditActor } from '../../db/models/audit-log.model';
import { getLogger } from '../../shared/logger';
import { maskEmail } from '../../shared/utils/mask';

import type { AuditAction } from './audit-actions';

export interface AuditActorInput {
  type: AuditActor['type'];
  id?: string | Types.ObjectId | null;
  impersonatorId?: string | Types.ObjectId | null;
  platform?: boolean;
}

export interface AuditInput {
  accountId: string | Types.ObjectId;
  actor: AuditActorInput;
  action: AuditAction;
  target?: { type: string; id?: string | null } | null;
  meta?: Record<string, unknown> | null;
  ip?: string | null;
}

const SECRET_KEY = /pass|token|secret|code|otp|cookie|authorization|hash/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Drops secret-looking keys and masks e-mail values (data.md §9). */
export const sanitizeMeta = (meta: unknown, depth = 0): unknown => {
  if (meta === null || meta === undefined) return meta;
  if (typeof meta === 'string') return EMAIL.test(meta) ? maskEmail(meta) : meta.slice(0, 500);
  if (typeof meta !== 'object' || depth > 3) return meta;
  if (Array.isArray(meta)) return meta.slice(0, 50).map((v) => sanitizeMeta(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = sanitizeMeta(value, depth + 1);
  }
  return out;
};

const oid = (v: string | Types.ObjectId | null | undefined) =>
  v ? (typeof v === 'string' ? new Types.ObjectId(v) : v) : null;

/**
 * Writes an audit entry. Never throws into the caller — a failed audit
 * write is logged, the request continues (catalogue: docs/conventions/audit.md).
 */
export const recordAudit = async (input: AuditInput): Promise<void> => {
  try {
    await AuditLogModel.create({
      accountId:
        typeof input.accountId === 'string' ? new Types.ObjectId(input.accountId) : input.accountId,
      actor: {
        type: input.actor.type,
        id: oid(input.actor.id),
        impersonatorId: oid(input.actor.impersonatorId),
        platform: input.actor.platform ?? false,
      },
      action: input.action,
      target: input.target ?? null,
      meta: input.meta ? (sanitizeMeta(input.meta) as Record<string, unknown>) : null,
      ip: input.ip ?? null,
      at: new Date(),
    });
  } catch (err) {
    getLogger().error({ err, action: input.action }, 'audit: write failed');
  }
};

/** Actor + ip from an authenticated request (user, API key or impersonation). */
export const actorFromRequest = (req: Request): AuditActorInput => {
  const auth = req.auth;
  if (!auth) return { type: 'system' };
  if (auth.kind === 'api_key') return { type: 'api_key', id: auth.apiKeyId ?? null };
  return { type: 'user', id: auth.userId ?? null, impersonatorId: auth.impersonatorId ?? null };
};

/** Audit for the caller's own account. */
export const auditRequest = (
  req: Request,
  action: AuditAction,
  extra: { target?: AuditInput['target']; meta?: AuditInput['meta']; accountId?: string } = {},
): Promise<void> =>
  recordAudit({
    accountId: extra.accountId ?? req.auth?.accountId ?? '',
    actor: actorFromRequest(req),
    action,
    target: extra.target,
    meta: extra.meta,
    ip: req.ip ?? null,
  });
