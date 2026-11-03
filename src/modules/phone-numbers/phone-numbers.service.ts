import type { Request } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';

import { getEnv } from '../../config/env';
import { SIP_LIMITS } from '../../config/limits';
import { isDuplicateKeyError } from '../../db/errors';
import { AccountModel, type AccountVoiceLine } from '../../db/models/account.model';
import { PhoneNumberModel, type PhoneNumberDoc } from '../../db/models/phone-number.model';
import { AppError, ConflictError, NotFoundError } from '../../shared/errors/app-error';
import { auditRequest } from '../audit/audit.service';
import { effectiveLine } from '../calls/line';

import type {
  CreatePhoneNumberBody,
  ListPhoneNumbersQuery,
  UpdatePhoneNumberBody,
} from './phone-numbers.schema';

const warningsOf = (n: Pick<PhoneNumberDoc, 'kind' | 'number'>): string[] =>
  n.kind === '1600' && !SIP_LIMITS.series1600.test(n.number) ? ['not_1600_series'] : [];

const view = (n: PhoneNumberDoc, names: Map<string, string> = new Map()) => ({
  id: n._id.toString(),
  number: n.number,
  kind: n.kind,
  accountId: n.accountId?.toString() ?? null,
  accountName: n.accountId ? (names.get(n.accountId.toString()) ?? null) : null,
  purpose: n.purpose,
  label: n.label,
  dltPrincipalEntityId: n.dltPrincipalEntityId,
  status: n.status,
  warnings: warningsOf(n),
  createdAt: n.createdAt.toISOString(),
});

const namesOf = async (docs: PhoneNumberDoc[]) => {
  const ids = [...new Set(docs.flatMap((d) => (d.accountId ? [d.accountId.toString()] : [])))];
  const accounts = await AccountModel.find({ _id: { $in: ids } })
    .select({ name: 1 })
    .lean<{ _id: Types.ObjectId; name: string }[]>();
  return new Map(accounts.map((a) => [a._id.toString(), a.name]));
};

const find = async (id: string): Promise<PhoneNumberDoc> => {
  const doc = await PhoneNumberModel.findById(id).lean<PhoneNumberDoc>();
  if (!doc) throw new NotFoundError();
  return doc;
};

/** Audit in the platform account (superadmin) and, when given, the number's account. */
const audit = async (
  req: Request,
  action: Parameters<typeof auditRequest>[1],
  doc: PhoneNumberDoc,
  meta: Record<string, unknown>,
  accountId?: Types.ObjectId | null,
) => {
  const target = { type: 'phone_number', id: doc._id.toString() };
  // the number itself is the account's caller ID, not a customer's: last 4 only anyway
  const m = { ...meta, numberLast4: doc.number.slice(-4) };
  await auditRequest(req, action, { target, meta: m });
  if (accountId)
    await auditRequest(req, action, { target, meta: m, accountId: accountId.toString() });
};

export const listPhoneNumbers = async (q: z.infer<typeof ListPhoneNumbersQuery>) => {
  const filter: Record<string, unknown> = {};
  if (q.accountId) filter.accountId = new Types.ObjectId(q.accountId);
  if (q.status) filter.status = q.status;
  const docs = await PhoneNumberModel.find(filter)
    .sort({ createdAt: 1 })
    .limit(1000)
    .lean<PhoneNumberDoc[]>();
  const names = await namesOf(docs);
  return docs.map((d) => view(d, names));
};

export const createPhoneNumber = async (
  req: Request,
  body: z.infer<typeof CreatePhoneNumberBody>,
) => {
  try {
    const doc = (await PhoneNumberModel.create({ ...body, purpose: 'outbound' })).toObject();
    await audit(req, 'phone_number.created', doc, { kind: doc.kind });
    return view(doc);
  } catch (err) {
    if (isDuplicateKeyError(err)) throw new AppError('PHONE_NUMBER_EXISTS');
    throw err;
  }
};

export const updatePhoneNumber = async (
  req: Request,
  id: string,
  body: z.infer<typeof UpdatePhoneNumberBody>,
) => {
  const before = await find(id);
  const doc = (await PhoneNumberModel.findByIdAndUpdate(
    before._id,
    { $set: body },
    { new: true },
  ).lean<PhoneNumberDoc>()) as PhoneNumberDoc;
  await audit(req, 'phone_number.updated', doc, { changed: Object.keys(body) }, doc.accountId);
  return view(doc, await namesOf([doc]));
};

/** `to.accountId` is the superadmin's choice of target account (not the caller's tenant). */
export const assignPhoneNumber = async (req: Request, id: string, to: { accountId: string }) => {
  const { accountId } = to;
  const before = await find(id);
  if (before.status !== 'active') {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'A disabled number cannot be given out.');
  }
  const account = await AccountModel.findById(accountId)
    .select({ isPlatform: 1 })
    .lean<{ isPlatform?: boolean }>();
  if (!account || account.isPlatform) throw new NotFoundError();
  const doc = (await PhoneNumberModel.findByIdAndUpdate(
    before._id,
    { $set: { accountId: new Types.ObjectId(accountId) } },
    { new: true },
  ).lean<PhoneNumberDoc>()) as PhoneNumberDoc;
  if (before.accountId && !before.accountId.equals(accountId)) {
    await audit(req, 'phone_number.released', before, {}, before.accountId);
  }
  await audit(req, 'phone_number.assigned', doc, { accountId }, doc.accountId);
  return view(doc, await namesOf([doc]));
};

export const releasePhoneNumber = async (req: Request, id: string) => {
  const before = await find(id);
  const doc = (await PhoneNumberModel.findByIdAndUpdate(
    before._id,
    { $set: { accountId: null } },
    { new: true },
  ).lean<PhoneNumberDoc>()) as PhoneNumberDoc;
  await audit(req, 'phone_number.released', doc, {}, before.accountId);
  return view(doc);
};

/** The account's active outbound numbers (Settings → Phone line, campaign form). */
export const accountPhoneNumbers = async (accountId: Types.ObjectId) => {
  const docs = await PhoneNumberModel.find({ accountId, status: 'active', purpose: 'outbound' })
    .sort({ createdAt: 1 })
    .lean<PhoneNumberDoc[]>();
  return docs.map((d) => view(d));
};

/** Settings → Phone line and the campaign form: which line the account is on, and its numbers. */
export const accountPhoneLine = async (accountId: Types.ObjectId) => {
  const account = await AccountModel.findById(accountId)
    .select({ voiceLine: 1 })
    .lean<{ voiceLine?: AccountVoiceLine }>();
  return {
    line: effectiveLine(account, getEnv()),
    numbers: await accountPhoneNumbers(accountId),
  };
};

/**
 * The caller ID of a call (T18.7): the campaign's number, else the account's first active
 * number, else `null` (the line's `SIP_CALLER_ID`). A chosen number that is not the
 * account's or not active → `CALLER_NUMBER_INVALID`.
 */
export const resolveCallerId = async (
  accountId: Types.ObjectId | string,
  callerNumberId: Types.ObjectId | string | null | undefined,
): Promise<{ number: string; id: Types.ObjectId } | null> => {
  const base = {
    accountId: new Types.ObjectId(accountId),
    status: 'active' as const,
    purpose: 'outbound' as const,
  };
  if (callerNumberId) {
    const chosen = await PhoneNumberModel.findOne({
      ...base,
      _id: callerNumberId,
    }).lean<PhoneNumberDoc>();
    if (!chosen) throw new AppError('CALLER_NUMBER_INVALID');
    return { number: chosen.number, id: chosen._id };
  }
  const first = await PhoneNumberModel.findOne(base).sort({ createdAt: 1 }).lean<PhoneNumberDoc>();
  return first ? { number: first.number, id: first._id } : null;
};
