import type { Request } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';

import { notifyAccount, notifyUser } from '../../core/realtime/notify';
import {
  AccountModel,
  DEFAULT_SIP_SETTINGS,
  type AccountDoc,
  type AccountSipSettings,
  type AccountVoiceLine,
} from '../../db/models/account.model';
import { AuditLogModel, type AuditLogDoc } from '../../db/models/audit-log.model';
import {
  ACTIVE_CAMPAIGN_STATUSES,
  CampaignModel,
  type CampaignDoc,
} from '../../db/models/campaign.model';
import {
  PlatformSettingsModel,
  platformSettingProblems,
  type SignupSettings,
} from '../../db/models/platform-settings.model';
import { UserModel, type UserDoc } from '../../db/models/user.model';
import { WalletModel } from '../../db/models/wallet.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { toObjectId } from '../../shared/auth/tenant';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';
import { createAccountWithOwner } from '../account/create';
import { findReseller, getSignupSettings, kindOf } from '../account/kinds';
import type { AuditAction } from '../audit/audit-actions';
import { recordAudit } from '../audit/audit.service';
import { startLoginAs, type LoginAsMode } from '../auth/login-as';
import { hashPassword, validatePasswordPolicy } from '../auth/password';
import { revokeAllForUser } from '../auth/refresh.service';
import { toPublicAccount, toPublicUser, type AuthSession } from '../auth/session';
import { resumeCampaignDoc } from '../campaigns/campaigns.service';
import { pauseAccountCampaigns } from '../campaigns/jobs';
import { notify, usersWithPermission } from '../notifications/notifications.service';
import { cancelDeletion } from '../privacy/account-delete.service';
import { purgeAccount, type PurgeDeps } from '../privacy/account-purge.job';
import {
  assertRetentionCap,
  retentionViewOf,
  type RetentionView,
} from '../retention/retention.service';
import { voiceSettingsOf } from '../voice-api/voice-api.service';
import { accountWhatsApp } from '../whatsapp/whatsapp-admin.service';

import type { AccountLimitsBody, CreateAccountBody, ListAccountsQuery } from './admin.schema';

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const findCustomerAccount = async (id: string): Promise<AccountDoc> => {
  const _id = toObjectId(id);
  if (!_id) throw new NotFoundError();
  const account = await AccountModel.findById(_id).lean<AccountDoc>();
  if (!account) throw new NotFoundError();
  if (account.isPlatform) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      'The platform account cannot be managed here.',
    );
  }
  return account;
};

/** Audits a superadmin action in the target account AND in the platform account. */
const auditBothSides = async (
  req: Request,
  account: AccountDoc,
  action: AuditAction,
  meta?: Record<string, unknown>,
) => {
  const auth = requireAuth(req);
  const base = {
    actor: { type: 'user' as const, id: auth.userId ?? null, platform: true },
    action,
    target: { type: 'account', id: account._id.toString() },
    meta: meta ?? null,
    ip: req.ip ?? null,
  };
  await recordAudit({ ...base, accountId: account._id });
  await recordAudit({ ...base, accountId: auth.accountId });
};

/**
 * Superadmin: a customer account with its roles, wallet and an invited owner. Nobody
 * but the owner knows the password — it is set from the e-mailed invitation.
 */
export const createAccount = async (req: Request, body: z.infer<typeof CreateAccountBody>) => {
  const kind = body.kind ?? 'business';
  let parent: AccountDoc | null = null;
  if (body.parentAccountId) {
    if (kind !== 'business') {
      throw new ValidationError([
        { path: 'body.parentAccountId', message: 'Only a business can belong to a reseller' },
      ]);
    }
    parent = await findReseller(body.parentAccountId);
    if (!parent) {
      throw new ValidationError([{ path: 'body.parentAccountId', message: 'Not a reseller' }]);
    }
  }
  const made = await createAccountWithOwner({
    businessName: body.businessName,
    ownerName: body.ownerName,
    ownerEmail: body.ownerEmail,
    ownerPassword: body.ownerPassword,
    ownerPhone: body.ownerPhone,
    timezone: body.timezone,
    kind,
    parentAccountId: parent?._id ?? null,
  });
  await auditBothSides(req, made.account, 'account.created', {
    kind,
    ...(parent ? { parentAccountId: parent._id.toString() } : {}),
  });
  return toPublicAccount(made.account);
};

/**
 * Sets the owner's password. Their sessions end at once. An owner invited earlier becomes active,
 * and the old invitation link stops working.
 */
export const setOwnerPassword = async (
  req: Request,
  id: string,
  password: string,
): Promise<void> => {
  const account = await findCustomerAccount(id);
  const owner = account.ownerId ? await UserModel.findById(account.ownerId).lean<UserDoc>() : null;
  if (!owner) throw new ConflictError('CONFLICT_INVALID_STATE', 'This account has no owner.');
  const issues = validatePasswordPolicy(
    password,
    { email: owner.email, name: owner.name },
    'body.password',
  );
  if (issues.length) throw new ValidationError(issues);
  const now = new Date();
  await UserModel.updateOne(
    { _id: owner._id },
    {
      $set: {
        passwordHash: await hashPassword(password),
        passwordChangedAt: now,
        ...(owner.status === 'invited'
          ? { status: 'active', emailVerifiedAt: owner.emailVerifiedAt ?? now }
          : {}),
      },
      $inc: { tokenVersion: 1 },
      ...(owner.status === 'invited' ? { $unset: { invite: '' } } : {}),
    },
  );
  await revokeAllForUser(owner._id, 'password_changed');
  notifyUser(
    account._id.toString(),
    owner._id.toString(),
    'session.revoked',
    { reason: 'password_changed' },
    { close: true },
  );
  await auditBothSides(req, account, 'auth.password_reset');
};

export const listAccounts = async (query: z.infer<typeof ListAccountsQuery>) => {
  const filter: Record<string, unknown> = { isPlatform: { $ne: true } };
  if (query.status) filter.status = query.status;
  // Phase 19: kind (old rows without `kind` are businesses) and one reseller's customers
  if (query.kind === 'reseller') filter.kind = 'reseller';
  if (query.kind === 'business') filter.kind = { $in: ['business', null] };
  if (query.parentAccountId) filter.parentAccountId = new Types.ObjectId(query.parentAccountId);
  if (query.search) {
    const re = new RegExp(escapeRegex(query.search), 'i');
    const owners = await UserModel.find({ email: re }).select({ _id: 1 }).limit(200).lean();
    filter.$or = [{ name: re }, { slug: re }, { ownerId: { $in: owners.map((o) => o._id) } }];
  }
  const [accounts, total] = await Promise.all([
    AccountModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean<AccountDoc[]>(),
    AccountModel.countDocuments(filter),
  ]);
  const ids = accounts.map((a) => a._id);
  const parentIds = accounts.flatMap((a) => (a.parentAccountId ? [a.parentAccountId] : []));
  const resellerIds = accounts.filter((a) => kindOf(a) === 'reseller').map((a) => a._id);
  const [parents, customerCounts] = await Promise.all([
    AccountModel.find({ _id: { $in: parentIds } })
      .select({ name: 1 })
      .lean<{ _id: Types.ObjectId; name: string }[]>(),
    AccountModel.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { parentAccountId: { $in: resellerIds } } },
      { $group: { _id: '$parentAccountId', n: { $sum: 1 } } },
    ]),
  ]);
  const parentName = new Map(parents.map((p) => [p._id.toString(), p.name]));
  const customersOf = new Map(customerCounts.map((c) => [c._id.toString(), c.n]));
  const [owners, counts] = await Promise.all([
    UserModel.find({
      _id: { $in: accounts.flatMap((a) => (a.ownerId ? [a.ownerId] : [])) },
    })
      .select({ email: 1 })
      .lean<{ _id: Types.ObjectId; email: string }[]>(),
    UserModel.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { accountId: { $in: ids } } },
      { $group: { _id: '$accountId', n: { $sum: 1 } } },
    ]),
  ]);
  const ownerEmail = new Map(owners.map((o) => [o._id.toString(), o.email]));
  const userCount = new Map(counts.map((c) => [c._id.toString(), c.n]));
  return {
    items: accounts.map((a) => ({
      id: a._id.toString(),
      name: a.name,
      slug: a.slug,
      status: a.status,
      ownerEmail: a.ownerId ? (ownerEmail.get(a.ownerId.toString()) ?? null) : null,
      usersCount: userCount.get(a._id.toString()) ?? 0,
      kind: kindOf(a),
      parent: a.parentAccountId
        ? {
            id: a.parentAccountId.toString(),
            name: parentName.get(a.parentAccountId.toString()) ?? '',
          }
        : null,
      customersCount: kindOf(a) === 'reseller' ? (customersOf.get(a._id.toString()) ?? 0) : null,
      resellerStatus: kindOf(a) === 'reseller' ? (a.reseller?.status ?? 'active') : null,
      createdAt: a.createdAt.toISOString(),
    })),
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
};

/** Campaigns paused by the platform team, listed on the account detail (newest first). */
const ADMIN_PAUSED_LIST_MAX = 100;

export const accountDetail = async (id: string) => {
  const account = await findCustomerAccount(id);
  const [owner, byStatus, recent, activeCampaigns, adminPaused] = await Promise.all([
    account.ownerId ? UserModel.findById(account.ownerId).lean<UserDoc>() : null,
    UserModel.aggregate<{ _id: UserDoc['status']; n: number }>([
      { $match: { accountId: account._id } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    AuditLogModel.find({ accountId: account._id })
      .sort({ at: -1, _id: -1 })
      .limit(20)
      .lean<AuditLogDoc[]>(),
    CampaignModel.countDocuments({
      accountId: account._id,
      parentId: null,
      status: { $in: ACTIVE_CAMPAIGN_STATUSES },
    }),
    // runs of a repeating campaign pause too, so no parentId filter here
    CampaignModel.find(
      { accountId: account._id, status: 'paused', pauseReason: 'admin', deletedAt: null },
      { name: 1 },
    )
      .sort({ _id: -1 })
      .limit(ADMIN_PAUSED_LIST_MAX)
      .lean<Pick<CampaignDoc, '_id' | 'name'>[]>(),
  ]);
  const usersByStatus = { invited: 0, active: 0, disabled: 0 };
  for (const s of byStatus) usersByStatus[s._id] = s.n;
  return {
    account: toPublicAccount(account),
    apiLimits: account.apiLimits ?? null,
    voiceLine: account.voiceLine ?? 'dryrun',
    sipSettings: { ...DEFAULT_SIP_SETTINGS, ...account.sipSettings },
    voiceApi: voiceSettingsOf(account),
    owner: owner ? toPublicUser(owner) : null,
    usersCount: usersByStatus.invited + usersByStatus.active + usersByStatus.disabled,
    usersByStatus,
    limits: {
      maxConcurrentCalls: account.limits.maxConcurrentCalls,
      dialsPerMinute: account.limits.dialsPerMinute,
    },
    activeCampaigns,
    retention: retentionViewOf(account),
    adminPausedCampaigns: adminPaused.map((c) => ({ id: c._id.toString(), name: c.name })),
    ...(await accountWhatsApp(account._id)),
    recentAudit: recent.map((r) => ({
      id: r._id.toString(),
      action: r.action,
      actor: {
        type: r.actor.type,
        id: r.actor.id ? r.actor.id.toString() : null,
        name: null,
        impersonatorId: r.actor.impersonatorId ? r.actor.impersonatorId.toString() : null,
        platform: r.actor.platform ?? false,
      },
      target: r.target ? { type: r.target.type, id: r.target.id ?? null } : null,
      meta: r.meta ?? null,
      ip: r.ip ?? null,
      at: r.at.toISOString(),
    })),
  };
};

export const suspendAccount = async (req: Request, id: string, reason: string) => {
  const account = await findCustomerAccount(id);
  if (account.status === 'suspended') {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'The account is already suspended.');
  }
  const updated = await AccountModel.findByIdAndUpdate(
    account._id,
    { $set: { status: 'suspended', suspendedAt: new Date(), suspendReason: reason } },
    { returnDocument: 'after' },
  ).lean<AccountDoc>();
  if (!updated) throw new NotFoundError();
  await auditBothSides(req, updated, 'account.suspended', { reason });
  notifyAccount(updated._id.toString(), 'account.suspended', { reason });
  // campaigns stop dialing (enabling the account later does not resume them)
  await pauseAccountCampaigns(updated._id, 'account_suspended');
  return toPublicAccount(updated);
};

export const enableAccount = async (req: Request, id: string) => {
  const account = await findCustomerAccount(id);
  if (account.status === 'active') {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'The account is already active.');
  }
  const updated = await AccountModel.findByIdAndUpdate(
    account._id,
    { $set: { status: 'active', suspendedAt: null, suspendReason: null } },
    { returnDocument: 'after' },
  ).lean<AccountDoc>();
  if (!updated) throw new NotFoundError();
  await auditBothSides(req, updated, 'account.enabled');
  notifyAccount(updated._id.toString(), 'account.enabled', {});
  return toPublicAccount(updated);
};

/** Dialing limits (Phase 8): concurrent calls (web test calls count) and dials per minute. */
export const setAccountLimits = async (
  req: Request,
  id: string,
  body: z.infer<typeof AccountLimitsBody>,
) => {
  const account = await findCustomerAccount(id);
  const fields = (['maxConcurrentCalls', 'dialsPerMinute'] as const).filter(
    (k) => body[k] !== undefined,
  );
  const updated = await AccountModel.findByIdAndUpdate(
    account._id,
    { $set: Object.fromEntries(fields.map((k) => [`limits.${k}`, body[k]])) },
    { returnDocument: 'after' },
  ).lean<AccountDoc>();
  if (!updated) throw new NotFoundError();
  await auditBothSides(req, updated, 'account.limits_updated', { fields });
  return {
    maxConcurrentCalls: updated.limits.maxConcurrentCalls,
    dialsPerMinute: updated.limits.dialsPerMinute,
  };
};

/**
 * Superadmin cap on how long an account keeps data (Phase 14): lowers the account's
 * maximum; settings above it are clamped by the purge jobs (the account sees both).
 */
export const setRetentionCap = async (
  req: Request,
  id: string,
  cap: { callsDays: number | null; inboxDays: number | null },
): Promise<RetentionView> => {
  const account = await findCustomerAccount(id);
  assertRetentionCap(cap);
  const before = { callsDays: null, inboxDays: null, ...(account.retentionCap ?? {}) };
  await AccountModel.updateOne({ _id: account._id }, { $set: { retentionCap: cap } });
  await auditBothSides(req, account, 'account.retention_cap_updated', { from: before, to: cap });
  return retentionViewOf({ retention: account.retention ?? null, retentionCap: cap });
};

/** Emergency stop: every scheduled / running campaign pauses with reason `admin`. */
export const pauseAllCampaigns = async (req: Request, id: string) => {
  const account = await findCustomerAccount(id);
  const paused = await pauseAccountCampaigns(account._id, 'admin');
  await auditBothSides(req, account, 'campaign.admin_paused', { campaigns: paused });
  return { paused };
};

/** Only a superadmin lifts an `admin` pause (the account's own users get 409). */
export const resumeAdminPaused = async (req: Request, id: string, campaignId: string) => {
  const account = await findCustomerAccount(id);
  const _id = toObjectId(campaignId);
  const campaign = _id
    ? await CampaignModel.findOne({
        _id,
        accountId: account._id,
        deletedAt: null,
      }).lean<CampaignDoc>()
    : null;
  if (!campaign) throw new NotFoundError();
  if (campaign.status !== 'paused' || campaign.pauseReason !== 'admin') {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      'Only a campaign paused by the platform team is resumed here.',
    );
  }
  const resumed = await resumeCampaignDoc(campaign, null);
  await auditBothSides(req, account, 'campaign.resumed', {
    campaignId: campaign._id.toString(),
    auto: false,
    admin: true,
  });
  return { id: resumed._id.toString(), status: resumed.status };
};

/**
 * Superadmin → 30-minute access token of the account owner with the `imp`
 * claim. No refresh token: when it expires the impersonation ends.
 */
export const impersonate = async (
  req: Request,
  id: string,
  mode: LoginAsMode = 'view',
): Promise<AuthSession> =>
  startLoginAs(req, await findCustomerAccount(id), {
    mode,
    kind: 'superadmin',
    action: 'admin.impersonation_started',
  });

export const stopImpersonation = async (req: Request): Promise<void> => {
  const auth = requireAuth(req);
  if (!auth.impersonatorId) {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'Not an impersonation session.');
  }
  const impersonator = await UserModel.findById(auth.impersonatorId).lean<UserDoc>();
  const account = await AccountModel.findById(auth.accountId).lean<AccountDoc>();
  if (!account) throw new NotFoundError();
  const reseller = auth.impersonatorKind === 'reseller';
  const actor = {
    type: 'user' as const,
    id: auth.impersonatorId,
    ...(reseller ? {} : { platform: true }),
  };
  const entry = {
    actor,
    action: reseller
      ? ('reseller.login_as_stopped' as const)
      : ('admin.impersonation_stopped' as const),
    ...(reseller ? { meta: { customerId: auth.accountId } } : {}),
    target: { type: 'account', id: auth.accountId },
    ip: req.ip ?? null,
  };
  await recordAudit({ ...entry, accountId: account._id });
  if (impersonator) await recordAudit({ ...entry, accountId: impersonator.accountId });
};

const DELETION_LIST_MAX = 100;

/** Accounts waiting for deletion, with what is left in the wallet (handled by hand). */
export const listAccountDeletions = async () => {
  const accounts = await AccountModel.find({
    'deletion.status': { $in: ['scheduled', 'purging'] },
  })
    .sort({ 'deletion.scheduledFor': 1 })
    .limit(DELETION_LIST_MAX)
    .lean<AccountDoc[]>();
  const wallets = await WalletModel.find({ accountId: { $in: accounts.map((a) => a._id) } })
    .select({ accountId: 1, balanceMicros: 1 })
    .lean<{ accountId: Types.ObjectId; balanceMicros: number }[]>();
  const balance = new Map(wallets.map((w) => [w.accountId.toString(), w.balanceMicros]));
  return accounts.map((a) => ({
    id: a._id.toString(),
    name: a.name,
    status: a.deletion?.status ?? 'scheduled',
    requestedAt: a.deletion?.requestedAt.toISOString() ?? null,
    scheduledFor: a.deletion?.scheduledFor.toISOString() ?? null,
    balanceMicros: balance.get(a._id.toString()) ?? 0,
  }));
};

export const adminCancelDeletion = async (req: Request, id: string) => {
  const account = await findCustomerAccount(id);
  await cancelDeletion(account._id);
  await auditBothSides(req, account, 'account.delete_canceled');
  return { canceled: true as const };
};

/** Runs the purge now, only after the grace has passed. */
export const adminRunDeletion = async (req: Request, id: string, deps: PurgeDeps) => {
  const account = await findCustomerAccount(id);
  const due = account.deletion?.scheduledFor;
  if (account.deletion?.status === 'purged' || !due || due.getTime() > Date.now()) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      'This account can only be deleted after its waiting period.',
    );
  }
  await auditBothSides(req, account, 'account.purged', { byAdmin: true });
  return purgeAccount(account._id, deps);
};

/** Phase 18: the line its campaigns and single calls use (takes effect for new calls). */
export const setAccountVoiceLine = async (
  req: Request,
  id: string,
  voiceLine: AccountVoiceLine,
) => {
  const account = await findCustomerAccount(id);
  const from = account.voiceLine ?? 'dryrun';
  await AccountModel.updateOne({ _id: account._id }, { $set: { voiceLine } });
  if (from !== voiceLine) {
    await auditBothSides(req, account, 'account.voice_line_changed', { from, to: voiceLine });
  }
  return { voiceLine };
};

export const setAccountSipSettings = async (
  req: Request,
  id: string,
  sipSettings: AccountSipSettings,
) => {
  const account = await findCustomerAccount(id);
  await AccountModel.updateOne({ _id: account._id }, { $set: { sipSettings } });
  await auditBothSides(req, account, 'account.sip_settings_changed', { ...sipSettings });
  return sipSettings;
};

export const setAccountApiLimits = async (
  req: Request,
  id: string,
  apiLimits: { readsPerMinute: number; writesPerMinute: number } | null,
) => {
  const account = await findCustomerAccount(id);
  await AccountModel.updateOne({ _id: account._id }, { $set: { apiLimits } });
  await auditBothSides(req, account, 'account.api_limits_changed', apiLimits ?? { reset: true });
  return { apiLimits };
};

/** Phase 19: move a business under a reseller, to another one, or back to direct (`null`). */
export const setAccountReseller = async (
  req: Request,
  id: string,
  parentAccountId: string | null,
) => {
  const account = await findCustomerAccount(id);
  if (kindOf(account) !== 'business') {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'Only a business can belong to a reseller.');
  }
  let parent: AccountDoc | null = null;
  if (parentAccountId) {
    parent = await findReseller(parentAccountId);
    if (!parent)
      throw new ValidationError([{ path: 'body.parentAccountId', message: 'Not a reseller' }]);
  }
  const from = account.parentAccountId ? account.parentAccountId.toString() : null;
  const updated = await AccountModel.findByIdAndUpdate(
    account._id,
    { $set: { parentAccountId: parent?._id ?? null } },
    { returnDocument: 'after' },
  ).lean<AccountDoc>();
  if (!updated) throw new NotFoundError();
  await auditBothSides(req, updated, 'account.reseller_changed', {
    from,
    to: parent ? parent._id.toString() : null,
  });
  return toPublicAccount(updated);
};

/** Phase 19: a reseller that signed up while approval was on may now add customers. */
export const approveReseller = async (req: Request, id: string) => {
  const account = await findCustomerAccount(id);
  if (kindOf(account) !== 'reseller') {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'This account is not a reseller.');
  }
  if (account.reseller?.status === 'active') {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'The reseller is already approved.');
  }
  const auth = requireAuth(req);
  const updated = await AccountModel.findByIdAndUpdate(
    account._id,
    {
      $set: {
        'reseller.status': 'active',
        'reseller.approvedAt': new Date(),
        'reseller.approvedBy': auth.userId ? new Types.ObjectId(auth.userId) : null,
      },
    },
    { returnDocument: 'after' },
  ).lean<AccountDoc>();
  if (!updated) throw new NotFoundError();
  await auditBothSides(req, updated, 'reseller.approved');
  try {
    const users = await usersWithPermission(updated._id, 'reseller.manage');
    if (users.length) {
      await notify({
        accountId: updated._id,
        userIds: users.map((u) => u.userId),
        type: 'reseller.approved',
        title: 'Your reseller account is approved',
        body: 'You can now add customers and give them credit.',
        link: '/reseller/customers',
      });
    }
  } catch (err) {
    getLogger().error({ err }, 'admin: reseller approved bell failed');
  }
  return toPublicAccount(updated);
};

/** Phase 19: suspends every active customer of a reseller (each one audited as usual). */
export const suspendResellerCustomers = async (req: Request, id: string, reason: string) => {
  const account = await findCustomerAccount(id);
  if (kindOf(account) !== 'reseller') {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'This account is not a reseller.');
  }
  const customers = await AccountModel.find({ parentAccountId: account._id, status: 'active' })
    .select({ _id: 1 })
    .lean<{ _id: Types.ObjectId }[]>();
  for (const c of customers) await suspendAccount(req, c._id.toString(), reason);
  return { suspended: customers.length };
};

export const readSignupSettings = () => getSignupSettings();

export const writeSignupSettings = async (req: Request, value: SignupSettings) => {
  const problems = platformSettingProblems('signup', value);
  if (problems.length)
    throw new ValidationError(problems.map((message) => ({ path: 'body', message })));
  const auth = requireAuth(req);
  await PlatformSettingsModel.updateOne(
    { key: 'signup' },
    { $set: { value, updatedBy: auth.userId ? new Types.ObjectId(auth.userId) : null } },
    { upsert: true },
  );
  await recordAudit({
    accountId: auth.accountId,
    actor: { type: 'user', id: auth.userId ?? null, platform: true },
    action: 'platform.signup_settings_updated',
    target: { type: 'platform_setting', id: 'signup' },
    meta: { open: value.open, resellerSignup: value.resellerSignup },
    ip: req.ip ?? null,
  });
  return getSignupSettings();
};
