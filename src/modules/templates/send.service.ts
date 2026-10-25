import { Types } from 'mongoose';

import { TEMPLATE_LIMITS } from '../../config/limits';
import {
  buildTemplatePayload,
  type MetaMessagePayload,
  type TemplateButtonParam,
  type TemplateHeaderParam,
} from '../../core/meta';
import type { ContactDoc } from '../../db/models/contact.model';
import { CustomFieldModel, type FieldType } from '../../db/models/custom-field.model';
import { MessageModel, type MessageDoc } from '../../db/models/message.model';
import type { WhatsAppChannelDoc } from '../../db/models/whatsapp-channel.model';
import {
  SENDABLE_TEMPLATE_STATUSES,
  WhatsAppTemplateModel,
  type TemplateVariable,
  type WhatsAppTemplateDoc,
} from '../../db/models/whatsapp-template.model';
import { AppError } from '../../shared/errors/app-error';

import { componentOf, headerFormat } from './components';
import { formatPhone, formatVariableValue } from './format';
import { headerKey, renderText } from './variables';

/** The header kinds a template send may need (media / location come with the request). */
export type TemplateHeaderKind = 'none' | 'text' | 'image' | 'video' | 'document' | 'location';

export interface PreparedTemplate {
  template: WhatsAppTemplateDoc;
  /** Resolved values (customer data — never logged). */
  parameters: { key: string; value: string }[];
  /** Header + body + footer with the values, for the bubble / search / preview. */
  text: string;
  headerKind: TemplateHeaderKind;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Header / button values: one line (Meta rejects new lines and tabs there). */
const oneLine = (v: string) =>
  v
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();

/** Loads a template the channel may send now (same WABA, approved / flagged, not paused). */
export const loadSendableTemplate = async (
  accountId: Types.ObjectId,
  channel: Pick<WhatsAppChannelDoc, 'wabaId'>,
  templateId: string,
  now: Date,
): Promise<WhatsAppTemplateDoc> => {
  if (!Types.ObjectId.isValid(templateId)) throw new AppError('TEMPLATE_NOT_FOUND');
  const t = await WhatsAppTemplateModel.findOne({
    _id: templateId,
    accountId,
  }).lean<WhatsAppTemplateDoc>();
  if (!t || t.status === 'DELETED' || t.wabaId !== channel.wabaId || !t.metaTemplateId) {
    throw new AppError('TEMPLATE_NOT_FOUND');
  }
  if (t.status === 'PAUSED' || (t.pausedUntil && t.pausedUntil > now)) {
    throw new AppError('TEMPLATE_PAUSED', undefined, [
      {
        path: 'pausedUntil',
        message: t.pausedUntil ? t.pausedUntil.toISOString() : 'Paused by WhatsApp',
      },
    ]);
  }
  if (!SENDABLE_TEMPLATE_STATUSES.includes(t.status)) {
    throw new AppError('TEMPLATE_NOT_APPROVED', undefined, [
      { path: 'status', message: `The template is ${t.status.toLowerCase()}` },
    ]);
  }
  return t;
};

/** A variable's value from its source (`ask` / missing → null). */
const fromSource = (
  v: TemplateVariable,
  contact: Pick<ContactDoc, 'name' | 'phoneE164' | 'email' | 'variables' | 'accountId'>,
  fieldTypes: Map<string, FieldType>,
): string | null => {
  const s = v.defaultSource;
  switch (s.kind) {
    case 'contact.name':
      return contact.name?.trim() || null;
    case 'contact.phone':
      return formatPhone(contact.phoneE164);
    case 'contact.email':
      return contact.email ?? null;
    case 'static':
      return s.value?.trim() || null;
    case 'field': {
      const key = s.value ?? '';
      const raw =
        contact.variables instanceof Map
          ? contact.variables.get(key)
          : (contact.variables as unknown as Record<string, unknown> | undefined)?.[key];
      return formatVariableValue(
        fieldTypes.get(key) ?? 'text',
        raw as string | number | null | undefined,
      );
    }
    case 'ask':
      return null;
  }
};

/**
 * Values for every variable: an explicit value from the request wins, else the
 * remembered source. Missing → 422 `TEMPLATE_VARIABLES_MISSING` (keys only, never values).
 */
export const prepareTemplateSend = async (input: {
  template: WhatsAppTemplateDoc;
  contact: Pick<ContactDoc, 'name' | 'phoneE164' | 'email' | 'variables' | 'accountId'>;
  variables?: Record<string, string> | undefined;
}): Promise<PreparedTemplate> => {
  const { template: t, contact } = input;
  const fieldKeys = t.variables
    .filter((v) => v.defaultSource.kind === 'field' && v.defaultSource.value)
    .map((v) => v.defaultSource.value ?? '');
  const fieldTypes = new Map(
    fieldKeys.length
      ? (
          await CustomFieldModel.find({ accountId: contact.accountId, key: { $in: fieldKeys } })
            .select({ key: 1, type: 1 })
            .lean<{ key: string; type: FieldType }[]>()
        ).map((f) => [f.key, f.type] as const)
      : [],
  );
  const missing: string[] = [];
  const tooLong: string[] = [];
  const parameters: { key: string; value: string }[] = [];
  for (const v of t.variables) {
    const given = input.variables?.[v.key];
    let value = given !== undefined ? given.trim() : fromSource(v, contact, fieldTypes);
    if (value && v.component !== 'body') value = oneLine(value);
    if (!value) {
      missing.push(v.key);
      continue;
    }
    const max = v.key.startsWith('copy_code_')
      ? TEMPLATE_LIMITS.copyCodeExampleMax
      : TEMPLATE_LIMITS.variableValueMax;
    if (value.length > max) tooLong.push(v.key);
    parameters.push({ key: v.key, value });
  }
  if (missing.length) {
    throw new AppError(
      'TEMPLATE_VARIABLES_MISSING',
      undefined,
      missing.map((key) => ({ path: key, message: 'Missing value' })),
    );
  }
  if (tooLong.length) {
    throw new AppError(
      'TEMPLATE_PARAMS_INVALID',
      undefined,
      tooLong.map((key) => ({ path: key, message: 'Too long' })),
    );
  }
  const values = new Map(parameters.map((p) => [p.key, p.value]));
  const header = componentOf(t.components, 'HEADER');
  const format = headerFormat(t.components);
  const parts = [
    format === 'TEXT'
      ? renderText(str(header?.text), values, (raw) => headerKey(raw, t.parameterFormat))
      : '',
    renderText(str(componentOf(t.components, 'BODY')?.text), values),
    str(componentOf(t.components, 'FOOTER')?.text),
  ].filter(Boolean);
  const headerKind: TemplateHeaderKind =
    format === 'TEXT'
      ? 'text'
      : format === 'IMAGE' || format === 'VIDEO' || format === 'DOCUMENT' || format === 'LOCATION'
        ? (format.toLowerCase() as TemplateHeaderKind)
        : 'none';
  return {
    template: t,
    parameters,
    text: parts.join('\n\n').slice(0, 4096),
    headerKind,
  };
};

/** Quick reply payloads come back as `button` messages (the inbox shows them). */
export const quickReplyPayload = (templateId: Types.ObjectId | string, index: number) =>
  `qr_${templateId.toString()}_${String(index)}`;

/**
 * The stored template message → Meta's payload (send job). `media` = the uploaded
 * Meta media id of a media header; the location comes from the message.
 */
export const templatePayloadFor = (
  t: WhatsAppTemplateDoc,
  m: Pick<MessageDoc, 'template' | 'location' | 'media'>,
  to: string,
  mediaId: string | null,
): MetaMessagePayload => {
  const values = new Map((m.template?.parameters ?? []).map((p) => [p.key, p.value]));
  const format = headerFormat(t.components);
  let header: TemplateHeaderParam | null = null;
  if (format === 'TEXT') {
    const v = t.variables.find((x) => x.component === 'header');
    if (v) {
      header = {
        type: 'text',
        text: values.get(v.key) ?? '',
        ...(t.parameterFormat === 'named' ? { name: v.key } : {}),
      };
    }
  } else if (format === 'IMAGE' || format === 'VIDEO') {
    header = { type: format === 'IMAGE' ? 'image' : 'video', mediaId: mediaId ?? '' };
  } else if (format === 'DOCUMENT') {
    header = { type: 'document', mediaId: mediaId ?? '', fileName: m.media?.fileName ?? null };
  } else if (format === 'LOCATION' && m.location) {
    header = {
      type: 'location',
      latitude: m.location.latitude,
      longitude: m.location.longitude,
      name: m.location.name,
      address: m.location.address,
    };
  }
  const body = t.variables
    .filter((v) => v.component === 'body')
    .map((v) => ({ key: v.key, text: values.get(v.key) ?? '' }));
  const rawButtons = componentOf(t.components, 'BUTTONS')?.buttons;
  const buttons: TemplateButtonParam[] = [];
  (Array.isArray(rawButtons) ? (rawButtons as Record<string, unknown>[]) : []).forEach(
    (b, index) => {
      const type = str(b.type).toUpperCase();
      if (type === 'QUICK_REPLY') {
        buttons.push({ subType: 'quick_reply', index, payload: quickReplyPayload(t._id, index) });
      } else if (type === 'URL' && values.has(`button_${String(index)}`)) {
        buttons.push({ subType: 'url', index, text: values.get(`button_${String(index)}`) ?? '' });
      } else if (type === 'VOICE_CALL') {
        // Phase 12: the call this button starts comes back with `cta_payload` = the template
        buttons.push({ subType: 'voice_call', payload: `tpl_${t._id.toString()}` });
      } else if (type === 'COPY_CODE') {
        buttons.push({
          subType: 'copy_code',
          index,
          code: values.get(`copy_code_${String(index)}`) ?? '',
        });
      }
    },
  );
  return buildTemplatePayload(to, {
    name: t.name,
    language: t.language,
    parameterFormat: t.parameterFormat,
    header,
    body,
    buttons,
  });
};

/**
 * Who may get this template (PHASE_11_PLAN §1e rules 4–5, owner defaults): marketing
 * is refused for opted-out, DND or "stopped marketing" contacts; utility /
 * authentication only for DND contacts.
 */
export const assertTemplateAllowed = (
  contact: Pick<ContactDoc, 'optedOutAt' | 'dnd' | 'whatsapp'>,
  category: WhatsAppTemplateDoc['category'],
): void => {
  const blocked = (reason: 'opted_out' | 'dnd' | 'stopped_marketing') =>
    new AppError('TEMPLATE_MARKETING_BLOCKED', undefined, [{ path: 'contact', message: reason }]);
  if (contact.dnd) throw blocked('dnd');
  if (category !== 'MARKETING') return;
  if (contact.optedOutAt) throw blocked('opted_out');
  if (contact.whatsapp?.marketing?.stopped) throw blocked('stopped_marketing');
};

/** 1 marketing template / contact / 24 h (owner default; protects the number's quality). */
export const assertMarketingFrequency = async (
  accountId: Types.ObjectId,
  contactId: Types.ObjectId,
  now: Date,
): Promise<void> => {
  const since = new Date(now.getTime() - TEMPLATE_LIMITS.marketingPerContactWindowMs);
  const last = await MessageModel.findOne({
    accountId,
    contactId,
    type: 'template',
    'template.category': 'MARKETING',
    at: { $gte: since },
    status: { $ne: 'failed' },
  })
    .sort({ at: -1 })
    .select({ at: 1 })
    .lean<{ at: Date }>();
  if (!last) return;
  const retryAfterSec = Math.ceil(
    (last.at.getTime() + TEMPLATE_LIMITS.marketingPerContactWindowMs - now.getTime()) / 1000,
  );
  throw new AppError(
    'WHATSAPP_FREQUENCY_LIMIT',
    undefined,
    [{ path: 'contact', message: `retryAfterSec=${String(retryAfterSec)}` }],
    { retryAfterSec },
  );
};
