import { randomBytes } from 'node:crypto';

import type { Types } from 'mongoose';

import { WHATSAPP_LIMITS } from '../../config/limits';
import { metaAppSecret, parseSignedRequest, SignedRequestInvalid } from '../../core/meta';
import { MetaDeletionRequestModel } from '../../db/models/meta-deletion-request.model';
import {
  WA_ACTIVE_STATUSES,
  WhatsAppChannelModel,
  type WaStatusReason,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { AppError, NotFoundError, ValidationError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';
import { recordAudit } from '../audit/audit.service';

import { markNeedsReconnect, SYSTEM_ACTOR } from './channel-status';
import { nowOf, type WhatsAppContext } from './context';

const DEAUTHORIZED: WaStatusReason = {
  code: 'deauthorized',
  message: 'Access was removed in Facebook — reconnect the number.',
  step: null,
};
const DATA_DELETED: WaStatusReason = {
  code: 'data_deleted',
  message: 'Meta asked us to delete the access data — reconnect the number.',
  step: null,
};

/** `signed_request` → Meta user id (bad signature → 401, anything else → 422). */
const verify = (ctx: WhatsAppContext, signedRequest: unknown): string => {
  if (typeof signedRequest !== 'string' || !signedRequest) {
    throw new ValidationError([{ path: 'signed_request', message: 'Required' }]);
  }
  try {
    return parseSignedRequest(
      signedRequest,
      metaAppSecret(ctx.env),
      Math.floor(nowOf(ctx).getTime() / 1000),
      WHATSAPP_LIMITS.signedRequestMaxAgeSec,
    ).userId;
  } catch (err) {
    if (!(err instanceof SignedRequestInvalid)) throw err;
    getLogger().warn({ reason: err.reason }, 'meta callback: signed_request refused');
    if (err.reason === 'bad_signature') throw new AppError('META_SIGNATURE_INVALID');
    throw new ValidationError([{ path: 'signed_request', message: `Invalid (${err.reason})` }]);
  }
};

/** One system audit per account whose channels were affected. */
const auditAccounts = async (
  channels: WhatsAppChannelDoc[],
  action: 'meta.deauthorized' | 'meta.data_deletion_requested',
  meta: Record<string, unknown>,
) => {
  const byAccount = new Map<string, number>();
  for (const c of channels) {
    byAccount.set(c.accountId.toString(), (byAccount.get(c.accountId.toString()) ?? 0) + 1);
  }
  for (const [accountId, n] of byAccount) {
    await recordAudit({
      accountId,
      actor: SYSTEM_ACTOR,
      action,
      target: null,
      meta: { ...meta, channels: n },
    });
  }
};

/**
 * Meta "Deauthorize callback": the user removed the app in Facebook → that user's
 * active channels need a reconnect.
 */
export const handleDeauthorize = async (
  ctx: WhatsAppContext,
  signedRequest: unknown,
): Promise<{ channels: number }> => {
  const userId = verify(ctx, signedRequest);
  const channels = await WhatsAppChannelModel.find({
    metaUserId: userId,
    status: { $in: WA_ACTIVE_STATUSES },
  }).lean<WhatsAppChannelDoc[]>();
  for (const c of channels) await markNeedsReconnect(ctx, c, DEAUTHORIZED, SYSTEM_ACTOR);
  await auditAccounts(channels, 'meta.deauthorized', {});
  return { channels: channels.length };
};

/**
 * Meta "Data deletion request callback": stores a request with a confirmation code,
 * deletes what we hold from Meta for that user (business tokens + PINs of their
 * channels; active ones → `needs_reconnect`). Business records stay (they belong to
 * the customer's account). Answers Meta's required `{ url, confirmation_code }`.
 */
export const handleDataDeletion = async (
  ctx: WhatsAppContext,
  signedRequest: unknown,
): Promise<{ url: string; confirmation_code: string }> => {
  const userId = verify(ctx, signedRequest);
  const now = nowOf(ctx);
  const code = randomBytes(12).toString('base64url');
  const request = await MetaDeletionRequestModel.create({
    confirmationCode: code,
    metaUserId: userId,
    status: 'received',
    receivedAt: now,
    expiresAt: new Date(now.getTime() + WHATSAPP_LIMITS.deletionStatusTtlDays * 86_400_000),
  });
  const channels = await WhatsAppChannelModel.find({ metaUserId: userId }).lean<
    WhatsAppChannelDoc[]
  >();
  for (const c of channels) {
    if ((WA_ACTIVE_STATUSES as readonly string[]).includes(c.status)) {
      await markNeedsReconnect(ctx, c, DATA_DELETED, SYSTEM_ACTOR);
    }
  }
  await WhatsAppChannelModel.updateMany(
    { metaUserId: userId },
    { $set: { tokenSealed: null, 'registration.pinSealed': null, metaUserId: null } },
  );
  await MetaDeletionRequestModel.updateOne(
    { _id: request._id },
    { $set: { status: 'completed', completedAt: nowOf(ctx), channelsAffected: channels.length } },
  );
  await auditAccounts(channels, 'meta.data_deletion_requested', {
    requestId: request._id.toString(),
  });
  return {
    url: `${ctx.env.FRONTEND_URL.replace(/\/+$/, '')}/data-deletion?code=${code}`,
    confirmation_code: code,
  };
};

/** Public status page data (`/data-deletion?code=`). */
export const deletionStatus = async (code: string) => {
  if (!/^[A-Za-z0-9_-]{16}$/.test(code)) throw new NotFoundError('Unknown confirmation code');
  const request = await MetaDeletionRequestModel.findOne({ confirmationCode: code }).lean<{
    _id: Types.ObjectId;
    status: string;
    receivedAt: Date;
    completedAt: Date | null;
  }>();
  if (!request) throw new NotFoundError('Unknown confirmation code');
  return {
    status: request.status,
    receivedAt: request.receivedAt.toISOString(),
    completedAt: request.completedAt ? request.completedAt.toISOString() : null,
  };
};
