import { buttonHtml } from './auth';
import { escapeHtml } from './escape';
import { renderLayout, renderTextLayout } from './layout';
import type { RenderedEmail } from './types';

export interface ReportDigestVars {
  /** Queue metadata only; never rendered. Re-check access at actual delivery. */
  subscriptionId: string;
  accountName: string;
  /** "Yesterday (26 Oct 2026)", "Last week (19–25 Oct 2026)". */
  periodLabel: string;
  /** Numbers only (already formatted) — never names, phones or texts. */
  sections: { title: string; rows: { label: string; value: string; previous: string }[] }[];
  reportUrl: string;
  /** The page with the "stop" button (web app). */
  unsubscribeUrl: string;
  /** One-click stop for mail apps (`List-Unsubscribe`, RFC 8058): the API, POST. */
  oneClickUrl: string;
}

/** The e-mailed report (`reports.digest`): KPI tables against the period before. */
export const reportDigest = ({
  accountName,
  periodLabel,
  sections,
  reportUrl,
  unsubscribeUrl,
  oneClickUrl,
}: ReportDigestVars): RenderedEmail => {
  const subject = `${accountName}: report for ${periodLabel}`;
  const tables = sections
    .map(
      (s) =>
        `<h3 style="margin:16px 0 8px;font-size:15px;">${escapeHtml(s.title)}</h3><table role="presentation" cellspacing="0" cellpadding="4" style="border-collapse:collapse;width:100%;font-size:14px;"><tr><th align="left">Metric</th><th align="right">This period</th><th align="right">Before</th></tr>${s.rows
          .map(
            (r) =>
              `<tr><td>${escapeHtml(r.label)}</td><td align="right"><strong>${escapeHtml(r.value)}</strong></td><td align="right">${escapeHtml(r.previous)}</td></tr>`,
          )
          .join('')}</table>`,
    )
    .join('');
  const text = sections
    .map(
      (s) =>
        `${s.title}\n${s.rows.map((r) => `- ${r.label}: ${r.value} (before: ${r.previous})`).join('\n')}`,
    )
    .join('\n\n');
  return {
    subject,
    html: renderLayout({
      title: subject,
      bodyHtml: `<p>${escapeHtml(`Your ${periodLabel.toLowerCase()} numbers for ${accountName}.`)}</p>${tables}${buttonHtml(reportUrl, 'Open the report')}<p style="font-size:12px;color:#6b7280;">You get this because you asked for it in Settings. <a href="${escapeHtml(unsubscribeUrl)}">Stop these e-mails</a>.</p>`,
    }),
    headers: {
      'List-Unsubscribe': `<${oneClickUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    text: renderTextLayout(
      `Your ${periodLabel.toLowerCase()} numbers for ${accountName}.\n\n${text}\n\nOpen the report: ${reportUrl}\n\nStop these e-mails: ${unsubscribeUrl}`,
    ),
  };
};
