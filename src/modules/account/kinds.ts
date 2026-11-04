import type { Types } from 'mongoose';

import { AccountModel, type AccountDoc } from '../../db/models/account.model';
import {
  DEFAULT_SIGNUP_SETTINGS,
  PlatformSettingsModel,
  type SignupSettings,
} from '../../db/models/platform-settings.model';

type KindFields = Pick<AccountDoc, 'kind' | 'parentAccountId' | 'isPlatform'>;

/** Rows saved before Phase 19 have no `kind`: platform account → platform, else business. */
export const kindOf = (a: Partial<KindFields>): AccountDoc['kind'] =>
  a.kind ?? (a.isPlatform ? 'platform' : 'business');

export const isReseller = (a: Partial<KindFields>): boolean => kindOf(a) === 'reseller';

/** True when the business account belongs to this reseller. */
export const isChildOf = (a: Partial<KindFields>, resellerId: Types.ObjectId | string): boolean =>
  kindOf(a) === 'business' &&
  Boolean(a.parentAccountId) &&
  String(a.parentAccountId) === String(resellerId);

/** A reseller account by id (null when the id is not a reseller). */
export const findReseller = async (id: Types.ObjectId | string): Promise<AccountDoc | null> =>
  AccountModel.findOne({ _id: id, kind: 'reseller' }).lean<AccountDoc>();

/** Platform setting `signup` (code default when no row). */
export const getSignupSettings = async (): Promise<SignupSettings> => {
  const row = await PlatformSettingsModel.findOne({ key: 'signup' }).lean<{
    value: SignupSettings;
  }>();
  return { ...DEFAULT_SIGNUP_SETTINGS, ...(row?.value ?? {}) };
};
