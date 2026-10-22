import { Types } from 'mongoose';

import type { CallCaps } from '../../db/models/account.model';
import { CallModel } from '../../db/models/call.model';
import type { WaitReason } from '../../db/models/campaign-contact.model';
import type {
  CampaignStatus,
  CampaignWindow,
  PauseReason,
  SkipReason,
} from '../../db/models/campaign.model';
import { ContactModel } from '../../db/models/contact.model';
import { PhoneE164Schema } from '../../shared/validation/schemas';
import { isPhoneOnDnd } from '../contacts/contacts.service';

import { capBounds } from './caps';
import { canDialAt, nextWindowStart, windowStartFromDay } from './window';

export type { WaitReason };

export type DialDecision =
  | { kind: 'dial' }
  | { kind: 'wait'; until: Date; reason: WaitReason }
  | { kind: 'skip'; reason: SkipReason }
  | { kind: 'pause'; reason: PauseReason }
  /** The campaign is no longer running — give the claim back. */
  | { kind: 'release' };

export type MoneyState = 'ok' | 'insufficient' | 'budget';

/** Everything a dial decision needs, loaded beforehand (PHASE_8_PROMPT §1 "Dial guard"). */
export interface DialFacts {
  now: Date;
  accountStatus: 'active' | 'suspended';
  /** `null` for a single call (no campaign). */
  campaignStatus: CampaignStatus | null;
  /** The effective window (account ∩ campaign ∩ compliance bounds). */
  window: CampaignWindow;
  timezone: string;
  bufferMin?: number;
  /** The campaign's end (`schedule.endAt`); a wait past it becomes a skip. */
  endAt: Date | null;
  contact: { deleted: boolean; optedOut: boolean };
  phoneValid: boolean;
  dnd: boolean;
  caps: CallCaps;
  counts: { today: number; week: number; lastCallAt: Date | null };
  money: MoneyState;
}

const waitOrSkip = (
  facts: DialFacts,
  until: Date,
  reason: WaitReason,
  skip: SkipReason,
): DialDecision =>
  facts.endAt && until.getTime() >= facts.endAt.getTime()
    ? { kind: 'skip', reason: skip }
    : { kind: 'wait', until, reason };

/** First failing check wins (PHASE_8_PLAN §1d table). Pure. */
export const decideDial = (facts: DialFacts): DialDecision => {
  const { now, window: w, timezone: tz } = facts;
  if (facts.accountStatus === 'suspended') return { kind: 'pause', reason: 'account_suspended' };
  if (facts.campaignStatus !== null && facts.campaignStatus !== 'running') {
    return { kind: 'release' };
  }
  if (!canDialAt(now, w, tz, facts.bufferMin)) {
    const next = nextWindowStart(now, w, tz, facts.bufferMin);
    if (!next) return { kind: 'skip', reason: 'campaign_ended' };
    return waitOrSkip(facts, next, 'window', 'campaign_ended');
  }
  if (facts.contact.deleted) return { kind: 'skip', reason: 'contact_deleted' };
  if (facts.dnd) return { kind: 'skip', reason: 'dnd' };
  if (facts.contact.optedOut) return { kind: 'skip', reason: 'opted_out' };
  if (!facts.phoneValid) return { kind: 'skip', reason: 'invalid_phone' };
  if (facts.counts.week >= facts.caps.perWeek) {
    const next = windowStartFromDay(capBounds(now, tz).nextWeekStart, 0, w, tz);
    return waitOrSkip(facts, next, 'weekly_cap', 'cap_reached');
  }
  if (facts.counts.today >= facts.caps.perDay) {
    const next = windowStartFromDay(now, 1, w, tz);
    return waitOrSkip(facts, next, 'daily_cap', 'cap_reached');
  }
  if (facts.counts.lastCallAt && facts.caps.minGapMinutes > 0) {
    const gapEnds = new Date(facts.counts.lastCallAt.getTime() + facts.caps.minGapMinutes * 60_000);
    if (gapEnds.getTime() > now.getTime()) {
      return waitOrSkip(facts, gapEnds, 'min_gap', 'cap_reached');
    }
  }
  if (facts.money === 'insufficient') return { kind: 'pause', reason: 'wallet_empty' };
  if (facts.money === 'budget') return { kind: 'pause', reason: 'budget_reached' };
  return { kind: 'dial' };
};

/** Phone call mode for cap counting: dry-run calls only count against dry runs. */
export type CapMode = 'dry_run' | 'live';

export interface ContactFactsInput {
  accountId: string;
  contactId: string;
  /** Snapshot phone (+ the contact's current one when it changed). */
  phone: string;
  mode: CapMode;
  now: Date;
  timezone: string;
  minGapMinutes: number;
}

export interface ContactFacts {
  contact: DialFacts['contact'];
  phoneValid: boolean;
  dnd: boolean;
  counts: DialFacts['counts'];
}

export const isValidPhone = (phone: string): boolean => PhoneE164Schema.safeParse(phone).success;

interface CallCountRow {
  today: number;
  week: number;
  last: Date | null;
}

/**
 * The contact part of the dial facts in 3 queries: the contact (deleted /
 * opted out / current phone), DND for both phones, and call counts.
 */
export const loadContactFacts = async (input: ContactFactsInput): Promise<ContactFacts> => {
  const accountId = new Types.ObjectId(input.accountId);
  const contactId = new Types.ObjectId(input.contactId);
  const contact = await ContactModel.findOne({ _id: contactId, accountId }, null, {
    withDeleted: true,
  })
    .select({ phoneE164: 1, deletedAt: 1, optedOutAt: 1 })
    .lean<{ phoneE164: string; deletedAt: Date | null; optedOutAt?: Date | null }>();
  const phones = [input.phone, ...(contact?.phoneE164 ? [contact.phoneE164] : [])];
  const dnd = await isPhoneOnDnd(accountId, phones);
  const bounds = capBounds(input.now, input.timezone);
  const gapStart = new Date(input.now.getTime() - input.minGapMinutes * 60_000);
  const since = gapStart < bounds.weekStart ? gapStart : bounds.weekStart;
  const provider =
    input.mode === 'dry_run' ? 'dryrun' : { $nin: ['dryrun', 'webcall'] as string[] };
  const [row] = await CallModel.aggregate<CallCountRow>([
    { $match: { accountId, contactId, provider, createdAt: { $gte: since } } },
    {
      $group: {
        _id: null,
        week: { $sum: { $cond: [{ $gte: ['$createdAt', bounds.weekStart] }, 1, 0] } },
        today: { $sum: { $cond: [{ $gte: ['$createdAt', bounds.dayStart] }, 1, 0] } },
        last: { $max: '$createdAt' },
      },
    },
  ]);
  return {
    contact: {
      deleted: !contact || Boolean(contact.deletedAt),
      optedOut: Boolean(contact?.optedOutAt),
    },
    phoneValid: isValidPhone(input.phone),
    dnd,
    counts: { today: row?.today ?? 0, week: row?.week ?? 0, lastCallAt: row?.last ?? null },
  };
};
