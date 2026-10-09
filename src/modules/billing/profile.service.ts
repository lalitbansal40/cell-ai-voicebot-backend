import type { Request } from 'express';
import type { z } from 'zod';

import { getEnv } from '../../config/env';
import { AccountModel, type BillingProfile } from '../../db/models/account.model';
import { tenantFilter } from '../../shared/auth/tenant';
import { NotFoundError } from '../../shared/errors/app-error';
import { auditRequest } from '../audit/audit.service';

import type { BillingProfileBody } from './billing.schema';

type StoredProfile = BillingProfile & { updatedAt: Date };

const FIELDS = [
  'legalName',
  'email',
  'addressLine1',
  'addressLine2',
  'city',
  'stateCode',
  'pin',
  'gstin',
] as const;

const view = (p: StoredProfile | null | undefined) => ({
  profile: p
    ? {
        legalName: p.legalName,
        email: p.email,
        addressLine1: p.addressLine1,
        addressLine2: p.addressLine2 ?? null,
        city: p.city,
        stateCode: p.stateCode,
        pin: p.pin,
        gstin: p.gstin ?? null,
        updatedAt: p.updatedAt.toISOString(),
      }
    : null,
  complete: Boolean(p?.legalName && p.email && p.addressLine1 && p.city && p.stateCode && p.pin),
  sellerStateCode: getEnv().BILLING_SELLER_STATE_CODE,
});

/** The account's billing profile (null until saved). */
export const loadBillingProfile = async (accountId: unknown): Promise<StoredProfile | null> =>
  (
    await AccountModel.findById(accountId)
      .select({ billing: 1 })
      .lean<{ billing?: StoredProfile | null }>()
  )?.billing ?? null;

export const getBillingProfile = async (req: Request) =>
  view(await loadBillingProfile(tenantFilter(req).accountId));

export const saveBillingProfile = async (
  req: Request,
  body: z.infer<typeof BillingProfileBody>,
) => {
  const { accountId } = tenantFilter(req);
  const before = await loadBillingProfile(accountId);
  const next: StoredProfile = {
    legalName: body.legalName,
    email: body.email,
    addressLine1: body.addressLine1,
    addressLine2: body.addressLine2 ?? null,
    city: body.city,
    stateCode: body.stateCode,
    pin: body.pin,
    gstin: body.gstin ? body.gstin : null,
    updatedAt: new Date(),
  };
  const res = await AccountModel.updateOne({ _id: accountId }, { $set: { billing: next } });
  if (!res.matchedCount) throw new NotFoundError('Account not found');
  const fields = FIELDS.filter((f) => (before?.[f] ?? null) !== (next[f] ?? null));
  if (fields.length) {
    // field names only — GSTIN / address values never go into the audit log
    await auditRequest(req, 'billing.profile_updated', {
      target: { type: 'account', id: accountId.toString() },
      meta: { fields },
    });
  }
  return view(next);
};
