import type { Request } from 'express';
import { Types } from 'mongoose';

import { AccountModel, type AccountDoc } from '../../db/models/account.model';
import { ContactModel } from '../../db/models/contact.model';
import { DndEntryModel } from '../../db/models/dnd-entry.model';
import {
  DEFAULT_CALLING_WINDOW_CEILING,
  PlatformSettingsModel,
  type CallingWindowCeiling,
} from '../../db/models/platform-settings.model';
import { SuppressionModel } from '../../db/models/suppression.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { NotFoundError, ValidationError } from '../../shared/errors/app-error';
import { maskPhone } from '../../shared/utils/mask';
import { auditRequest } from '../audit/audit.service';

export const COMPLIANCE_EXPORT_MAX_ROWS = 50_000;

/** The earliest start and latest end a customer account may save (superadmin; to be confirmed). */
export const getCallingWindowCeiling = async (): Promise<CallingWindowCeiling> => {
  const row = await PlatformSettingsModel.findOne({ key: 'callingWindowCeiling' }).lean<{
    value: CallingWindowCeiling;
  }>();
  return row?.value ?? DEFAULT_CALLING_WINDOW_CEILING;
};

export const setCallingWindowCeiling = async (req: Request, value: CallingWindowCeiling) => {
  if (value.start >= value.end) {
    throw new ValidationError([{ path: 'body.end', message: 'Must be after the start' }]);
  }
  await PlatformSettingsModel.updateOne(
    { key: 'callingWindowCeiling' },
    { $set: { value, updatedBy: new Types.ObjectId(requireAuth(req).userId) } },
    { upsert: true },
  );
  await auditRequest(req, 'compliance.ceiling_changed', {
    target: { type: 'platform_setting', id: 'callingWindowCeiling' },
    meta: { start: value.start, end: value.end },
  });
  return value;
};

/** An account can't save a calling window outside the ceiling. */
export const assertWindowWithinCeiling = async (window: { start: string; end: string }) => {
  const ceiling = await getCallingWindowCeiling();
  if (window.start < ceiling.start || window.end > ceiling.end) {
    throw new ValidationError([
      {
        path: 'body.settings.callingWindow',
        message: `Calling hours must stay between ${ceiling.start} and ${ceiling.end}`,
      },
    ]);
  }
};

/** Settings → Compliance: what is in force for this account. Counts only. */
export const getCompliance = async (req: Request) => {
  const accountId = new Types.ObjectId(requireAuth(req).accountId);
  const account = await AccountModel.findById(accountId).lean<AccountDoc>();
  if (!account) throw new NotFoundError();
  const [dnd, optedOut, withConsent, contacts, suppressed, ceiling] = await Promise.all([
    DndEntryModel.countDocuments({ accountId }),
    ContactModel.countDocuments({ accountId, optedOutAt: { $ne: null } }),
    ContactModel.countDocuments({ accountId, consent: { $ne: null } }),
    ContactModel.countDocuments({ accountId }),
    SuppressionModel.countDocuments({ accountId }),
    getCallingWindowCeiling(),
  ]);
  return {
    callingWindow: {
      start: account.settings.callingWindow.start,
      end: account.settings.callingWindow.end,
      days: [...account.settings.callingWindow.days],
    },
    ceiling,
    timezone: account.timezone,
    aiDisclosureEnabled: account.settings.aiDisclosureEnabled,
    recordingEnabled: account.settings.recordingEnabled,
    requireOptInForMarketing: account.settings.requireOptInForMarketing === true,
    optOutKeywords: account.settings.inbox.optOutKeywords,
    counts: { contacts, withConsent, dnd, optedOut, suppressed },
  };
};

const csvCell = (value: string): string => {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** DND and opt-out changes as CSV. Phones are masked unless the caller has `contacts.export`. */
export const complianceCsv = async (req: Request): Promise<string> => {
  const auth = requireAuth(req);
  const accountId = new Types.ObjectId(auth.accountId);
  const show = (phone: string) =>
    auth.permissions.has('contacts.export') ? phone : maskPhone(phone);
  const dnd = await DndEntryModel.find({ accountId })
    .sort({ createdAt: -1 })
    .limit(COMPLIANCE_EXPORT_MAX_ROWS)
    .select({ phoneE164: 1, source: 1, createdAt: 1 })
    .lean<{ phoneE164: string; source: string; createdAt: Date }[]>();
  const optedOut = await ContactModel.find({ accountId, optedOutAt: { $ne: null } })
    .sort({ optedOutAt: -1 })
    .limit(COMPLIANCE_EXPORT_MAX_ROWS)
    .select({ phoneE164: 1, optedOutAt: 1 })
    .lean<{ phoneE164: string; optedOutAt: Date }[]>();
  const lines = [
    'kind,phone,source,at',
    ...dnd.map((d) =>
      ['dnd', show(d.phoneE164), csvCell(d.source), d.createdAt.toISOString()].join(','),
    ),
    ...optedOut.map((c) =>
      ['opt_out', show(c.phoneE164), '', c.optedOutAt.toISOString()].join(','),
    ),
  ];
  await auditRequest(req, 'compliance.exported', {
    target: { type: 'account', id: auth.accountId },
    meta: { rows: lines.length - 1 },
  });
  return `${lines.join('\r\n')}\r\n`;
};
