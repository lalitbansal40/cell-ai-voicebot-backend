import { Types } from 'mongoose';

import { TEMPLATE_LIMITS } from '../../config/limits';
import type { MetaTemplate } from '../../core/meta';
import { AccountModel, DEFAULT_TEMPLATE_SETTINGS } from '../../db/models/account.model';
import { CustomFieldModel } from '../../db/models/custom-field.model';
import type { WhatsAppChannelDoc } from '../../db/models/whatsapp-channel.model';
import {
  EDITABLE_TEMPLATE_STATUSES,
  LIVE_TEMPLATE_STATUSES,
  TEMPLATE_CATEGORIES,
  TEMPLATE_QUALITY,
  TEMPLATE_STATUSES,
  WhatsAppTemplateModel,
  type ParameterFormat,
  type TemplateCategory,
  type TemplateHistoryEntry,
  type TemplateHistorySource,
  type TemplatePurpose,
  type TemplateQuality,
  type TemplateStatus,
  type TemplateVariable,
  type VariableSourceKind,
  type WhatsAppTemplateDoc,
} from '../../db/models/whatsapp-template.model';
import {
  AppError,
  ConflictError,
  ValidationError,
  type ErrorDetail,
} from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';
import { recordAudit } from '../audit/audit.service';
import { SYSTEM_ACTOR, type WaActor } from '../whatsapp/channel-status';

import { loadAccountChannel, templateMetaError, templateToken, wabaChannel } from './channel';
import { headerFormat, isEditable, StoredComponentsSchema } from './components';
import { templateNow, type TemplateContext } from './context';
import { auditTemplate, emitTemplateUpdated } from './notify';
import { templateDetail, templateListItem } from './template-json';
import { validateTemplate } from './validate';
import { extractVariables } from './variables';

/* ── helpers ─────────────────────────────────────────────────────────────── */

const DAY = 86_400_000;

const isDuplicateKey = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;

const asStatus = (s: string): TemplateStatus =>
  (TEMPLATE_STATUSES as readonly string[]).includes(s) ? (s as TemplateStatus) : 'PENDING';
const asCategory = (c: string): TemplateCategory =>
  (TEMPLATE_CATEGORIES as readonly string[]).includes(c) ? (c as TemplateCategory) : 'MARKETING';
const asQuality = (q: string | null): TemplateQuality | null =>
  q && (TEMPLATE_QUALITY as readonly string[]).includes(q) ? (q as TemplateQuality) : null;

/** History entry, newest last, at most `statusHistoryMax`. */
export const historyPush = (entry: TemplateHistoryEntry) => ({
  statusHistory: { $each: [entry], $slice: -TEMPLATE_LIMITS.statusHistoryMax },
});

/** New variables keep the sources chosen for the same keys before. */
const mergeVariables = (
  next: TemplateVariable[],
  previous: readonly TemplateVariable[],
): TemplateVariable[] => {
  const old = new Map(previous.map((v) => [v.key, v]));
  return next.map((v) => ({
    ...v,
    defaultSource: old.get(v.key)?.defaultSource ?? v.defaultSource,
  }));
};

const loadTemplate = async (accountId: Types.ObjectId, id: string) => {
  if (!Types.ObjectId.isValid(id)) throw new AppError('TEMPLATE_NOT_FOUND');
  const t = await WhatsAppTemplateModel.findOne({ _id: id, accountId }).lean<WhatsAppTemplateDoc>();
  if (!t) throw new AppError('TEMPLATE_NOT_FOUND');
  return t;
};

const editNotAllowed = (
  reason: 'status' | 'edit_limit' | 'category_locked' | 'not_editable',
  message: string,
) => new AppError('TEMPLATE_EDIT_NOT_ALLOWED', message, [{ path: reason, message }]);

/** The 30-day lock Meta keeps on a deleted template's name (any language). */
const assertNameFree = async (
  accountId: Types.ObjectId,
  wabaId: string,
  name: string,
  language: string,
  now: Date,
  exceptId?: Types.ObjectId,
) => {
  const live = await WhatsAppTemplateModel.findOne({
    accountId,
    wabaId,
    name,
    language,
    status: { $in: LIVE_TEMPLATE_STATUSES },
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  })
    .select({ _id: 1 })
    .lean<{ _id: Types.ObjectId }>();
  if (live) {
    throw new AppError('TEMPLATE_NAME_TAKEN', undefined, [
      {
        path: 'name',
        message: 'A template with this name and language exists',
        existingId: live._id.toString(),
      },
    ]);
  }
  const locked = await WhatsAppTemplateModel.findOne({
    accountId,
    wabaId,
    name,
    status: 'DELETED',
    metaTemplateId: { $type: 'string' },
    deletedAt: { $gt: new Date(now.getTime() - TEMPLATE_LIMITS.deletedNameLockMs) },
  })
    .select({ deletedAt: 1 })
    .lean<{ deletedAt: Date }>();
  if (locked) {
    const until = new Date(locked.deletedAt.getTime() + TEMPLATE_LIMITS.deletedNameLockMs);
    throw new AppError('TEMPLATE_NAME_TAKEN', undefined, [
      {
        path: 'name',
        message: `This name was deleted recently — WhatsApp frees it on ${until.toISOString().slice(0, 10)}`,
      },
    ]);
  }
};

/** Templates per WABA (250 unverified / 6,000 verified) and creations per hour (100). */
const assertWithinLimits = async (tx: TemplateContext, channel: WhatsAppChannelDoc) => {
  const verified = (channel.businessVerificationStatus ?? '').toLowerCase() === 'verified';
  const max = verified
    ? TEMPLATE_LIMITS.templatesPerWabaVerified
    : TEMPLATE_LIMITS.templatesPerWabaUnverified;
  const count = await WhatsAppTemplateModel.countDocuments({
    accountId: channel.accountId,
    wabaId: channel.wabaId,
    status: { $in: LIVE_TEMPLATE_STATUSES.filter((s) => s !== 'DRAFT') },
  });
  if (count >= max) {
    throw new AppError('TEMPLATE_LIMIT_REACHED', undefined, [
      { path: 'wabaId', message: `This WhatsApp account can have ${String(max)} templates` },
    ]);
  }
  const hour = Math.floor(templateNow(tx).getTime() / 3_600_000);
  const key = `tpl-create-${channel.wabaId}-${String(hour)}`;
  const created = Number((await tx.wa.redis.get(key)) ?? 0);
  if (created >= TEMPLATE_LIMITS.createsPerHourPerWaba) {
    throw new AppError('TEMPLATE_LIMIT_REACHED', undefined, [
      { path: 'rate', message: 'WhatsApp allows 100 new templates per hour — try again later' },
    ]);
  }
};

const countCreation = async (tx: TemplateContext, wabaId: string) => {
  const hour = Math.floor(templateNow(tx).getTime() / 3_600_000);
  const key = `tpl-create-${wabaId}-${String(hour)}`;
  await tx.wa.redis.incr(key);
  await tx.wa.redis.expire(key, 3_700);
};

/** Components as Meta takes them: the uploaded example handle goes into a media header. */
const componentsForMeta = (t: WhatsAppTemplateDoc): Record<string, unknown>[] =>
  t.components.map((c) => {
    if (String(c.type).toUpperCase() !== 'HEADER') return c;
    const format = String(c.format).toUpperCase();
    if (!['IMAGE', 'VIDEO', 'DOCUMENT'].includes(format)) return c;
    return { ...c, example: { header_handle: [t.headerMedia?.handle ?? ''] } };
  });

const needsMediaExample = (components: readonly Record<string, unknown>[]) => {
  const format = headerFormat(components);
  return ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(format);
};

/* ── create / submit ─────────────────────────────────────────────────────── */

export interface CreateTemplateInput {
  channelId: string;
  name: string;
  language: string;
  category: TemplateCategory;
  parameterFormat?: ParameterFormat;
  components: unknown[];
  ttlSeconds?: number | null;
  purpose?: TemplatePurpose;
  /** Submit to Meta right away (default) or keep a draft. */
  submit?: boolean;
}

/** A new template: validated, saved as a draft, then (unless `submit: false`) submitted. */
export const createTemplate = async (
  tx: TemplateContext,
  accountId: Types.ObjectId,
  actor: WaActor,
  input: CreateTemplateInput,
) => {
  const channel = await loadAccountChannel(accountId, input.channelId);
  const parameterFormat = input.parameterFormat ?? 'positional';
  const purpose = input.purpose ?? 'general';
  const { errors, components } = validateTemplate({ ...input, parameterFormat, purpose });
  if (errors.length) throw new ValidationError(errors);
  const now = templateNow(tx);
  await assertNameFree(accountId, channel.wabaId, input.name, input.language, now);
  const stored = components as unknown as Record<string, unknown>[];
  let created: WhatsAppTemplateDoc;
  try {
    const doc = await WhatsAppTemplateModel.create({
      accountId,
      wabaId: channel.wabaId,
      channelIds: [channel._id],
      name: input.name,
      language: input.language,
      category: input.category,
      parameterFormat,
      components: stored,
      variables: extractVariables(stored, parameterFormat),
      status: 'DRAFT',
      statusHistory: [{ status: 'DRAFT', reason: null, at: now, source: 'user' }],
      ttlSeconds: input.ttlSeconds ?? null,
      purpose,
      editable: true,
      createdBy: actor.id,
      updatedBy: actor.id,
      lastEventAt: now,
    });
    created = doc.toObject({ transform: false });
  } catch (err) {
    if (isDuplicateKey(err)) throw new AppError('TEMPLATE_NAME_TAKEN');
    throw err;
  }
  await auditTemplate(created, 'template.created', actor, {
    draft: input.submit === false,
    purpose,
  });
  emitTemplateUpdated(created);
  if (input.submit === false) return templateDetail(created, now);
  return submitTemplate(tx, accountId, actor, created._id.toString());
};

/** Sends a draft (or a re-edited rejected one) to Meta for review. */
export const submitTemplate = async (
  tx: TemplateContext,
  accountId: Types.ObjectId,
  actor: WaActor,
  id: string,
) => {
  const t = await loadTemplate(accountId, id);
  if (t.status !== 'DRAFT') {
    throw editNotAllowed('status', 'Only drafts can be submitted — edit the template instead');
  }
  if (needsMediaExample(t.components) && !t.headerMedia?.handle) {
    throw new ValidationError([
      { path: 'headerMedia', message: 'Upload an example file for the media header' },
    ]);
  }
  const channel = await wabaChannel(accountId, t.wabaId);
  await assertWithinLimits(tx, channel);
  const { token } = await templateToken(tx, channel._id);
  const now = templateNow(tx);
  let res;
  try {
    res = await tx.wa.meta.createTemplate(token, t.wabaId, {
      name: t.name,
      language: t.language,
      category: t.category,
      parameterFormat: t.parameterFormat,
      components: componentsForMeta(t),
      ttlSeconds: t.ttlSeconds,
    });
  } catch (err) {
    throw await templateMetaError(tx, channel, err);
  }
  await countCreation(tx, t.wabaId);
  const status = asStatus(res.status);
  const category = asCategory(res.category);
  const updated = await WhatsAppTemplateModel.findOneAndUpdate(
    { _id: t._id, accountId },
    {
      $set: {
        metaTemplateId: res.id,
        status,
        category,
        // Meta may answer with another category — keep ours for the "changed" note
        previousCategory: category !== t.category ? t.category : t.previousCategory,
        statusReason: null,
        updatedBy: actor.id,
        lastEventAt: now,
        syncedAt: now,
      },
      $push: historyPush({ status, reason: null, at: now, source: 'user' }),
    },
    { returnDocument: 'after' },
  ).lean<WhatsAppTemplateDoc>();
  if (!updated) throw new AppError('TEMPLATE_NOT_FOUND');
  await auditTemplate(updated, 'template.submitted', actor);
  emitTemplateUpdated(updated);
  return templateDetail(updated, now);
};

/* ── edit ────────────────────────────────────────────────────────────────── */

export interface EditTemplateInput {
  components?: unknown[];
  category?: TemplateCategory;
  ttlSeconds?: number | null;
  /** Drafts only. */
  name?: string;
  language?: string;
  parameterFormat?: ParameterFormat;
}

/**
 * Drafts change freely; Meta templates only in `APPROVED` / `REJECTED` / `PAUSED`,
 * an approved one at most 1 × / 24 h and 10 × / 30 days and never its category.
 */
export const editTemplate = async (
  tx: TemplateContext,
  accountId: Types.ObjectId,
  actor: WaActor,
  id: string,
  patch: EditTemplateInput,
) => {
  const t = await loadTemplate(accountId, id);
  const now = templateNow(tx);
  if (!(EDITABLE_TEMPLATE_STATUSES as readonly string[]).includes(t.status)) {
    throw editNotAllowed('status', `A template that is ${t.status.toLowerCase()} can't be edited`);
  }
  if (!t.editable) {
    throw editNotAllowed('not_editable', 'Edit this template in WhatsApp Manager');
  }
  const draft = t.status === 'DRAFT';
  if (!draft && (patch.name || patch.language || patch.parameterFormat)) {
    throw editNotAllowed('status', 'Name, language and variable format are fixed after submitting');
  }
  if (t.status === 'APPROVED') {
    if (patch.category && patch.category !== t.category) {
      throw editNotAllowed('category_locked', "An approved template's category can't change");
    }
    const times = t.editsLog.map((e) => e.at.getTime());
    if (times.some((x) => x > now.getTime() - TEMPLATE_LIMITS.approvedEditGapMs)) {
      throw editNotAllowed('edit_limit', 'An approved template can be edited once a day');
    }
    if (
      times.filter((x) => x > now.getTime() - 30 * DAY).length >=
      TEMPLATE_LIMITS.approvedEditsPer30Days
    ) {
      throw editNotAllowed('edit_limit', 'An approved template can be edited 10 times in 30 days');
    }
  }
  const next = {
    name: patch.name ?? t.name,
    language: patch.language ?? t.language,
    category: patch.category ?? t.category,
    parameterFormat: patch.parameterFormat ?? t.parameterFormat,
    components: patch.components ?? t.components,
    purpose: t.purpose,
    ttlSeconds: patch.ttlSeconds === undefined ? t.ttlSeconds : patch.ttlSeconds,
  };
  const { errors, components } = validateTemplate(next);
  if (errors.length) throw new ValidationError(errors);
  if (draft && (next.name !== t.name || next.language !== t.language)) {
    await assertNameFree(accountId, t.wabaId, next.name, next.language, now, t._id);
  }
  const stored = components as unknown as Record<string, unknown>[];
  const fields = Object.keys(patch).filter(
    (k) => patch[k as keyof EditTemplateInput] !== undefined,
  );
  const mediaChanged = headerFormat(stored) !== headerFormat(t.components);
  const set: Record<string, unknown> = {
    name: next.name,
    language: next.language,
    category: next.category,
    parameterFormat: next.parameterFormat,
    components: stored,
    variables: mergeVariables(extractVariables(stored, next.parameterFormat), t.variables),
    ttlSeconds: next.ttlSeconds,
    updatedBy: actor.id,
    lastEventAt: now,
    ...(mediaChanged ? { headerMedia: null } : {}),
  };
  let updated: WhatsAppTemplateDoc | null;
  if (draft) {
    try {
      updated = await WhatsAppTemplateModel.findOneAndUpdate(
        { _id: t._id, accountId, status: 'DRAFT' },
        { $set: set },
        { returnDocument: 'after' },
      ).lean<WhatsAppTemplateDoc>();
    } catch (err) {
      if (isDuplicateKey(err)) throw new AppError('TEMPLATE_NAME_TAKEN');
      throw err;
    }
  } else {
    if (needsMediaExample(stored) && (mediaChanged || !t.headerMedia?.handle)) {
      throw new ValidationError([
        { path: 'headerMedia', message: 'Upload an example file for the media header' },
      ]);
    }
    const channel = await wabaChannel(accountId, t.wabaId);
    const { token } = await templateToken(tx, channel._id);
    try {
      await tx.wa.meta.editTemplate(token, t.metaTemplateId ?? '', {
        ...(patch.category && patch.category !== t.category ? { category: patch.category } : {}),
        components: componentsForMeta({ ...t, components: stored }),
        ...(next.ttlSeconds ? { ttlSeconds: next.ttlSeconds } : {}),
      });
    } catch (err) {
      throw await templateMetaError(tx, channel, err);
    }
    updated = await WhatsAppTemplateModel.findOneAndUpdate(
      { _id: t._id, accountId },
      {
        $set: { ...set, status: 'PENDING', statusReason: null, pausedUntil: null },
        $push: {
          ...historyPush({ status: 'PENDING', reason: 'edited', at: now, source: 'user' }),
          ...(t.status === 'APPROVED' ? { editsLog: { $each: [{ at: now }], $slice: -30 } } : {}),
        },
      },
      { returnDocument: 'after' },
    ).lean<WhatsAppTemplateDoc>();
  }
  if (!updated) throw new AppError('TEMPLATE_NOT_FOUND');
  await auditTemplate(updated, 'template.updated', actor, { fields });
  emitTemplateUpdated(updated);
  return templateDetail(updated, now);
};

/* ── delete ──────────────────────────────────────────────────────────────── */

/**
 * `one` deletes this language at Meta (`hsm_id`), `all` every language of the name.
 * Rows stay as `DELETED` (history, reports, the 30-day name lock).
 */
export const deleteTemplate = async (
  tx: TemplateContext,
  accountId: Types.ObjectId,
  actor: WaActor,
  id: string,
  scope: 'one' | 'all' = 'one',
) => {
  const t = await loadTemplate(accountId, id);
  if (t.status === 'DELETED') throw new AppError('TEMPLATE_NOT_FOUND');
  if (t.status === 'DISABLED') {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      "WhatsApp doesn't allow deleting a disabled template",
    );
  }
  const now = templateNow(tx);
  const filter =
    scope === 'all'
      ? { accountId, wabaId: t.wabaId, name: t.name, status: { $ne: 'DELETED' as const } }
      : { _id: t._id, accountId };
  const rows = await WhatsAppTemplateModel.find(filter).lean<WhatsAppTemplateDoc[]>();
  const atMeta = rows.filter((r) => r.metaTemplateId);
  if (atMeta.length) {
    const channel = await wabaChannel(accountId, t.wabaId);
    const { token } = await templateToken(tx, channel._id);
    try {
      await tx.wa.meta.deleteTemplate(token, t.wabaId, {
        name: t.name,
        ...(scope === 'one' ? { hsmId: t.metaTemplateId } : {}),
      });
    } catch (err) {
      throw await templateMetaError(tx, channel, err);
    }
  }
  for (const row of rows) {
    const updated = await WhatsAppTemplateModel.findOneAndUpdate(
      { _id: row._id, accountId },
      {
        $set: { status: 'DELETED', deletedAt: now, updatedBy: actor.id, lastEventAt: now },
        $push: historyPush({ status: 'DELETED', reason: null, at: now, source: 'user' }),
      },
      { returnDocument: 'after' },
    ).lean<WhatsAppTemplateDoc>();
    if (!updated) continue;
    await auditTemplate(updated, 'template.deleted', actor, { from: row.status, scope });
    emitTemplateUpdated(updated);
  }
  return { deleted: rows.length };
};

/* ── variables ───────────────────────────────────────────────────────────── */

export interface VariableSourceInput {
  key: string;
  kind: VariableSourceKind;
  value?: string | null;
}

/** Remembered default source per variable (contact name / phone / email, a custom field, a fixed text, ask). */
export const setVariableSources = async (
  accountId: Types.ObjectId,
  actor: WaActor,
  id: string,
  sources: VariableSourceInput[],
) => {
  const t = await loadTemplate(accountId, id);
  const keys = new Set(t.variables.map((v) => v.key));
  const errors: ErrorDetail[] = [];
  for (const s of sources) {
    if (!keys.has(s.key)) errors.push({ path: `sources.${s.key}`, message: 'Unknown variable' });
    const needsValue = s.kind === 'field' || s.kind === 'static';
    if (needsValue && !s.value?.trim())
      errors.push({ path: `sources.${s.key}`, message: 'Choose a field or type a text' });
    if (s.value && s.value.length > TEMPLATE_LIMITS.variableValueMax)
      errors.push({ path: `sources.${s.key}`, message: 'Too long' });
  }
  const fieldKeys = sources.filter((s) => s.kind === 'field').map((s) => s.value ?? '');
  if (fieldKeys.length) {
    const found = new Set(
      (
        await CustomFieldModel.find({ accountId, key: { $in: fieldKeys } })
          .select({ key: 1 })
          .lean<{ key: string }[]>()
      ).map((f) => f.key),
    );
    for (const s of sources) {
      if (s.kind === 'field' && !found.has(s.value ?? ''))
        errors.push({ path: `sources.${s.key}`, message: 'Unknown custom field' });
    }
  }
  if (errors.length) throw new ValidationError(errors);
  const byKey = new Map(sources.map((s) => [s.key, s]));
  const variables = t.variables.map((v) => {
    const s = byKey.get(v.key);
    if (!s) return v;
    const needsValue = s.kind === 'field' || s.kind === 'static';
    return { ...v, defaultSource: { kind: s.kind, value: needsValue ? (s.value ?? null) : null } };
  });
  const updated = await WhatsAppTemplateModel.findOneAndUpdate(
    { _id: t._id, accountId },
    { $set: { variables, updatedBy: actor.id } },
    { returnDocument: 'after' },
  ).lean<WhatsAppTemplateDoc>();
  if (!updated) throw new AppError('TEMPLATE_NOT_FOUND');
  await auditTemplate(updated, 'template.variables_updated', actor, {
    keys: sources.map((s) => `${s.key}:${s.kind}`),
  });
  return templateDetail(updated);
};

/* ── call permission template (Phase 12) ─────────────────────────────────── */

export const CALL_PERMISSION_BODY =
  'Kya hum aapko WhatsApp par call kar sakte hain? Aapke loan / account ke baare mein baat karni hai.';

/** One per WABA × language: category UTILITY, body + the call permission request. */
export const createCallPermissionTemplate = async (
  tx: TemplateContext,
  accountId: Types.ObjectId,
  actor: WaActor,
  input: { channelId: string; language?: string; body?: string; submit?: boolean },
) => {
  const channel = await loadAccountChannel(accountId, input.channelId);
  const account = await AccountModel.findById(accountId)
    .select({ 'settings.templates': 1 })
    .lean<{ settings?: { templates?: { defaultLanguage?: string } } }>();
  const language =
    input.language ??
    account?.settings?.templates?.defaultLanguage ??
    DEFAULT_TEMPLATE_SETTINGS.defaultLanguage;
  const existing = await WhatsAppTemplateModel.findOne({
    accountId,
    wabaId: channel.wabaId,
    language,
    purpose: 'call_permission',
    status: { $in: LIVE_TEMPLATE_STATUSES },
  })
    .select({ _id: 1 })
    .lean<{ _id: Types.ObjectId }>();
  if (existing) {
    throw new AppError(
      'TEMPLATE_NAME_TAKEN',
      'This number already has a call permission template',
      [{ path: 'purpose', message: 'One per language', existingId: existing._id.toString() }],
    );
  }
  return createTemplate(tx, accountId, actor, {
    channelId: input.channelId,
    name: `call_permission_${language.toLowerCase()}`,
    language,
    category: 'UTILITY',
    parameterFormat: 'positional',
    purpose: 'call_permission',
    components: [
      { type: 'BODY', text: (input.body ?? CALL_PERMISSION_BODY).trim() },
      { type: 'call_permission_request' },
    ],
    submit: input.submit ?? true,
  });
};

/* ── sync ────────────────────────────────────────────────────────────────── */

export interface SyncResult {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
}

/** Fields of a Meta template that our row mirrors. */
const mirror = (m: MetaTemplate) => {
  const components = StoredComponentsSchema.safeParse(m.components);
  const list = components.success ? (components.data as Record<string, unknown>[]) : [];
  const category = asCategory(m.category);
  return {
    name: m.name,
    language: m.language,
    category,
    subCategory: m.subCategory,
    parameterFormat: m.parameterFormat,
    components: list,
    status: asStatus(m.status),
    quality: asQuality(m.qualityScore),
    rejectedReason: m.rejectedReason && m.rejectedReason !== 'NONE' ? m.rejectedReason : null,
    ttlSeconds: m.ttlSeconds,
    editable: components.success && isEditable(category, list),
    // a template made in WhatsApp Manager (or before a reset) with the call request
    purpose: list.some((c) => String(c.type).toLowerCase() === 'call_permission_request')
      ? ('call_permission' as const)
      : ('general' as const),
  };
};

const SYNC_TRACKED = ['status', 'category', 'components', 'subCategory', 'ttlSeconds'] as const;

/**
 * Meta → our rows for the channel's WABA: page by page, upsert by Meta id (or adopt a
 * row with the same name + language), missing ones → `DELETED`, unsupported
 * components read-only. Newer webhook events win (`lastEventAt` = the sync start).
 */
export const syncTemplates = async (
  tx: TemplateContext,
  channelId: Types.ObjectId,
  reason: string,
  actor: WaActor = SYSTEM_ACTOR,
): Promise<SyncResult> => {
  const { channel, token } = await templateToken(tx, channelId);
  const started = templateNow(tx);
  const seen = new Set<string>();
  const result: SyncResult = { created: 0, updated: 0, deleted: 0, unchanged: 0 };
  const scope = { accountId: channel.accountId, wabaId: channel.wabaId };
  let after: string | null = null;
  for (let page = 0; page < 1000; page += 1) {
    let res;
    try {
      res = await tx.wa.meta.listTemplates(token, channel.wabaId, {
        after,
        limit: TEMPLATE_LIMITS.syncPageSize,
      });
    } catch (err) {
      throw await templateMetaError(tx, channel, err);
    }
    for (const m of res.templates) {
      seen.add(m.id);
      const f = mirror(m);
      const existing =
        (await WhatsAppTemplateModel.findOne({
          ...scope,
          metaTemplateId: m.id,
        }).lean<WhatsAppTemplateDoc>()) ??
        (await WhatsAppTemplateModel.findOne({
          ...scope,
          name: f.name,
          language: f.language,
          status: { $in: LIVE_TEMPLATE_STATUSES },
        }).lean<WhatsAppTemplateDoc>());
      const source: TemplateHistorySource = 'sync';
      const qualityAt = f.quality ? { score: f.quality, at: started } : null;
      if (!existing) {
        try {
          const doc = await WhatsAppTemplateModel.create({
            ...scope,
            channelIds: [channel._id],
            metaTemplateId: m.id,
            ...f,
            quality: qualityAt,
            statusReason: f.rejectedReason ? { reason: f.rejectedReason } : null,
            variables: extractVariables(f.components, f.parameterFormat),
            statusHistory: [{ status: f.status, reason: f.rejectedReason, at: started, source }],
            syncedAt: started,
            lastEventAt: started,
          });
          emitTemplateUpdated(doc.toObject({ transform: false }));
          result.created += 1;
        } catch (err) {
          if (!isDuplicateKey(err)) throw err;
          result.unchanged += 1;
        }
        continue;
      }
      // a webhook newer than this sync already moved the row
      const stale =
        existing.lastEventAt !== null && existing.lastEventAt.getTime() > started.getTime();
      const changed =
        SYNC_TRACKED.some((k) => JSON.stringify(existing[k]) !== JSON.stringify(f[k])) ||
        existing.metaTemplateId !== m.id ||
        (existing.quality?.score ?? null) !== f.quality;
      if (stale || !changed) {
        await WhatsAppTemplateModel.updateOne(
          { _id: existing._id },
          { $set: { syncedAt: started }, $addToSet: { channelIds: channel._id } },
        );
        result.unchanged += 1;
        continue;
      }
      const statusChanged = existing.status !== f.status;
      const updated = await WhatsAppTemplateModel.findOneAndUpdate(
        { _id: existing._id },
        {
          $set: {
            metaTemplateId: m.id,
            category: f.category,
            subCategory: f.subCategory,
            parameterFormat: f.parameterFormat,
            components: f.components,
            variables: mergeVariables(
              extractVariables(f.components, f.parameterFormat),
              existing.variables,
            ),
            status: f.status,
            quality: f.quality ? { score: f.quality, at: started } : existing.quality,
            ttlSeconds: f.ttlSeconds,
            editable: f.editable,
            ...(statusChanged
              ? {
                  statusReason: f.rejectedReason
                    ? { reason: f.rejectedReason, title: null, description: null }
                    : null,
                }
              : {}),
            ...(f.category !== existing.category ? { previousCategory: existing.category } : {}),
            syncedAt: started,
            lastEventAt: started,
          },
          $addToSet: { channelIds: channel._id },
          ...(statusChanged
            ? {
                $push: historyPush({
                  status: f.status,
                  reason: f.rejectedReason,
                  at: started,
                  source,
                }),
              }
            : {}),
        },
        { returnDocument: 'after' },
      ).lean<WhatsAppTemplateDoc>();
      if (updated) {
        if (statusChanged) {
          await auditTemplate(updated, 'template.status_changed', SYSTEM_ACTOR, {
            from: existing.status,
            to: f.status,
            reasonCode: f.rejectedReason,
            source,
          });
        }
        emitTemplateUpdated(updated);
      }
      result.updated += 1;
    }
    after = res.after;
    if (!after) break;
  }
  // gone at Meta → DELETED (drafts never reached Meta and stay)
  const missing = await WhatsAppTemplateModel.find({
    ...scope,
    metaTemplateId: { $type: 'string', $nin: [...seen] },
    status: { $ne: 'DELETED' },
    $or: [{ lastEventAt: null }, { lastEventAt: { $lte: started } }],
  }).lean<WhatsAppTemplateDoc[]>();
  for (const row of missing) {
    const updated = await WhatsAppTemplateModel.findOneAndUpdate(
      { _id: row._id },
      {
        $set: { status: 'DELETED', deletedAt: started, syncedAt: started, lastEventAt: started },
        $push: historyPush({
          status: 'DELETED',
          reason: 'missing_at_meta',
          at: started,
          source: 'sync',
        }),
      },
      { returnDocument: 'after' },
    ).lean<WhatsAppTemplateDoc>();
    if (updated) {
      await auditTemplate(updated, 'template.status_changed', SYSTEM_ACTOR, {
        from: row.status,
        to: 'DELETED',
        reasonCode: 'missing_at_meta',
        source: 'sync',
      });
      emitTemplateUpdated(updated);
    }
    result.deleted += 1;
  }
  await recordAudit({
    accountId: channel.accountId,
    actor: {
      type: actor.type,
      id: actor.id,
      impersonatorId: actor.impersonatorId ?? null,
      platform: actor.platform ?? false,
    },
    action: 'template.synced',
    target: { type: 'whatsapp_channel', id: channel._id.toString() },
    meta: { wabaId: channel.wabaId, reason, ...result },
    ip: actor.ip ?? null,
  });
  getLogger().info(
    { channelId: channel._id.toString(), reason, ...result },
    'templates: sync done',
  );
  return result;
};

/* ── usage + reads ───────────────────────────────────────────────────────── */

export type UsageEvent = 'sent' | 'delivered' | 'read' | 'failed';

/** Counters from our messages (Phase 11 sends; status updates). */
export const recordTemplateUsage = async (
  templateId: Types.ObjectId,
  event: UsageEvent,
  at: Date = new Date(),
): Promise<void> => {
  await WhatsAppTemplateModel.updateOne(
    { _id: templateId },
    {
      $inc: { [`usage.${event}`]: 1 },
      ...(event === 'sent' ? { $max: { 'usage.lastSentAt': at } } : {}),
    },
  );
};

export interface ListTemplatesQuery {
  status?: TemplateStatus[];
  category?: TemplateCategory;
  channelId?: string;
  purpose?: TemplatePurpose;
  q?: string;
  includeDeleted?: boolean;
}

/** Account templates, newest change first (no bodies in list rows). */
export const listTemplates = async (accountId: Types.ObjectId, query: ListTemplatesQuery = {}) => {
  const filter: Record<string, unknown> = { accountId };
  if (query.status?.length) filter.status = { $in: query.status };
  else if (!query.includeDeleted) filter.status = { $ne: 'DELETED' };
  if (query.category) filter.category = query.category;
  if (query.purpose) filter.purpose = query.purpose;
  if (query.channelId && Types.ObjectId.isValid(query.channelId))
    filter.channelIds = new Types.ObjectId(query.channelId);
  if (query.q?.trim()) {
    filter.name = {
      $regex: query.q
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, ''),
      $options: 'i',
    };
  }
  const rows = await WhatsAppTemplateModel.find(filter)
    .sort({ updatedAt: -1, _id: -1 })
    .limit(1000)
    .lean<WhatsAppTemplateDoc[]>();
  return rows.map(templateListItem);
};

export const getTemplate = async (accountId: Types.ObjectId, id: string, now = new Date()) =>
  templateDetail(await loadTemplate(accountId, id), now);

/** Raw row for other modules (send pipeline): 404 for another account. */
export const loadAccountTemplate = loadTemplate;
