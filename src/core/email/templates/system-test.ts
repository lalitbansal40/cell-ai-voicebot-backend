import { escapeHtml } from './escape';
import { renderLayout, renderTextLayout } from './layout';
import type { RenderedEmail } from './types';

export interface SystemTestVars {
  name: string;
}

/** Smoke-test email (`npm run email:test`). */
export const systemTest = ({ name }: SystemTestVars): RenderedEmail => {
  const subject = 'Test email from Cell AI Voicebot';
  return {
    subject,
    html: renderLayout({
      title: subject,
      bodyHtml: `<p>Hi ${escapeHtml(name)},</p><p>This is a test email. If you can read it, email delivery works.</p>`,
    }),
    text: renderTextLayout(
      `Hi ${name},\n\nThis is a test email. If you can read it, email delivery works.`,
    ),
  };
};
