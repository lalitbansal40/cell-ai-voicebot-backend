import type { Types } from 'mongoose';

import {
  AccountModel,
  DEFAULT_INBOX_SETTINGS,
  type AccountInboxSettings,
} from '../../db/models/account.model';
import { ValidationError } from '../../shared/errors/app-error';
import { recordAudit, type AuditActorInput } from '../audit/audit.service';

import { loadInboxSettings } from './inbound.service';
import { normalizeKeyword } from './keywords';

export type InboxSettingsPatch = Partial<AccountInboxSettings>;

const view = (s: AccountInboxSettings, retentionDays: number) => ({ ...s, retentionDays });

/** Account inbox settings + the platform's message retention (read only). */
export const getInboxSettings = async (accountId: Types.ObjectId, retentionDays: number) =>
  view(await loadInboxSettings(accountId), retentionDays);

const cleanKeywords = (list: string[]): string[] => {
  const out: string[] = [];
  for (const k of list) {
    const v = normalizeKeyword(k);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
};

/** Patch (owner / admin — `account.update`): keywords stored upper-case + NFC, never in both lists. */
export const updateInboxSettings = async (
  input: {
    accountId: Types.ObjectId;
    actor: AuditActorInput;
    ip?: string | null;
    retentionDays: number;
  },
  patch: InboxSettingsPatch,
) => {
  const current = await loadInboxSettings(input.accountId);
  const next: AccountInboxSettings = { ...DEFAULT_INBOX_SETTINGS, ...current, ...patch };
  if (patch.optOutKeywords) next.optOutKeywords = cleanKeywords(patch.optOutKeywords);
  if (patch.optInKeywords) next.optInKeywords = cleanKeywords(patch.optInKeywords);
  const both = next.optOutKeywords.filter((k) => next.optInKeywords.includes(k));
  if (both.length) {
    throw new ValidationError([
      { path: 'optInKeywords', message: `A keyword can't be in both lists: ${both.join(', ')}` },
    ]);
  }
  if (!next.optOutKeywords.length) {
    throw new ValidationError([
      { path: 'optOutKeywords', message: 'Keep at least one opt-out keyword' },
    ]);
  }
  const fields = (Object.keys(patch) as (keyof AccountInboxSettings)[]).filter(
    (k) => JSON.stringify(next[k]) !== JSON.stringify(current[k]),
  );
  if (fields.length) {
    await AccountModel.updateOne({ _id: input.accountId }, { $set: { 'settings.inbox': next } });
    await recordAudit({
      accountId: input.accountId,
      actor: input.actor,
      action: 'inbox.settings_updated',
      target: { type: 'account', id: input.accountId.toString() },
      meta: { fields },
      ip: input.ip ?? null,
    });
  }
  return view(next, input.retentionDays);
};
