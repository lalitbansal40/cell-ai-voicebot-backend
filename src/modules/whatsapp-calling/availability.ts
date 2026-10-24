import type {
  WaCalling,
  WaCallingRestriction,
  WaCallingUnavailableReason,
  WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';

/**
 * Where WhatsApp calling can work on a number (PHASE_12_PLAN §1d, Meta re-checked
 * 24 Oct 2026). Whole-calling reasons make `calling.status` `unavailable`; the
 * business-initiated country rule only stops our outbound calls.
 */

/** Calling codes of countries where business-initiated calls are not available (US / CA, EG, VN, NG). */
export const BIC_EXCLUDED_CALLING_CODES = ['1', '20', '84', '234'] as const;

/** Messaging limit tiers below the 2,000 Meta requires for calling. */
const LOW_TIERS = new Set(['TIER_50', 'TIER_250', 'TIER_1K']);

export const callingUnavailableReason = (
  channel: Pick<WhatsAppChannelDoc, 'mode' | 'isOnBizApp' | 'platformType' | 'messagingLimitTier'>,
): WaCallingUnavailableReason | null => {
  if (channel.mode === 'coexistence' || channel.isOnBizApp) return 'coexistence';
  if (channel.platformType && channel.platformType.toUpperCase() !== 'CLOUD_API') {
    return 'not_cloud_api';
  }
  if (channel.messagingLimitTier && LOW_TIERS.has(channel.messagingLimitTier)) {
    return 'messaging_limit';
  }
  return null;
};

/** The business number's calling code is excluded for business-initiated calls. */
export const bicCountryBlocked = (channel: Pick<WhatsAppChannelDoc, 'phoneE164'>): boolean => {
  const digits = channel.phoneE164?.replace(/\D/g, '') ?? '';
  if (!digits) return false;
  // longest match first: 234 before 2…, 1 alone is NANP (US / Canada)
  return BIC_EXCLUDED_CALLING_CODES.some((code) =>
    code === '1' ? digits.startsWith('1') : digits.startsWith(code),
  );
};

const BIC_RESTRICTIONS = new Set(['RESTRICTED_BUSINESS_INITIATED_CALLING']);
const UIC_RESTRICTIONS = new Set([
  'RESTRICTED_USER_INITIATED_CALLING',
  'RESTRICTED_USER_INITIATED_CALLING_CALL_BUTTON_HIDDEN',
]);

/** Restrictions in force now (no expiry = until Meta lifts it). */
export const activeRestrictions = (
  calling: Pick<WaCalling, 'restrictions'> | undefined,
  kind: 'business' | 'user',
  now: Date,
): WaCallingRestriction[] =>
  (calling?.restrictions ?? []).filter(
    (r) =>
      (kind === 'business' ? BIC_RESTRICTIONS : UIC_RESTRICTIONS).has(r.type) &&
      (!r.expiresAt || r.expiresAt.getTime() > now.getTime()),
  );
