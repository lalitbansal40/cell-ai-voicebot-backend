import { escapeHtml } from './escape';
import { APP_NAME, renderLayout, renderTextLayout } from './layout';
import type { RenderedEmail } from './types';

/** Escaped call-to-action button (table-based, inline CSS). */
export const buttonHtml = (url: string, label: string): string =>
  `<p style="margin:24px 0;"><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 20px;background:#1d4ed8;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold;">${escapeHtml(label)}</a></p><p style="font-size:12px;color:#6b7280;">Or open this link: ${escapeHtml(url)}</p>`;

const render = (subject: string, bodyHtml: string, text: string): RenderedEmail => ({
  subject,
  html: renderLayout({ title: subject, bodyHtml }),
  text: renderTextLayout(text),
});

export interface VerifyEmailVars {
  name: string;
  code: string;
  minutes: number;
}

/** Signup OTP (`auth.verify_email`). */
export const verifyEmail = ({ name, code, minutes }: VerifyEmailVars): RenderedEmail =>
  render(
    `${code} is your ${APP_NAME} verification code`,
    `<p>Hi ${escapeHtml(name)},</p><p>Use this code to verify your email address:</p><p style="font-size:32px;letter-spacing:8px;font-family:monospace;font-weight:bold;margin:24px 0;">${escapeHtml(code)}</p><p>The code expires in ${minutes} minutes. If you did not sign up, you can ignore this email.</p>`,
    `Hi ${name},\n\nYour verification code: ${code}\n\nIt expires in ${minutes} minutes. If you did not sign up, you can ignore this email.`,
  );

export interface AccountExistsVars {
  name: string;
  loginUrl: string;
  resetUrl: string;
}

/** Someone tried to sign up with an email that already has an account (`auth.account_exists`). */
export const accountExists = ({ name, loginUrl, resetUrl }: AccountExistsVars): RenderedEmail =>
  render(
    `You already have a ${APP_NAME} account`,
    `<p>Hi ${escapeHtml(name)},</p><p>Someone tried to create a new account with this email address, but you already have one.</p>${buttonHtml(loginUrl, 'Sign in')}<p>Forgot your password? <a href="${escapeHtml(resetUrl)}">Reset it here</a>.</p><p>If this wasn't you, no action is needed.</p>`,
    `Hi ${name},\n\nSomeone tried to create a new account with this email address, but you already have one.\n\nSign in: ${loginUrl}\nForgot your password? ${resetUrl}\n\nIf this wasn't you, no action is needed.`,
  );

export interface ResetPasswordVars {
  name: string;
  resetUrl: string;
  minutes: number;
}

/** Password reset link (`auth.reset_password`). */
export const resetPassword = ({ name, resetUrl, minutes }: ResetPasswordVars): RenderedEmail =>
  render(
    `Reset your ${APP_NAME} password`,
    `<p>Hi ${escapeHtml(name)},</p><p>We received a request to reset your password.</p>${buttonHtml(resetUrl, 'Reset password')}<p>The link expires in ${minutes} minutes and can be used once. If you did not ask for this, ignore this email — your password stays the same.</p>`,
    `Hi ${name},\n\nReset your password: ${resetUrl}\n\nThe link expires in ${minutes} minutes and can be used once. If you did not ask for this, ignore this email.`,
  );

export interface PasswordChangedVars {
  name: string;
  at: string;
  resetUrl: string;
}

/** Security notice after a reset / change (`auth.password_changed`). */
export const passwordChanged = ({ name, at, resetUrl }: PasswordChangedVars): RenderedEmail =>
  render(
    `Your ${APP_NAME} password was changed`,
    `<p>Hi ${escapeHtml(name)},</p><p>Your password was changed on ${escapeHtml(at)} and you were signed out of your other sessions.</p><p>If this wasn't you, <a href="${escapeHtml(resetUrl)}">reset your password</a> right away and contact your account owner.</p>`,
    `Hi ${name},\n\nYour password was changed on ${at} and you were signed out of your other sessions.\n\nIf this wasn't you, reset your password right away: ${resetUrl}`,
  );
