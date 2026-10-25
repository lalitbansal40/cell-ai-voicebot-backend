import { CallModel, LIVE_CALL_STATUSES } from '../../db/models/call.model';
import type { ContactDoc } from '../../db/models/contact.model';
import { ConversationModel } from '../../db/models/conversation.model';
import { defaultCalling, type WhatsAppChannelDoc } from '../../db/models/whatsapp-channel.model';
import { AppError } from '../../shared/errors/app-error';
import type { ErrorCode } from '../../shared/errors/error-codes';
import { accountFacts } from '../campaigns/campaigns.service';
import { canDialAt, effectiveWindow, nextWindowStart } from '../campaigns/window';
import { isPhoneOnDnd } from '../contacts/contacts.service';

import { activeRestrictions, bicCountryBlocked } from './availability';
import type { PermissionPanel } from './permissions.service';
import { programProblems, type CallProgram } from './program';

/**
 * Every business-initiated WhatsApp call — agent or AI — passes this, in this order
 * (PHASE_12_PLAN §1e "Dial guard"); the first failure wins. Used by the API, the
 * contact panel and (later) campaigns. The wallet (rule 6) is the hold itself.
 */
export type DialGuardResult =
  { ok: true } | { ok: false; code: ErrorCode; reason: string; nextAt?: Date | null };

export interface DialGuardInput {
  now: Date;
  whatsappEnabled: boolean;
  channel: WhatsAppChannelDoc;
  contact: ContactDoc | null;
  mode: 'human' | 'ai';
  program: CallProgram | null;
  /** Impersonators may look, never call. */
  impersonating: boolean;
  /** Meta + our row, fresh (≤ 60 s) — `permissions.statusFor`. */
  permission: () => Promise<PermissionPanel>;
  /** Live calls of this process holding media / the most it takes (`WA_MEDIA_MAX_CALLS`). */
  capacity: { active: number; max: number };
  /** Live calls of the account (every provider) — `maxConcurrentCalls`. */
  liveCalls: () => Promise<number>;
  /** DEV / E2E only (`WA_CALL_WINDOW_IGNORED`, fake Meta): no calling window. */
  ignoreWindow?: boolean;
}

const no = (code: ErrorCode, reason: string, nextAt?: Date | null): DialGuardResult => ({
  ok: false,
  code,
  reason,
  ...(nextAt !== undefined ? { nextAt } : {}),
});

export const checkDial = async (input: DialGuardInput): Promise<DialGuardResult> => {
  const { channel, contact, now } = input;
  const calling = channel.calling ?? defaultCalling();
  // 1. the number
  if (!input.whatsappEnabled) return no('WHATSAPP_CALLING_DISABLED', 'whatsapp_off');
  if (channel.status !== 'connected' && channel.status !== 'action_needed') {
    return no('WHATSAPP_CHANNEL_NOT_READY', 'not_connected');
  }
  if (calling.status === 'unavailable' || channel.mode === 'coexistence') {
    return no('WHATSAPP_CALLING_UNAVAILABLE', calling.unavailableReason ?? 'coexistence');
  }
  if (calling.status !== 'enabled') return no('WHATSAPP_CALLING_DISABLED', 'calling_disabled');
  if (bicCountryBlocked(channel)) return no('WHATSAPP_CALLING_UNAVAILABLE', 'country');
  const restriction = activeRestrictions(calling, 'business', now)[0];
  if (restriction) return no('WHATSAPP_CALLING_RESTRICTED', 'restricted', restriction.expiresAt);
  // 2. the account / caller (permission checks run in the route)
  const account = await accountFacts(channel.accountId);
  if (account.status === 'suspended') return no('AUTH_ACCOUNT_SUSPENDED', 'account_suspended');
  if (input.impersonating) return no('AUTH_FORBIDDEN', 'impersonating');
  // 3. the customer + the calling window (TRAI 09:00–21:00 for every live call)
  if (!contact || contact.deletedAt) return no('RESOURCE_NOT_FOUND', 'contact_deleted');
  if (contact.dnd || (await isPhoneOnDnd(channel.accountId, [contact.phoneE164]))) {
    return no('CALL_NOT_ALLOWED', 'dnd');
  }
  if (contact.optedOutAt) return no('CALL_NOT_ALLOWED', 'opted_out');
  const waId = contact.whatsapp?.waId ?? contact.phoneE164.replace(/\D/g, '');
  const conversation = await ConversationModel.findOne({
    accountId: channel.accountId,
    channelId: channel._id,
    waId,
  })
    .select({ blocked: 1 })
    .lean<{ blocked: boolean }>();
  if (contact.whatsapp?.blocked || conversation?.blocked) return no('CALL_NOT_ALLOWED', 'blocked');
  const window = effectiveWindow({
    account: account.window,
    campaign: account.window,
    live: true,
    recovery: false,
  });
  if (!input.ignoreWindow && (!window || !canDialAt(now, window, account.timezone))) {
    const next = window ? nextWindowStart(now, window, account.timezone) : null;
    return no('CALL_OUTSIDE_WINDOW', 'outside_window', next);
  }
  // 5 (cheap, before Meta): one live call per customer, account / process limits
  const active = await CallModel.exists({
    accountId: channel.accountId,
    contactId: contact._id,
    provider: 'whatsapp',
    status: { $in: [...LIVE_CALL_STATUSES] },
  });
  if (active) return no('WHATSAPP_CALL_ACTIVE', 'call_in_progress');
  if ((await input.liveCalls()) >= account.limits.maxConcurrentCalls) {
    return no('CALL_LIMIT_REACHED', 'account_limit');
  }
  if (input.capacity.active >= input.capacity.max) return no('CALL_CAPACITY', 'server_full');
  // 7. AI calls: a runnable program (before Meta: cheaper)
  if (input.mode === 'ai') {
    const problems = await programProblems(channel.accountId, input.program);
    if (problems.length) return no('VALIDATION_FAILED', problems[0]?.message ?? 'program');
  }
  // 4. permission: our row + Meta's start_call (an API error refuses)
  const permission = await input.permission();
  if (!permission.canCall) {
    if (permission.reason === 'check_failed') {
      return no('WHATSAPP_CALL_PERMISSION_CHECK_FAILED', 'check_failed');
    }
    if (permission.reason === 'call_limit') return no('WHATSAPP_CALL_LIMIT_REACHED', 'call_limit');
    return no('WHATSAPP_CALL_PERMISSION_MISSING', permission.reason ?? 'no_permission');
  }
  return { ok: true };
};

/** The guard as an error (API / services). */
export const assertDial = async (input: DialGuardInput): Promise<void> => {
  const result = await checkDial(input);
  if (result.ok) return;
  throw new AppError(
    result.code,
    undefined,
    [
      {
        path: result.code === 'CALL_OUTSIDE_WINDOW' ? 'window' : 'call',
        message:
          result.code === 'CALL_OUTSIDE_WINDOW'
            ? (result.nextAt?.toISOString() ?? '')
            : result.reason,
      },
    ],
    result.nextAt
      ? { retryAfterSec: Math.max(0, Math.ceil((result.nextAt.getTime() - Date.now()) / 1000)) }
      : {},
  );
};
