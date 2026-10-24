import type { WhatsAppChannelDoc } from '../../db/models/whatsapp-channel.model';
import { callingSummary } from '../whatsapp-calling/json';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const idOf = (v: { toString(): string } | null | undefined) => (v ? v.toString() : null);

/** Per-field webhook counts of the last 24 h (detail view). */
export interface ChannelEvents24h {
  total: number;
  byField: Record<string, number>;
}

/** List item — never tokens, PINs or Meta payloads. */
export const channelListItem = (c: WhatsAppChannelDoc) => ({
  id: c._id.toString(),
  label: c.label,
  provider: c.provider,
  mode: c.mode,
  status: c.status,
  statusReason: c.statusReason
    ? {
        code: c.statusReason.code,
        message: c.statusReason.message,
        step: c.statusReason.step ?? null,
      }
    : null,
  wabaId: c.wabaId,
  wabaName: c.wabaName,
  businessName: c.businessName,
  phoneNumberId: c.phoneNumberId,
  displayPhoneNumber: c.displayPhoneNumber,
  phoneE164: c.phoneE164,
  verifiedName: c.verifiedName,
  nameStatus: c.nameStatus,
  newNameStatus: c.newNameStatus,
  qualityRating: c.qualityRating,
  messagingLimitTier: c.messagingLimitTier,
  isOnBizApp: c.isOnBizApp,
  /** Phase 12: WhatsApp calling on this number (settings: `/whatsapp/channels/:id/calling`). */
  calling: callingSummary(c),
  billing: {
    metaPayer: c.metaPayer,
    creditLine: { status: c.creditLine.status },
    paymentMethodOk: c.paymentMethodOk,
  },
  coexistence:
    c.mode === 'coexistence'
      ? {
          contactsSync: c.coexistence.contactsSync,
          historySync: c.coexistence.historySync,
          historyProgress: c.coexistence.historyProgress,
          echoesAt: iso(c.coexistence.echoesAt),
        }
      : null,
  registration: { status: c.registration.status },
  subscription: { status: c.subscription.status },
  restriction: c.restriction ? { type: c.restriction.type, until: iso(c.restriction.until) } : null,
  webhook: { lastEventAt: iso(c.webhook.lastEventAt), lastField: c.webhook.lastField },
  connectedBy: idOf(c.connectedBy),
  connectedAt: iso(c.connectedAt),
  syncedAt: iso(c.syncedAt),
  disconnectedAt: iso(c.disconnectedAt),
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});
export type ChannelListItem = ReturnType<typeof channelListItem>;

/** Detail drawer: ids, Meta statuses, token check, webhook health, history. */
export const channelDetail = (c: WhatsAppChannelDoc, events24h: ChannelEvents24h) => ({
  ...channelListItem(c),
  businessId: c.businessId,
  wabaCurrency: c.wabaCurrency,
  wabaTimezoneId: c.wabaTimezoneId,
  wabaReviewStatus: c.wabaReviewStatus,
  businessVerificationStatus: c.businessVerificationStatus,
  throughputLevel: c.throughputLevel,
  accountMode: c.accountMode,
  platformType: c.platformType,
  codeVerificationStatus: c.codeVerificationStatus,
  phoneStatus: c.phoneStatus,
  isOfficialBusinessAccount: c.isOfficialBusinessAccount,
  tokenCheckedAt: iso(c.tokenCheckedAt),
  tokenExpiresAt: iso(c.tokenExpiresAt),
  capabilities: c.capabilities,
  disconnectedBy: idOf(c.disconnectedBy),
  events24h,
  history: [...c.history]
    .reverse()
    .map((h) => ({ status: h.status, reason: h.reason, at: h.at.toISOString(), by: idOf(h.by) })),
});
export type ChannelDetail = ReturnType<typeof channelDetail>;

/** `whatsapp.channel.updated` WS payload. */
export const channelEvent = (c: WhatsAppChannelDoc) => ({
  channelId: c._id.toString(),
  status: c.status,
  qualityRating: c.qualityRating,
  messagingLimitTier: c.messagingLimitTier,
  nameStatus: c.nameStatus,
  calling: callingSummary(c),
});
