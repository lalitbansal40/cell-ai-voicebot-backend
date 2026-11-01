import type { Request } from 'express';
import { Types } from 'mongoose';

import { getEnv } from '../../config/env';
import { getEmail } from '../../core/email';
import { AccountModel, type AccountDoc } from '../../db/models/account.model';
import { ApiKeyModel } from '../../db/models/api-key.model';
import { UserModel } from '../../db/models/user.model';
import { WalletModel } from '../../db/models/wallet.model';
import { WebhookEndpointModel } from '../../db/models/webhook-endpoint.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { AppError, ConflictError, ValidationError } from '../../shared/errors/app-error';
import { auditRequest } from '../audit/audit.service';
import { pauseAccountCampaigns } from '../campaigns/jobs';
import { notify } from '../notifications/notifications.service';

import { assertPassword } from './account-export.service';

export const ACCOUNT_DELETE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const SETTINGS_LINK = '/settings/account';

const ownerEmail = async (accountId: Types.ObjectId, userId: Types.ObjectId | null) => {
  const user = userId
    ? await UserModel.findOne({ _id: userId, accountId })
        .select({ email: 1 })
        .lean<{ email: string }>()
    : null;
  return user?.email ?? null;
};

export const assertNoHold = async (accountId: Types.ObjectId): Promise<void> => {
  const wallet = await WalletModel.findOne({ accountId }).select({ holdMicros: 1 }).lean<{
    holdMicros?: number;
  }>();
  if ((wallet?.holdMicros ?? 0) > 0) throw new AppError('ACCOUNT_DELETE_BLOCKED');
};

/**
 * Schedules the purge. From now on nothing starts by itself: campaigns pause, API keys are
 * revoked and webhooks stop. Numbers stay connected until the purge. Revoked keys stay revoked
 * if the owner cancels.
 */
export const scheduleAccountDelete = async (
  req: Request,
  body: { password: string; confirmName: string },
) => {
  await assertPassword(req, body.password);
  const auth = requireAuth(req);
  const accountId = new Types.ObjectId(auth.accountId);
  const account = await AccountModel.findById(accountId).lean<AccountDoc>();
  if (!account) throw new ConflictError('CONFLICT_INVALID_STATE', 'This account is gone.');
  if (body.confirmName.trim() !== account.name) {
    throw new ValidationError([
      { path: 'body.confirmName', message: 'Type the account name exactly' },
    ]);
  }
  if (account.deletion) {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'This account is already being deleted.');
  }
  await assertNoHold(accountId);
  const now = new Date();
  const scheduledFor = new Date(now.getTime() + ACCOUNT_DELETE_GRACE_MS);
  const webhooks = await WebhookEndpointModel.find({ accountId, active: true })
    .select({ _id: 1 })
    .lean<{ _id: Types.ObjectId }[]>();
  await AccountModel.updateOne(
    { _id: accountId },
    {
      $set: {
        deletion: {
          status: 'scheduled',
          requestedAt: now,
          requestedBy: new Types.ObjectId(auth.userId),
          scheduledFor,
          purgedAt: null,
          pausedWebhookIds: webhooks.map((w) => w._id),
        },
      },
    },
  );
  await pauseAccountCampaigns(accountId, 'account_suspended');
  await ApiKeyModel.updateMany({ accountId, revokedAt: null }, { $set: { revokedAt: now } });
  await WebhookEndpointModel.updateMany({ accountId, active: true }, { $set: { active: false } });
  await auditRequest(req, 'account.delete_requested', {
    target: { type: 'account', id: accountId.toString() },
    meta: { scheduledFor: scheduledFor.toISOString() },
  });
  await notify({
    accountId,
    userIds: [new Types.ObjectId(auth.userId)],
    type: 'account.delete_scheduled',
    title: 'Your account will be deleted',
    body: `It will be deleted on ${scheduledFor.toDateString()}. You can cancel until then.`,
    link: SETTINGS_LINK,
  });
  const email = await ownerEmail(accountId, new Types.ObjectId(auth.userId));
  if (email) {
    await getEmail().enqueue('account.delete_scheduled', email, {
      accountName: account.name,
      scheduledFor: scheduledFor.toDateString(),
      url: `${getEnv().FRONTEND_URL}${SETTINGS_LINK}`,
    });
  }
  return { status: 'scheduled' as const, scheduledFor: scheduledFor.toISOString() };
};

/** Webhooks come back; keys stay revoked; paused campaigns wait for someone to resume them. */
export const cancelDeletion = async (accountId: Types.ObjectId): Promise<AccountDoc> => {
  const account = await AccountModel.findOneAndUpdate(
    { _id: accountId, 'deletion.status': 'scheduled' },
    { $set: { deletion: null } },
  ).lean<AccountDoc>();
  if (!account?.deletion) {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'This account is not waiting to be deleted.');
  }
  await WebhookEndpointModel.updateMany(
    { accountId, _id: { $in: account.deletion.pausedWebhookIds ?? [] } },
    { $set: { active: true } },
  );
  const email = await ownerEmail(accountId, account.deletion.requestedBy);
  if (email) {
    await getEmail().enqueue('account.delete_canceled', email, {
      accountName: account.name,
      url: `${getEnv().FRONTEND_URL}${SETTINGS_LINK}`,
    });
  }
  return account;
};

export const cancelAccountDelete = async (req: Request): Promise<{ canceled: true }> => {
  const accountId = new Types.ObjectId(requireAuth(req).accountId);
  await cancelDeletion(accountId);
  await auditRequest(req, 'account.delete_canceled', {
    target: { type: 'account', id: accountId.toString() },
  });
  return { canceled: true };
};
