import {
  accountExists,
  passwordChanged,
  resetPassword,
  verifyEmail,
  type AccountExistsVars,
  type PasswordChangedVars,
  type ResetPasswordVars,
  type VerifyEmailVars,
} from './auth';
import { campaignPaused, type CampaignPausedVars } from './campaign';
import { systemTest, type SystemTestVars } from './system-test';
import { teamInvite, type TeamInviteVars } from './team';
import type { RenderedEmail } from './types';
import {
  walletLowBalance,
  walletReceipt,
  type WalletLowBalanceVars,
  type WalletReceiptVars,
} from './wallet';
import {
  whatsappAdminDisconnected,
  whatsappNeedsReconnect,
  whatsappRestricted,
  type WhatsAppChannelEmailVars,
} from './whatsapp';

export { escapeHtml } from './escape';
export { APP_NAME, renderLayout, renderTextLayout } from './layout';
export type { RenderedEmail } from './types';

/**
 * Template key → variables. Add a template: create `<name>.ts`, add it here
 * and to TEMPLATES.
 */
export interface EmailTemplateVars {
  'system.test': SystemTestVars;
  'auth.verify_email': VerifyEmailVars;
  'auth.account_exists': AccountExistsVars;
  'auth.reset_password': ResetPasswordVars;
  'auth.password_changed': PasswordChangedVars;
  'team.invite': TeamInviteVars;
  'wallet.low_balance': WalletLowBalanceVars;
  'wallet.receipt': WalletReceiptVars;
  'campaign.paused': CampaignPausedVars;
  'whatsapp.needs_reconnect': WhatsAppChannelEmailVars;
  'whatsapp.restricted': WhatsAppChannelEmailVars;
  'whatsapp.admin_disconnected': WhatsAppChannelEmailVars;
}

export type EmailTemplateKey = keyof EmailTemplateVars;

const TEMPLATES: { [K in EmailTemplateKey]: (vars: EmailTemplateVars[K]) => RenderedEmail } = {
  'system.test': systemTest,
  'auth.verify_email': verifyEmail,
  'auth.account_exists': accountExists,
  'auth.reset_password': resetPassword,
  'auth.password_changed': passwordChanged,
  'team.invite': teamInvite,
  'wallet.low_balance': walletLowBalance,
  'wallet.receipt': walletReceipt,
  'campaign.paused': campaignPaused,
  'whatsapp.needs_reconnect': whatsappNeedsReconnect,
  'whatsapp.restricted': whatsappRestricted,
  'whatsapp.admin_disconnected': whatsappAdminDisconnected,
};

export const isEmailTemplateKey = (key: string): key is EmailTemplateKey =>
  Object.hasOwn(TEMPLATES, key);

export const renderTemplate = <K extends EmailTemplateKey>(
  key: K,
  vars: EmailTemplateVars[K],
): RenderedEmail => TEMPLATES[key](vars);
