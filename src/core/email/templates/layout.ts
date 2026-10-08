import { escapeHtml } from './escape';

export const APP_NAME = 'Cell AI Voicebot';

/**
 * Shared HTML shell: table layout + inline CSS (email clients ignore <style>
 * and flexbox). `bodyHtml` must already be escaped by the template.
 */
export const renderLayout = ({ title, bodyHtml }: { title: string; bodyHtml: string }): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f5f7;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;">
<tr><td style="padding:24px 32px;border-bottom:1px solid #e5e7eb;font-size:18px;font-weight:bold;">${escapeHtml(APP_NAME)}</td></tr>
<tr><td style="padding:32px;font-size:15px;line-height:1.6;">${bodyHtml}</td></tr>
<tr><td style="padding:16px 32px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;">You received this email because of activity on your ${escapeHtml(APP_NAME)} account.</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

/** Plain-text counterpart (always sent alongside HTML). */
export const renderTextLayout = (body: string): string =>
  `${APP_NAME}\n\n${body}\n\n--\nYou received this email because of activity on your ${APP_NAME} account.\n`;
