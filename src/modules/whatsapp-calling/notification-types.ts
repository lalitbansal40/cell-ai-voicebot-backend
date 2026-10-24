import type { NotificationType } from '../../db/models/notification.model';

/**
 * Who gets a Phase 12 bell: the users the call rang for, the user who asked for
 * the permission (+ managers), or the owners / admins of the account.
 */
export type CallingNotifyAudience =
  'ring_list' | 'requester' | 'requester_and_managers' | 'owners_admins';

export interface CallingNotificationSpec {
  title: string;
  audience: CallingNotifyAudience;
  /** Also e-mailed (plain text: the number label + reason, never customer data). */
  email: boolean;
  /** In-app link; chat types get the conversation id. */
  link: (conversationId?: string) => string;
}

const chatLink = (conversationId?: string) =>
  conversationId ? `/inbox/${conversationId}` : '/inbox';

/**
 * The 5 Phase 12 notification types (PHASE_12_PROMPT §1). Titles and bodies name the
 * customer only as "a customer" and the number by its label.
 */
export const CALLING_NOTIFICATIONS = {
  'call.whatsapp_missed': {
    title: 'Missed WhatsApp call',
    audience: 'ring_list',
    email: false,
    link: chatLink,
  },
  'whatsapp.call_permission_granted': {
    title: 'A customer allowed WhatsApp calls',
    audience: 'requester',
    email: false,
    link: chatLink,
  },
  'whatsapp.call_permission_declined': {
    title: 'A customer declined WhatsApp calls',
    audience: 'requester',
    email: false,
    link: chatLink,
  },
  'whatsapp.calling_restricted': {
    title: 'WhatsApp paused calling on a number',
    audience: 'owners_admins',
    email: true,
    link: () => '/whatsapp/numbers',
  },
  'whatsapp.call_permission_revoked': {
    title: 'Call permission removed after unanswered calls',
    audience: 'requester_and_managers',
    email: false,
    link: chatLink,
  },
} as const satisfies Partial<Record<NotificationType, CallingNotificationSpec>>;

export type CallingNotificationType = keyof typeof CALLING_NOTIFICATIONS;

/** E-mail subjects (the existing email templates pattern). */
export const CALLING_EMAIL_SUBJECTS = {
  'whatsapp.calling_restricted': 'WhatsApp paused calling on your number',
} as const;
