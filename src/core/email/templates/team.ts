import { buttonHtml } from './auth';
import { escapeHtml } from './escape';
import { APP_NAME, renderLayout, renderTextLayout } from './layout';
import type { RenderedEmail } from './types';

export interface TeamInviteVars {
  inviterName: string;
  accountName: string;
  roleName: string;
  acceptUrl: string;
  days: number;
}

/** Team invitation (`team.invite`). The link is single use and expires. */
export const teamInvite = ({
  inviterName,
  accountName,
  roleName,
  acceptUrl,
  days,
}: TeamInviteVars): RenderedEmail => {
  const subject = `You're invited to ${accountName} on ${APP_NAME}`;
  return {
    subject,
    html: renderLayout({
      title: subject,
      bodyHtml: `<p>${escapeHtml(inviterName)} invited you to join <strong>${escapeHtml(accountName)}</strong> as <strong>${escapeHtml(roleName)}</strong>.</p>${buttonHtml(acceptUrl, 'Accept invitation')}<p>The invitation expires in ${days} days. If you weren't expecting it, you can ignore this email.</p>`,
    }),
    text: renderTextLayout(
      `${inviterName} invited you to join ${accountName} as ${roleName}.\n\nAccept: ${acceptUrl}\n\nThe invitation expires in ${days} days. If you weren't expecting it, you can ignore this email.`,
    ),
  };
};
