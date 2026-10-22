import { FAKE_CREDIT_LINE_ID, isMetaApiError, type MetaWaba } from '../../core/meta';
import type { WaStatusReason, WhatsAppChannelDoc } from '../../db/models/whatsapp-channel.model';
import { getLogger } from '../../shared/logger';

import { nowOf, type WhatsAppContext } from './context';

/** Currencies Meta's credit sharing supports. */
export const CREDIT_LINE_CURRENCIES = ['AUD', 'EUR', 'GBP', 'IDR', 'INR', 'USD'] as const;

export interface BillingResult {
  patch: Pick<Partial<WhatsAppChannelDoc>, 'creditLine' | 'paymentMethodOk'>;
  fail?: WaStatusReason;
  /** The credit line was attached in this run (audit `whatsapp.credit_line_attached`). */
  attached: boolean;
}

const failed = (
  channel: WhatsAppChannelDoc,
  code: string,
  message: string,
  error: string,
): BillingResult => ({
  patch: { creditLine: { ...channel.creditLine, status: 'failed', error: error.slice(0, 300) } },
  fail: { code, message: message.slice(0, 300), step: 'billing' },
  attached: false,
});

/**
 * Who pays Meta (account setting, copied to the channel at connect):
 * - `platform`: our System User joins the WABA, then our credit line is attached
 *   (`whatsapp_credit_sharing_and_attach`); any problem → `action_needed`.
 * - `customer`: nothing to attach — `paymentMethodOk` follows the WABA's funding source.
 * Token errors (`tokenInvalid`) are rethrown (the caller marks the channel).
 */
export const setupBilling = async (
  ctx: WhatsAppContext,
  channel: WhatsAppChannelDoc,
  token: string,
  waba: MetaWaba,
): Promise<BillingResult> => {
  if (channel.metaPayer === 'customer') {
    return {
      patch: {
        creditLine: { status: 'not_needed', allocationConfigId: null, error: null, at: null },
        paymentMethodOk: Boolean(waba.primaryFundingId),
      },
      attached: false,
    };
  }
  if (channel.creditLine.status === 'attached') return { patch: {}, attached: false };
  const fake = ctx.meta.provider === 'fake';
  const systemToken = fake ? 'fake-system-user-token' : ctx.env.META_SYSTEM_USER_TOKEN;
  if (!fake && (!ctx.env.META_CREDIT_LINE_ID || !systemToken)) {
    return failed(
      channel,
      'credit_line_not_configured',
      "Platform credit line isn't configured on this server.",
      'not_configured',
    );
  }
  const currency = waba.currency ?? '';
  if (!(CREDIT_LINE_CURRENCIES as readonly string[]).includes(currency)) {
    return failed(
      channel,
      'unsupported_currency',
      `Couldn't attach the platform credit line: the WhatsApp account currency (${currency || 'unknown'}) isn't supported — use ${CREDIT_LINE_CURRENCIES.join(', ')} or switch this account to "customer pays Meta".`,
      `unsupported currency ${currency}`,
    );
  }
  try {
    const ownerId = await ctx.meta.getTokenOwner(systemToken ?? '');
    await ctx.meta.assignSystemUser(token, channel.wabaId, ownerId);
    const { allocationConfigId } = await ctx.meta.attachCreditLine(channel.wabaId, currency);
    try {
      await ctx.meta.getAllocation(allocationConfigId);
    } catch (err) {
      // optional check — the attach already succeeded
      getLogger().warn(
        { channelId: channel._id.toString(), code: isMetaApiError(err) ? err.code : null },
        'whatsapp: credit line allocation check failed',
      );
    }
    return {
      patch: {
        creditLine: { status: 'attached', allocationConfigId, error: null, at: nowOf(ctx) },
        paymentMethodOk: null,
      },
      attached: true,
    };
  } catch (err) {
    if (!isMetaApiError(err) || err.tokenInvalid) throw err;
    return failed(
      channel,
      'credit_line_failed',
      `Couldn't attach the platform credit line: ${err.message}`,
      err.message,
    );
  }
};

/** The credit line id shown to superadmins (fake provider: `fake_ecl_1`). */
export const creditLineIdOf = (ctx: WhatsAppContext): string | null =>
  ctx.meta.provider === 'fake' ? FAKE_CREDIT_LINE_ID : (ctx.env.META_CREDIT_LINE_ID ?? null);
