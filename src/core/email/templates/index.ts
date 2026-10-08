import { systemTest, type SystemTestVars } from './system-test';
import type { RenderedEmail } from './types';

export { escapeHtml } from './escape';
export { APP_NAME, renderLayout, renderTextLayout } from './layout';
export type { RenderedEmail } from './types';

/**
 * Template key → variables. Add a template: create `<name>.ts`, add it here
 * and to TEMPLATES. Phase 2: `auth.verify_email`, `auth.reset_password`,
 * `team.invite`; Phase 4: `wallet.receipt`, `wallet.low_balance`.
 */
export interface EmailTemplateVars {
  'system.test': SystemTestVars;
}

export type EmailTemplateKey = keyof EmailTemplateVars;

const TEMPLATES: { [K in EmailTemplateKey]: (vars: EmailTemplateVars[K]) => RenderedEmail } = {
  'system.test': systemTest,
};

export const isEmailTemplateKey = (key: string): key is EmailTemplateKey =>
  Object.hasOwn(TEMPLATES, key);

export const renderTemplate = <K extends EmailTemplateKey>(
  key: K,
  vars: EmailTemplateVars[K],
): RenderedEmail => TEMPLATES[key](vars);
