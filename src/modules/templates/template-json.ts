import { TEMPLATE_LIMITS } from '../../config/limits';
import type { WhatsAppTemplateDoc } from '../../db/models/whatsapp-template.model';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** When an approved template may be edited again (Meta: 1 / 24 h, 10 / 30 days); null = now. */
export const nextEditAt = (t: Pick<WhatsAppTemplateDoc, 'status' | 'editsLog'>, now: Date) => {
  if (t.status !== 'APPROVED') return null;
  const times = t.editsLog.map((e) => e.at.getTime()).sort((a, b) => a - b);
  const last = times.at(-1);
  const gap = last !== undefined ? last + TEMPLATE_LIMITS.approvedEditGapMs : 0;
  const month = now.getTime() - 30 * 86_400_000;
  const recent = times.filter((x) => x > month);
  const window =
    recent.length >= TEMPLATE_LIMITS.approvedEditsPer30Days
      ? (recent[recent.length - TEMPLATE_LIMITS.approvedEditsPer30Days] ?? 0) + 30 * 86_400_000
      : 0;
  const at = Math.max(gap, window);
  return at > now.getTime() ? new Date(at) : null;
};

/** List row: no components, examples or variable values (template text stays in the detail). */
export const templateListItem = (t: WhatsAppTemplateDoc) => ({
  id: t._id.toString(),
  name: t.name,
  language: t.language,
  category: t.category,
  previousCategory: t.previousCategory,
  status: t.status,
  statusReason: t.statusReason,
  quality: t.quality?.score ?? null,
  pausedUntil: iso(t.pausedUntil),
  purpose: t.purpose,
  editable: t.editable,
  parameterFormat: t.parameterFormat,
  channelIds: t.channelIds.map(String),
  variablesCount: t.variables.length,
  submitted: t.metaTemplateId !== null,
  usage: { ...t.usage, lastSentAt: iso(t.usage.lastSentAt) },
  syncedAt: iso(t.syncedAt),
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});

/** Detail: everything the builder / send dialog needs; never the storage key or Meta handle. */
export const templateDetail = (t: WhatsAppTemplateDoc, now = new Date()) => ({
  ...templateListItem(t),
  subCategory: t.subCategory,
  components: t.components,
  variables: t.variables.map((v) => ({
    key: v.key,
    component: v.component,
    index: v.index,
    example: v.example,
    defaultSource: v.defaultSource,
  })),
  statusHistory: t.statusHistory.map((h) => ({ ...h, at: h.at.toISOString() })),
  ttlSeconds: t.ttlSeconds,
  headerMedia: t.headerMedia
    ? {
        mimeType: t.headerMedia.mimeType,
        size: t.headerMedia.size,
        fileName: t.headerMedia.fileName,
        uploaded: Boolean(t.headerMedia.handle),
      }
    : null,
  editsLast30Days: t.editsLog.filter((e) => e.at.getTime() > now.getTime() - 30 * 86_400_000)
    .length,
  nextEditAt: iso(nextEditAt(t, now)),
  deletedAt: iso(t.deletedAt),
  createdBy: t.createdBy?.toString() ?? null,
});

export type TemplateListItem = ReturnType<typeof templateListItem>;
export type TemplateDetail = ReturnType<typeof templateDetail>;

/** `whatsapp.template.updated` payload (no texts). */
export const templateEvent = (t: WhatsAppTemplateDoc) => ({
  templateId: t._id.toString(),
  status: t.status,
  quality: t.quality?.score ?? null,
  category: t.category,
});
