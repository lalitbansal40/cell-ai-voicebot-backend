import { randomUUID } from 'node:crypto';

import type { Request } from 'express';
import { Types } from 'mongoose';

import { getEnv } from '../../config/env';
import { transferCredit } from '../../core/billing/engine';
import { availableMicros } from '../../core/billing/events';
import { getAppRedis } from '../../core/queues/redis';
import { notifyAccount, notifyUser } from '../../core/realtime/notify';
import { AccountModel, type AccountDoc } from '../../db/models/account.model';
import { LedgerEntryModel, type LedgerEntryDoc } from '../../db/models/ledger-entry.model';
import { UserModel, type UserDoc } from '../../db/models/user.model';
import { WalletModel, type WalletDoc } from '../../db/models/wallet.model';
import { requireAuth } from '../../shared/auth/auth-context';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';
import { createAccountWithOwner } from '../account/create';
import { kindOf } from '../account/kinds';
import type { AuditAction } from '../audit/audit-actions';
import { recordAudit } from '../audit/audit.service';
import { startLoginAs } from '../auth/login-as';
import { hashPassword, validatePasswordPolicy } from '../auth/password';
import { revokeAllForUser } from '../auth/refresh.service';
import type { AuthSession } from '../auth/session';
import { pauseAccountCampaigns } from '../campaigns/jobs';
import { notify, usersWithPermission } from '../notifications/notifications.service';

/**
 * Phase 19 reseller panel. This module is the only code that reads accounts by
 * `parentAccountId`; a customer not under the caller's reseller account is always a 404.
 */

/** The caller's account when it is a reseller (else 404 — the panel doesn't exist for it). */
export const callerReseller = async (req: Request): Promise<AccountDoc> => {
  const auth = requireAuth(req);
  const account = await AccountModel.findById(auth.accountId).lean<AccountDoc>();
  if (!account || kindOf(account) !== 'reseller') throw new NotFoundError();
  return account;
};

/** Creating customers and moving credit need an approved reseller. */
export const assertApproved = (reseller: AccountDoc): void => {
  if ((reseller.reseller?.status ?? 'active') !== 'active') {
    throw new AppError('RESELLER_NOT_APPROVED');
  }
};

/** One of this reseller's customers (404 otherwise). */
export const findCustomer = async (reseller: AccountDoc, id: string): Promise<AccountDoc> => {
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError();
  const customer = await AccountModel.findOne({
    _id: new Types.ObjectId(id),
    kind: 'business',
    parentAccountId: reseller._id,
    status: { $ne: 'deleted' },
  }).lean<AccountDoc>();
  if (!customer) throw new NotFoundError();
  return customer;
};

/** `POST /reseller/customers/:id/login-as` — act as the customer's owner (sensitive actions refused). */
export const loginAsCustomer = async (req: Request, customerId: string): Promise<AuthSession> => {
  const reseller = await callerReseller(req);
  assertApproved(reseller);
  const customer = await findCustomer(reseller, customerId);
  return startLoginAs(req, customer, {
    mode: 'act',
    kind: 'reseller',
    action: 'reseller.login_as_started',
  });
};

/** Usage that counts as spend (no top-ups, transfers or adjustments). */
const appRedis = () => getAppRedis(getEnv().REDIS_URL, getLogger());

const SPEND_TYPES = [
  'call_charge',
  'ai_charge',
  'tts_charge',
  'recording_charge',
  'whatsapp_charge',
  'whatsapp_call_charge',
] as const;
const DAY_MS = 86_400_000;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Audits in the customer's account and the reseller's (both sides). */
const auditBoth = async (
  req: Request,
  reseller: AccountDoc,
  customerId: Types.ObjectId,
  action: AuditAction,
  meta: Record<string, unknown> = {},
  target: { type: string; id: string } = { type: 'account', id: customerId.toString() },
) => {
  const auth = requireAuth(req);
  const base = {
    actor: { type: 'user' as const, id: auth.userId ?? null },
    action,
    target,
    meta: { customerId: customerId.toString(), ...meta },
    ip: req.ip ?? null,
  };
  await recordAudit({ ...base, accountId: reseller._id });
  await recordAudit({ ...base, accountId: customerId });
};

const bustSummary = async (resellerId: Types.ObjectId) => {
  try {
    await appRedis().del(`reseller:summary:${resellerId.toString()}`);
  } catch {
    // the cache ages out in 5 minutes anyway
  }
};

type CustomerRow = {
  id: string;
  name: string;
  status: AccountDoc['status'];
  owner: { name: string; email: string } | null;
  wallet: { balanceMicros: number; availableMicros: number };
  spend30dMicros: number;
  lastActiveAt: string | null;
  createdAt: string;
};

/** Wallet, spend (30 d), owner and last sign-in for many customers in 4 queries (no N+1). */
const customerRows = async (customers: AccountDoc[]): Promise<CustomerRow[]> => {
  const ids = customers.map((c) => c._id);
  const since = new Date(Date.now() - 30 * DAY_MS);
  const [wallets, spend, owners, active] = await Promise.all([
    WalletModel.find({ accountId: { $in: ids } }).lean<WalletDoc[]>(),
    LedgerEntryModel.aggregate<{ _id: Types.ObjectId; micros: number }>([
      {
        $match: {
          accountId: { $in: ids },
          type: { $in: [...SPEND_TYPES] },
          status: 'captured',
          createdAt: { $gte: since },
        },
      },
      { $group: { _id: '$accountId', micros: { $sum: '$amountMicros' } } },
    ]),
    UserModel.find({ _id: { $in: customers.flatMap((c) => (c.ownerId ? [c.ownerId] : [])) } })
      .select({ name: 1, email: 1 })
      .lean<Pick<UserDoc, '_id' | 'name' | 'email'>[]>(),
    UserModel.aggregate<{ _id: Types.ObjectId; at: Date | null }>([
      { $match: { accountId: { $in: ids } } },
      { $group: { _id: '$accountId', at: { $max: '$lastLoginAt' } } },
    ]),
  ]);
  const walletOf = new Map(wallets.map((w) => [w.accountId.toString(), w]));
  const spendOf = new Map(spend.map((s) => [s._id.toString(), s.micros]));
  const ownerOf = new Map(owners.map((o) => [o._id.toString(), o]));
  const activeOf = new Map(active.map((a) => [a._id.toString(), a.at]));
  return customers.map((c) => {
    const w = walletOf.get(c._id.toString());
    const o = c.ownerId ? ownerOf.get(c.ownerId.toString()) : undefined;
    return {
      id: c._id.toString(),
      name: c.name,
      status: c.status,
      owner: o ? { name: o.name, email: o.email } : null,
      wallet: {
        balanceMicros: w?.balanceMicros ?? 0,
        availableMicros: w
          ? availableMicros({
              balanceMicros: w.balanceMicros,
              holdMicros: w.holdMicros,
              creditLimitMicros: w.creditLimitMicros,
              lowBalanceThresholdMicros: w.lowBalanceThresholdMicros,
            })
          : 0,
      },
      spend30dMicros: spendOf.get(c._id.toString()) ?? 0,
      lastActiveAt: iso(activeOf.get(c._id.toString())),
      createdAt: c.createdAt.toISOString(),
    };
  });
};

export const listCustomers = async (
  req: Request,
  query: { q?: string; status?: 'active' | 'suspended'; page: number; limit: number },
) => {
  const reseller = await callerReseller(req);
  const filter: Record<string, unknown> = {
    kind: 'business',
    parentAccountId: reseller._id,
    status: query.status ?? { $ne: 'deleted' },
  };
  if (query.q) filter.name = new RegExp(query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const [customers, total] = await Promise.all([
    AccountModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean<AccountDoc[]>(),
    AccountModel.countDocuments(filter),
  ]);
  return {
    data: await customerRows(customers),
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
};

export interface NewCustomerInput {
  businessName: string;
  ownerName: string;
  ownerEmail: string;
  ownerPhone?: string | undefined;
  ownerPassword: string;
  timezone?: string | undefined;
  startingCreditMicros?: number | undefined;
}

/** A customer account under this reseller; optional starting credit from the reseller's wallet. */
export const createCustomer = async (req: Request, body: NewCustomerInput) => {
  const reseller = await callerReseller(req);
  assertApproved(reseller);
  if (body.startingCreditMicros) {
    const w = await WalletModel.findOne({ accountId: reseller._id }).lean<WalletDoc>();
    const available = w ? w.balanceMicros - w.holdMicros : 0;
    if (available < body.startingCreditMicros) {
      throw new AppError('WALLET_INSUFFICIENT_BALANCE', undefined, [
        {
          path: 'body.startingCreditMicros',
          message: 'Not enough available balance',
          availableMicros: Math.max(available, 0),
        },
      ]);
    }
  }
  const made = await createAccountWithOwner({
    businessName: body.businessName,
    ownerName: body.ownerName,
    ownerEmail: body.ownerEmail,
    ownerPassword: body.ownerPassword,
    ownerPhone: body.ownerPhone,
    timezone: body.timezone,
    kind: 'business',
    parentAccountId: reseller._id,
  });
  await auditBoth(req, reseller, made.account._id, 'reseller.customer_created', {
    startingCreditMicros: body.startingCreditMicros ?? 0,
  });
  if (body.startingCreditMicros) {
    await moveCredit(
      req,
      reseller,
      made.account,
      body.startingCreditMicros,
      'Starting credit',
      'give',
    );
  }
  await bustSummary(reseller._id);
  const [row] = await customerRows([made.account]);
  return row as CustomerRow;
};

export const customerDetail = async (req: Request, id: string) => {
  const reseller = await callerReseller(req);
  const customer = await findCustomer(reseller, id);
  const [row] = await customerRows([customer]);
  const transfers = await LedgerEntryModel.find({
    accountId: reseller._id,
    type: { $in: ['credit_transfer_out', 'credit_transfer_in'] },
    note: { $exists: true },
    'ref.type': 'credit_transfer',
    'ref.id': {
      $in: (
        await LedgerEntryModel.find({
          accountId: customer._id,
          'ref.type': 'credit_transfer',
        })
          .select({ 'ref.id': 1 })
          .sort({ createdAt: -1 })
          .limit(20)
          .lean<{ ref: { id: string } }[]>()
      ).map((r) => r.ref.id),
    },
  })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean<LedgerEntryDoc[]>();
  return {
    ...(row as CustomerRow),
    timezone: customer.timezone,
    transfers: transfers.map((t) => ({
      id: t.ref.id,
      direction: t.type === 'credit_transfer_out' ? ('given' as const) : ('taken_back' as const),
      amountMicros: t.amountMicros,
      note: t.note ?? null,
      at: t.createdAt.toISOString(),
    })),
  };
};

export const updateCustomer = async (
  req: Request,
  id: string,
  body: { name?: string | undefined; status?: 'active' | 'suspended' | undefined },
) => {
  const reseller = await callerReseller(req);
  const customer = await findCustomer(reseller, id);
  const set: Record<string, unknown> = {};
  if (body.name) set.name = body.name;
  if (body.status && body.status !== customer.status) {
    set.status = body.status;
    set.suspendedAt = body.status === 'suspended' ? new Date() : null;
    set.suspendReason = body.status === 'suspended' ? 'Suspended by your provider' : null;
  }
  if (!Object.keys(set).length) return customerDetail(req, id);
  await AccountModel.updateOne({ _id: customer._id }, { $set: set });
  if (set.status === 'suspended') {
    notifyAccount(customer._id.toString(), 'account.suspended', {
      reason: 'Suspended by your provider',
    });
    await pauseAccountCampaigns(customer._id, 'account_suspended');
    await auditBoth(req, reseller, customer._id, 'reseller.customer_suspended');
  } else if (set.status === 'active') {
    notifyAccount(customer._id.toString(), 'account.enabled', {});
    await auditBoth(req, reseller, customer._id, 'reseller.customer_enabled');
  }
  await bustSummary(reseller._id);
  return customerDetail(req, id);
};

/** Sets the customer owner's password (no e-mail); their sessions end. */
export const resetOwnerPassword = async (req: Request, id: string, password: string) => {
  const reseller = await callerReseller(req);
  const customer = await findCustomer(reseller, id);
  const owner = customer.ownerId
    ? await UserModel.findById(customer.ownerId).lean<UserDoc>()
    : null;
  if (!owner) throw new ConflictError('CONFLICT_INVALID_STATE', 'This account has no owner.');
  const issues = validatePasswordPolicy(
    password,
    { email: owner.email, name: owner.name },
    'body.password',
  );
  if (issues.length) throw new ValidationError(issues);
  await UserModel.updateOne(
    { _id: owner._id },
    {
      $set: { passwordHash: await hashPassword(password), passwordChangedAt: new Date() },
      $inc: { tokenVersion: 1 },
    },
  );
  await revokeAllForUser(owner._id, 'password_changed');
  notifyUser(
    customer._id.toString(),
    owner._id.toString(),
    'session.revoked',
    { reason: 'password_changed' },
    { close: true },
  );
  await auditBoth(
    req,
    reseller,
    customer._id,
    'reseller.customer_password_reset',
    {},
    {
      type: 'user',
      id: owner._id.toString(),
    },
  );
};

/** Credit limits per transfer (₹1,00,00,000 max). */
export const CREDIT_LIMITS = { maxMicros: 10_000_000_000_000 } as const;

const moveCredit = async (
  req: Request,
  reseller: AccountDoc,
  customer: AccountDoc,
  amountMicros: number,
  note: string | null,
  way: 'give' | 'take',
  transferId: string = randomUUID(),
) => {
  const auth = requireAuth(req);
  const result = await transferCredit({
    fromAccountId: way === 'give' ? reseller._id : customer._id,
    toAccountId: way === 'give' ? customer._id : reseller._id,
    amountMicros,
    transferId,
    note,
    createdBy: auth.userId ?? null,
  });
  if (!result.replay) {
    await auditBoth(
      req,
      reseller,
      customer._id,
      way === 'give' ? 'reseller.credit_transferred' : 'reseller.credit_reclaimed',
      { amountMicros, transferId },
    );
    if (way === 'give') {
      try {
        const users = await usersWithPermission(customer._id, 'account.update');
        if (users.length) {
          await notify({
            accountId: customer._id,
            userIds: users.map((u) => u.userId),
            type: 'wallet.credit_received',
            title: 'Credit added to your wallet',
            body: `${reseller.name} added credit to your wallet.`,
            link: '/wallet',
          });
        }
      } catch (err) {
        getLogger().error({ err }, 'reseller: credit bell failed');
      }
    }
    await bustSummary(reseller._id);
  }
  return result;
};

/** Gives credit to (or takes unused credit back from) one of this reseller's customers. */
export const customerCredit = async (
  req: Request,
  id: string,
  body: { amountMicros: number; note?: string | undefined },
  way: 'give' | 'take',
  idempotencyKey?: string,
) => {
  const reseller = await callerReseller(req);
  assertApproved(reseller);
  const customer = await findCustomer(reseller, id);
  if (customer.status !== 'active') {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'Enable the customer before moving credit.');
  }
  const transferId = idempotencyKey
    ? `${reseller._id.toString()}:${idempotencyKey}`.slice(0, 100)
    : randomUUID();
  const result = await moveCredit(
    req,
    reseller,
    customer,
    body.amountMicros,
    body.note ?? null,
    way,
    transferId,
  );
  const resellerWallet = way === 'give' ? result.from : result.to;
  const customerWallet = way === 'give' ? result.to : result.from;
  return {
    transferId,
    amountMicros: body.amountMicros,
    resellerBalanceMicros: resellerWallet.balanceMicros,
    customerBalanceMicros: customerWallet.balanceMicros,
    replay: result.replay,
  };
};

/** The reseller's transfers in / out (with the customer's name). */
export const statement = async (
  req: Request,
  query: { from?: string | undefined; to?: string | undefined },
) => {
  const reseller = await callerReseller(req);
  const range: Record<string, Date> = {};
  if (query.from) range.$gte = new Date(query.from);
  if (query.to) range.$lt = new Date(query.to);
  const rows = await LedgerEntryModel.find({
    accountId: reseller._id,
    type: { $in: ['credit_transfer_out', 'credit_transfer_in'] },
    ...(Object.keys(range).length ? { createdAt: range } : {}),
  })
    .sort({ createdAt: -1 })
    .limit(5_000)
    .lean<LedgerEntryDoc[]>();
  const other = await LedgerEntryModel.find({
    'ref.type': 'credit_transfer',
    'ref.id': { $in: rows.map((r) => r.ref.id) },
    accountId: { $ne: reseller._id },
  })
    .select({ accountId: 1, 'ref.id': 1 })
    .lean<{ accountId: Types.ObjectId; ref: { id: string } }[]>();
  const customerOf = new Map(other.map((o) => [o.ref.id, o.accountId]));
  const names = await AccountModel.find({
    _id: { $in: [...new Set(other.map((o) => o.accountId.toString()))] },
  })
    .select({ name: 1 })
    .lean<{ _id: Types.ObjectId; name: string }[]>();
  const nameOf = new Map(names.map((n) => [n._id.toString(), n.name]));
  return rows.map((r) => {
    const cid = customerOf.get(r.ref.id);
    return {
      id: r.ref.id,
      at: r.createdAt.toISOString(),
      direction: r.type === 'credit_transfer_out' ? ('given' as const) : ('taken_back' as const),
      amountMicros: r.amountMicros,
      balanceAfterMicros: r.balanceAfterMicros ?? null,
      customer: cid ? { id: cid.toString(), name: nameOf.get(cid.toString()) ?? '' } : null,
      note: r.note ?? null,
    };
  });
};

export const statementCsv = async (
  req: Request,
  query: { from?: string | undefined; to?: string | undefined },
) => {
  const rows = await statement(req, query);
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = ['Date,Customer,Direction,Amount (INR),Balance after (INR),Note'];
  for (const r of rows) {
    lines.push(
      [
        r.at,
        esc(r.customer?.name ?? ''),
        r.direction === 'given' ? 'Given' : 'Taken back',
        (r.amountMicros / 1_000_000).toFixed(2),
        r.balanceAfterMicros === null ? '' : (r.balanceAfterMicros / 1_000_000).toFixed(2),
        esc(r.note ?? ''),
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
};

export const getSettings = async (req: Request) => {
  const reseller = await callerReseller(req);
  return { customersCanTopUp: reseller.reseller?.customersCanTopUp ?? false };
};

export const updateSettings = async (req: Request, body: { customersCanTopUp: boolean }) => {
  const reseller = await callerReseller(req);
  await AccountModel.updateOne(
    { _id: reseller._id },
    { $set: { 'reseller.customersCanTopUp': body.customersCanTopUp } },
  );
  const auth = requireAuth(req);
  await recordAudit({
    accountId: reseller._id,
    actor: { type: 'user', id: auth.userId ?? null },
    action: 'reseller.settings_updated',
    target: { type: 'account', id: reseller._id.toString() },
    meta: { customersCanTopUp: body.customersCanTopUp },
    ip: req.ip ?? null,
  });
  return { customersCanTopUp: body.customersCanTopUp };
};

const SUMMARY_TTL_S = 300;

/** Dashboard numbers (cached 5 min in Redis `reseller:summary:<id>`). */
export const summary = async (req: Request) => {
  const reseller = await callerReseller(req);
  const key = `reseller:summary:${reseller._id.toString()}`;
  const redis = appRedis();
  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit) as unknown;
  } catch {
    // compute below
  }
  const customers = await AccountModel.find({
    kind: 'business',
    parentAccountId: reseller._id,
    status: { $ne: 'deleted' },
  })
    .select({ _id: 1, name: 1, status: 1 })
    .lean<Pick<AccountDoc, '_id' | 'name' | 'status'>[]>();
  const ids = customers.map((c) => c._id);
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const since = new Date(now.getTime() - 30 * DAY_MS);
  const [given, spend, wallets] = await Promise.all([
    LedgerEntryModel.aggregate<{ micros: number }>([
      {
        $match: {
          accountId: reseller._id,
          type: 'credit_transfer_out',
          createdAt: { $gte: monthStart },
        },
      },
      { $group: { _id: null, micros: { $sum: '$amountMicros' } } },
    ]),
    LedgerEntryModel.aggregate<{ _id: string; micros: number }>([
      {
        $match: {
          accountId: { $in: ids },
          type: { $in: [...SPEND_TYPES] },
          status: 'captured',
          createdAt: { $gte: since },
        },
      },
      { $group: { _id: '$type', micros: { $sum: '$amountMicros' } } },
    ]),
    WalletModel.find({ accountId: { $in: ids } }).lean<WalletDoc[]>(),
  ]);
  const by = new Map(spend.map((s) => [s._id, s.micros]));
  const sum = (...types: string[]) => types.reduce((a, t) => a + (by.get(t) ?? 0), 0);
  const nameOf = new Map(customers.map((c) => [c._id.toString(), c.name]));
  const low = wallets
    .filter((w) => w.balanceMicros - w.holdMicros < w.lowBalanceThresholdMicros)
    .map((w) => ({
      id: w.accountId.toString(),
      name: nameOf.get(w.accountId.toString()) ?? '',
      availableMicros: w.balanceMicros - w.holdMicros,
    }))
    .sort((a, b) => a.availableMicros - b.availableMicros)
    .slice(0, 10);
  const value = {
    customers: {
      active: customers.filter((c) => c.status === 'active').length,
      suspended: customers.filter((c) => c.status === 'suspended').length,
      total: customers.length,
    },
    creditGivenThisMonthMicros: given[0]?.micros ?? 0,
    customersSpend30d: {
      calls: sum('call_charge', 'recording_charge', 'whatsapp_call_charge'),
      whatsapp: sum('whatsapp_charge'),
      ai: sum('ai_charge', 'tts_charge'),
      totalMicros: sum(...SPEND_TYPES),
    },
    lowBalanceCustomers: low,
  };
  try {
    await redis.set(key, JSON.stringify(value), 'EX', SUMMARY_TTL_S);
  } catch {
    // best effort
  }
  return value;
};
