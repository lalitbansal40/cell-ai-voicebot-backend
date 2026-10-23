import type { NotificationType } from '../../db/models/notification.model';

/** Who gets a Phase 11 bell (the template's creator is added for template types). */
export type TemplateNotifyAudience = 'template_managers' | 'billing_admins';

export interface TemplateNotificationSpec {
  title: string;
  audience: TemplateNotifyAudience;
  /** Also e-mailed (plain text: template name + reason, never customer data). */
  email: boolean;
  /** In-app link; template types get `?id=<templateId>`. */
  link: (templateId?: string) => string;
}

const templateLink = (templateId?: string) =>
  templateId ? `/whatsapp/templates?id=${templateId}` : '/whatsapp/templates';

/** The 7 Phase 11 notification types (PHASE_11_PROMPT §1). Bodies carry name / language / reason only. */
export const TEMPLATE_NOTIFICATIONS = {
  'template.approved': {
    title: 'Template approved',
    audience: 'template_managers',
    email: false,
    link: templateLink,
  },
  'template.rejected': {
    title: 'Template rejected',
    audience: 'template_managers',
    email: true,
    link: templateLink,
  },
  'template.paused': {
    title: 'Template paused',
    audience: 'template_managers',
    email: false,
    link: templateLink,
  },
  'template.disabled': {
    title: 'Template disabled',
    audience: 'template_managers',
    email: true,
    link: templateLink,
  },
  'template.category_changed': {
    title: 'Template category changed',
    audience: 'template_managers',
    email: false,
    link: templateLink,
  },
  'template.quality_low': {
    title: 'Template quality is low',
    audience: 'template_managers',
    email: false,
    link: templateLink,
  },
  'wallet.whatsapp_late_charge': {
    title: 'WhatsApp message charged late',
    audience: 'billing_admins',
    email: false,
    link: () => '/wallet',
  },
} as const satisfies Partial<Record<NotificationType, TemplateNotificationSpec>>;

export type TemplateNotificationType = keyof typeof TEMPLATE_NOTIFICATIONS;

/** E-mail subjects (the existing email templates pattern). */
export const TEMPLATE_EMAIL_SUBJECTS = {
  'template.rejected': 'Your WhatsApp template was rejected',
  'template.disabled': 'Your WhatsApp template was disabled',
} as const;
