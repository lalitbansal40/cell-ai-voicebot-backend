import type { Request } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';

import { getEnv } from '../../config/env';
import type { AriClient } from '../../core/telephony/sip/ari-client';
import {
  pushTrunk,
  removeTrunk,
  trunkEndpointOf,
  trunkState,
  type TrunkSpec,
} from '../../core/telephony/sip/trunks';
import { AccountModel, type AccountDoc, type AccountSipTrunk } from '../../db/models/account.model';
import { PhoneNumberModel } from '../../db/models/phone-number.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { toObjectId } from '../../shared/auth/tenant';
import { open, seal, secretBoxKey } from '../../shared/crypto/secret-box';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';
import { recordAudit } from '../audit/audit.service';

import type { SipTrunkBody } from './sip-trunks.schema';

/**
 * An account's own SIP trunk, set in Admin → account → Phone line (no env change): saved
 * here (password sealed), pushed to Asterisk over this process's ARI connection, and pushed
 * again after every reconnect. Saving also puts the account on the phone line and gives it
 * the caller ID as a number (outgoing + incoming).
 */

let line: AriClient | null = null;

/** The server's ARI connection (set at boot when the SIP line runs here). */
export const setTrunkLine = (ari: AriClient | null): void => {
  line = ari;
};

const specOf = (t: AccountSipTrunk): TrunkSpec => ({
  host: t.host,
  port: t.port,
  transport: t.transport,
  auth: t.auth,
  username: t.username,
  password: t.passwordSealed ? open(secretBoxKey(getEnv()), t.passwordSealed) : null,
  trunkIps: t.trunkIps,
  codecs: t.codecs,
});

/** Pushes every saved account trunk (ARI connected / reconnected after an Asterisk restart). */
export const syncAllTrunks = async (ari: AriClient): Promise<number> => {
  const accounts = await AccountModel.find({
    sipTrunk: { $type: 'object' },
    status: { $ne: 'deleted' },
  })
    .select({ sipTrunk: 1 })
    .lean<{ _id: Types.ObjectId; sipTrunk: AccountSipTrunk }[]>();
  let pushed = 0;
  for (const a of accounts) {
    try {
      await pushTrunk(ari, a._id.toString(), specOf(a.sipTrunk));
      pushed += 1;
    } catch (err) {
      getLogger().warn({ err, accountId: a._id.toString() }, 'sip trunk: push failed');
    }
  }
  return pushed;
};

/** The endpoint an account's calls dial through (`null` = the server trunk). */
export const accountTrunkEndpoint = async (
  accountId: Types.ObjectId | string,
): Promise<string | null> => {
  const a = await AccountModel.findById(accountId)
    .select({ sipTrunk: 1 })
    .lean<{ sipTrunk?: AccountSipTrunk | null }>();
  return a?.sipTrunk ? trunkEndpointOf(accountId.toString()) : null;
};

const customerAccount = async (id: string): Promise<AccountDoc> => {
  const _id = toObjectId(id);
  if (!_id) throw new NotFoundError();
  const account = await AccountModel.findById(_id).lean<AccountDoc>();
  if (!account) throw new NotFoundError();
  if (account.isPlatform)
    throw new ConflictError('CONFLICT_INVALID_STATE', 'The platform account has no phone line.');
  return account;
};

/** The trunk as shown (never the password) + whether Asterisk reaches it. */
export const sipTrunkView = async (
  account: Pick<AccountDoc, '_id'> & { sipTrunk?: AccountSipTrunk | null },
) => {
  const t = account.sipTrunk;
  if (!t)
    return {
      configured: false as const,
      trunk: null,
      state: null,
      lineConnected: Boolean(line?.connected),
    };
  let state: string | null = null;
  if (line?.connected) {
    state = await trunkState(line, account._id.toString()).catch(() => null);
  }
  return {
    configured: true as const,
    trunk: {
      host: t.host,
      port: t.port,
      transport: t.transport,
      auth: t.auth,
      username: t.username,
      passwordSet: Boolean(t.passwordSealed),
      trunkIps: t.trunkIps,
      callerId: t.callerId,
      codecs: t.codecs,
      updatedAt: t.updatedAt.toISOString(),
    },
    state: state ?? (line?.connected ? 'not_loaded' : 'line_down'),
    lineConnected: Boolean(line?.connected),
  };
};

const audit = async (req: Request, accountId: Types.ObjectId, meta: Record<string, unknown>) => {
  const auth = requireAuth(req);
  const base = {
    actor: { type: 'user' as const, id: auth.userId ?? null, platform: true },
    action: 'account.sip_trunk_changed' as const,
    target: { type: 'account', id: accountId.toString() },
    meta,
    ip: req.ip ?? null,
  };
  await recordAudit({ ...base, accountId });
  await recordAudit({ ...base, accountId: auth.accountId });
};

export const getSipTrunk = async (id: string) => sipTrunkView(await customerAccount(id));

/** Superadmin: save the account's trunk and connect it (password kept when left empty). */
export const saveSipTrunk = async (
  req: Request,
  id: string,
  body: z.infer<typeof SipTrunkBody>,
) => {
  const account = await customerAccount(id);
  if (getEnv().TELEPHONY_PROVIDER !== 'sip')
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      'This server has no phone line yet (the Asterisk service is not set up).',
    );
  const before = account.sipTrunk ?? null;
  const register = body.auth === 'register';
  const password = body.password?.trim();
  const passwordSealed = register
    ? password
      ? seal(secretBoxKey(getEnv()), password)
      : before?.auth === 'register'
        ? before.passwordSealed
        : null
    : null;
  if (register && !passwordSealed)
    throw new ValidationError([
      { path: 'password', message: 'Enter the trunk password (username / password trunks)' },
    ]);
  const auth = requireAuth(req);
  const trunk: AccountSipTrunk = {
    host: body.host,
    port: body.port,
    transport: body.transport,
    auth: body.auth,
    username: register ? (body.username ?? null) : null,
    passwordSealed,
    trunkIps: body.trunkIps,
    callerId: body.callerId,
    codecs: body.codecs,
    updatedAt: new Date(),
    updatedBy: auth.userId ? new Types.ObjectId(auth.userId) : null,
  };
  await AccountModel.updateOne(
    { _id: account._id },
    { $set: { sipTrunk: trunk, voiceLine: 'sip' } },
  );
  // the caller ID becomes the account's number (outgoing calls; incoming once turned on)
  const number = await PhoneNumberModel.findOne({ number: body.callerId }).lean();
  if (!number) {
    await PhoneNumberModel.create({
      number: body.callerId,
      kind: /^\+911600/.test(body.callerId) ? '1600' : 'other',
      accountId: account._id,
      purpose: 'both',
      label: 'SIP trunk',
    });
  } else if (number.accountId && !number.accountId.equals(account._id)) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      'This caller ID belongs to another account. Take it back in Admin → Phone numbers first.',
    );
  } else if (!number.accountId) {
    await PhoneNumberModel.updateOne(
      { _id: number._id },
      { $set: { accountId: account._id, status: 'active' } },
    );
  }
  let pushed = false;
  if (line?.connected) {
    await pushTrunk(line, account._id.toString(), specOf(trunk));
    pushed = true;
  }
  await audit(req, account._id, {
    host: trunk.host,
    auth: trunk.auth,
    passwordChanged: Boolean(password),
    callerIdLast4: trunk.callerId.slice(-4),
    pushed,
  });
  return sipTrunkView({ _id: account._id, sipTrunk: trunk });
};

/** Superadmin: remove the account's own trunk (calls go back to the server trunk). */
export const removeSipTrunk = async (req: Request, id: string) => {
  const account = await customerAccount(id);
  if (!account.sipTrunk) return sipTrunkView(account);
  await AccountModel.updateOne({ _id: account._id }, { $set: { sipTrunk: null } });
  if (line?.connected) await removeTrunk(line, account._id.toString()).catch(() => undefined);
  await audit(req, account._id, { removed: true });
  return sipTrunkView({ _id: account._id, sipTrunk: null });
};
