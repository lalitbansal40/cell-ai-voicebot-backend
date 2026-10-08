import type { CountryCode } from 'libphonenumber-js';
import type { Types } from 'mongoose';

import { AccountModel } from '../../db/models/account.model';
import type { CustomFieldDoc } from '../../db/models/custom-field.model';
import { loadFields } from '../custom-fields/custom-fields.service';

import type { CompileContext } from './filter/compile';

/** What every contact operation needs about the account: country, timezone, fields. */
export interface ContactContext {
  accountId: Types.ObjectId;
  country: CountryCode;
  timezone: string;
  fields: CustomFieldDoc[];
  byKey: Map<string, CustomFieldDoc>;
}

export const loadContactContext = async (accountId: Types.ObjectId): Promise<ContactContext> => {
  const [account, fields] = await Promise.all([
    AccountModel.findById(accountId)
      .select({ country: 1, timezone: 1 })
      .lean<{ country?: string; timezone?: string }>(),
    loadFields(accountId),
  ]);
  return {
    accountId,
    country: (account?.country ?? 'IN') as CountryCode,
    timezone: account?.timezone ?? 'Asia/Kolkata',
    fields,
    byKey: new Map(fields.map((f) => [f.key, f])),
  };
};

export const compileContext = (ctx: ContactContext, now?: Date): CompileContext => ({
  fields: ctx.byKey,
  timezone: ctx.timezone,
  country: ctx.country,
  ...(now ? { now } : {}),
});
