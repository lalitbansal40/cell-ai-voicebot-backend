import type { Types } from 'mongoose';

import { getEmail } from '../../core/email';
import { notifyAccount } from '../../core/realtime/notify';
import { AccountModel } from '../../db/models/account.model';
import { UserModel } from '../../db/models/user.model';
import type { WhatsAppTemplateDoc } from '../../db/models/whatsapp-template.model';
import { getLogger } from '../../shared/logger';
import type { AuditAction } from '../audit/audit-actions';
import { recordAudit } from '../audit/audit.service';
import { notify, usersWithPermission } from '../notifications/notifications.service';
import type { WaActor } from '../whatsapp/channel-status';

import type { TemplateContext } from './context';
import { TEMPLATE_NOTIFICATIONS, type TemplateNotificationType } from './notification-types';
import { templateEvent } from './template-json';

/** Meta reason codes → our words (bells, e-mails, the detail page). */
export const REASON_TEXT: Record<string, string> = {
  ABUSIVE_CONTENT: 'the content was reported as abusive',
  CATEGORY_NOT_AVAILABLE: 'the category is not available',
  INCORRECT_CATEGORY: 'the category does not match the content',
  INVALID_FORMAT: 'the format is not valid (check variables and examples)',
  PROMOTIONAL: 'promotional content is not allowed in this category',
  SCAM: 'the content looks like a scam',
  TAG_CONTENT_MISMATCH: 'the content does not match the category',
  FIRST_PAUSE: 'paused for 3 hours because customers reported low quality',
  SECOND_PAUSE: 'paused for 6 hours because customers reported low quality again',
  RATE_LIMITING_PAUSE: 'paused because too many customers blocked or reported it',
  DISABLED: 'disabled after repeated low quality',
};

export const reasonText = (code: string | null | undefined): string =>
  (code && REASON_TEXT[code]) ?? (code && code !== 'NONE' ? code.toLowerCase() : 'no reason given');

const label = (t: Pick<WhatsAppTemplateDoc, 'name' | 'language'>) => `${t.name} (${t.language})`;

/** `whatsapp.template.updated` to the account (fire and forget). */
export const emitTemplateUpdated = (t: WhatsAppTemplateDoc): void => {
  notifyAccount(t.accountId.toString(), 'whatsapp.template.updated', templateEvent(t));
};

/** Audit with template name / language / category / status only (never text or samples). */
export const auditTemplate = (
  t: Pick<WhatsAppTemplateDoc, '_id' | 'accountId' | 'name' | 'language' | 'category' | 'status'>,
  action: AuditAction,
  actor: WaActor,
  meta: Record<string, unknown> = {},
): Promise<void> =>
  recordAudit({
    accountId: t.accountId,
    actor: {
      type: actor.type,
      id: actor.id,
      impersonatorId: actor.impersonatorId ?? null,
      platform: actor.platform ?? false,
    },
    action,
    target: { type: 'whatsapp_template', id: t._id.toString() },
    meta: { name: t.name, language: t.language, category: t.category, status: t.status, ...meta },
    ip: actor.ip ?? null,
  });

/** Template managers (`templates.manage`) + the template's creator, once each. */
const recipients = async (t: WhatsAppTemplateDoc) => {
  const managers = await usersWithPermission(t.accountId, 'templates.manage');
  const all = new Map(managers.map((m) => [m.userId.toString(), m] as const));
  if (t.createdBy && !all.has(t.createdBy.toString())) {
    const creator = await UserModel.findOne({
      _id: t.createdBy,
      accountId: t.accountId,
      status: 'active',
    })
      .select({ email: 1, name: 1 })
      .lean<{ _id: Types.ObjectId; email: string; name: string }>();
    if (creator) {
      all.set(creator._id.toString(), {
        userId: creator._id,
        email: creator.email,
        name: creator.name,
      });
    }
  }
  return [...all.values()];
};

const EMAIL_FOR: Partial<
  Record<TemplateNotificationType, 'template.rejected' | 'template.disabled'>
> = { 'template.rejected': 'template.rejected', 'template.disabled': 'template.disabled' };

/**
 * Bell for a template event (name / language / reason in plain words — no template
 * text) and, for rejected / disabled, an e-mail once per event. Never throws.
 */
export const notifyTemplate = async (
  tx: Pick<TemplateContext, 'wa'>,
  t: WhatsAppTemplateDoc,
  type: Exclude<TemplateNotificationType, 'wallet.whatsapp_late_charge'>,
  detail: string | null,
  eventKey: string,
): Promise<void> => {
  try {
    const spec = TEMPLATE_NOTIFICATIONS[type];
    const users = await recipients(t);
    if (!users.length) return;
    const body = detail ? `${label(t)}: ${detail}` : label(t);
    await notify({
      accountId: t.accountId,
      userIds: users.map((u) => u.userId),
      type,
      title: spec.title,
      body,
      link: spec.link(t._id.toString()),
    });
    const template = EMAIL_FOR[type];
    if (!template) return;
    const account = await AccountModel.findById(t.accountId)
      .select({ name: 1 })
      .lean<{ name: string }>();
    const vars = {
      accountName: account?.name ?? 'Your account',
      templateName: t.name,
      language: t.language,
      reason: detail ?? 'no reason given',
      templatesUrl: `${tx.wa.env.FRONTEND_URL.replace(/\/+$/, '')}${spec.link(t._id.toString())}`,
    };
    for (const u of users) {
      await getEmail().enqueue(template, u.email, vars, {
        dedupeKey: `tpl-${type}-${t._id.toString()}-${eventKey}-${u.userId.toString()}`,
      });
    }
  } catch (err) {
    getLogger().error(
      { errName: (err as Error).name, type, templateId: t._id.toString() },
      'templates: notification failed',
    );
  }
};
