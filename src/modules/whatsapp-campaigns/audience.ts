import { createHash } from 'node:crypto';

import { Types } from 'mongoose';

import { getEnv } from '../../config/env';
import { ContactModel, type ContactDoc } from '../../db/models/contact.model';
import { MessageModel } from '../../db/models/message.model';
import { WhatsAppCallPermissionModel } from '../../db/models/whatsapp-call-permission.model';
import {
  WhatsAppCampaignRecipientModel,
  type WhatsAppCampaignRecipientDoc,
} from '../../db/models/whatsapp-campaign-recipient.model';
import type {
  WaCampaignSkipReason,
  WaVariableKind,
  WhatsAppCampaignDoc,
} from '../../db/models/whatsapp-campaign.model';
import { segmentQuery } from '../contacts/contacts.service';
import { loadContactContext } from '../contacts/context';
import { readContactVariables } from '../privacy/sensitive';
import { suppressedPhones } from '../privacy/suppression';

/** PHASE_19_PROMPT §1: env `WA_CAMPAIGN_MAX_RECIPIENTS` (default 100,000), snapshots of 1,000. */
export const WA_CAMPAIGN_LIMITS = {
  get maxRecipients() {
    return getEnv().WA_CAMPAIGN_MAX_RECIPIENTS;
  },
  snapshotBatch: 1_000,
} as const;
const DAY_MS = 86_400_000;
const DECLINED_RECENTLY_MS = 7 * DAY_MS;

export interface VariantInfo {
  key: 'A' | 'B' | 'C';
  templateId: Types.ObjectId;
  category: string;
  purpose: string;
  /** Template variable keys (all need a value). */
  keys: string[];
  /** Meta status of the template (`APPROVED`, `PAUSED`, `DISABLED`…); set by `loadVariants`. */
  status?: string;
}

/** The campaign's audience → a Mongo filter on live contacts (lists OR segment OR tags OR ids OR an import). */
export const audienceFilter = async (
  campaign: Pick<WhatsAppCampaignDoc, 'accountId' | 'audience'>,
): Promise<Record<string, unknown>> => {
  const base = { accountId: campaign.accountId, deletedAt: null };
  const or: Record<string, unknown>[] = [];
  const a = campaign.audience;
  if (a.listIds.length) or.push({ listIds: { $in: a.listIds } });
  if (a.contactIds.length) or.push({ _id: { $in: a.contactIds } });
  if (a.tags?.values.length) {
    or.push({ tags: a.tags.mode === 'all' ? { $all: a.tags.values } : { $in: a.tags.values } });
  }
  if (a.segmentId) {
    const ctx = await loadContactContext(campaign.accountId);
    or.push(await segmentQuery(ctx, a.segmentId.toString()));
  }
  // a CSV / sheet import: its contacts carry `source.importJobId` (contact-imports)
  if (a.csvUploadId) or.push({ 'source.importJobId': a.csvUploadId });
  if (!or.length) return { ...base, _id: { $in: [] } };
  return { ...base, $or: or };
};

/** Deterministic A / B / C by contact id (the same contact always lands in the same variant). */
export const variantFor = (
  contactId: Types.ObjectId,
  variants: readonly { key: 'A' | 'B' | 'C'; splitPct: number }[],
): 'A' | 'B' | 'C' => {
  const n =
    parseInt(createHash('sha1').update(contactId.toString()).digest('hex').slice(0, 8), 16) % 100;
  let acc = 0;
  for (const v of variants) {
    acc += v.splitPct;
    if (n < acc) return v.key;
  }
  return variants.at(-1)?.key ?? 'A';
};

type ContactLite = Pick<
  ContactDoc,
  '_id' | 'phoneE164' | 'name' | 'variables' | 'dnd' | 'optedOutAt' | 'whatsapp'
>;

/** The value of one template variable for one contact (null = missing). */
export const variableValue = (
  contact: ContactLite,
  source: { kind: WaVariableKind; value: string | null } | undefined,
): string | null => {
  if (!source) return null;
  if (source.kind === 'static') return source.value?.trim() || null;
  if (source.kind === 'contact.phone') return contact.phoneE164;
  if (source.kind === 'contact.name') {
    return contact.name?.trim() || contact.whatsapp?.profileName?.trim() || null;
  }
  const vars = readContactVariables(contact, { purpose: 'send' });
  const raw = source.value ? vars[source.value] : undefined;
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean')
    return String(raw);
  return null;
};

/** All variable values for a contact, or null when one is missing. */
export const variablesFor = (
  contact: ContactLite,
  keys: readonly string[],
  mapping: WhatsAppCampaignDoc['variables'],
): Record<string, string> | null => {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = variableValue(contact, mapping[k]);
    if (v === null) return null;
    out[k] = v.slice(0, 1024);
  }
  return out;
};

const PHONE = /^\+[1-9]\d{6,14}$/;

/**
 * Skip rules at snapshot time (prompt order): invalid phone, suppressed, DND, opted out,
 * no WhatsApp (blocked us), marketing stopped (MARKETING variants), sent the same template
 * recently, a missing variable; consent variants also: already allowed, declined in 7 days.
 */
export const skipFor = (
  c: ContactLite,
  v: VariantInfo,
  facts: {
    suppressed: boolean;
    sentRecently: boolean;
    mapping: WhatsAppCampaignDoc['variables'];
    permission: { status: string; at: Date | null; expiresAt?: Date | null } | null;
    now: Date;
  },
): WaCampaignSkipReason | null => {
  if (!PHONE.test(c.phoneE164)) return 'invalid_phone';
  if (facts.suppressed) return 'suppressed';
  if (c.dnd) return 'dnd';
  if (c.optedOutAt) return 'opted_out';
  if (c.whatsapp?.blocked) return 'no_whatsapp';
  if (v.category === 'MARKETING' && c.whatsapp?.marketing?.stopped) return 'marketing_stopped';
  if (facts.sentRecently) return 'sent_recently';
  if (v.purpose === 'call_permission' && facts.permission) {
    const s = facts.permission.status;
    if (
      s === 'permanent' ||
      (s === 'temporary' && facts.permission.expiresAt && facts.permission.expiresAt > facts.now)
    )
      return 'already_allowed';
    if (
      s === 'declined' &&
      facts.permission.at &&
      facts.now.getTime() - facts.permission.at.getTime() < DECLINED_RECENTLY_MS
    ) {
      return 'declined_recently';
    }
  }
  if (variablesFor(c, v.keys, facts.mapping) === null) return 'missing_variable';
  return null;
};

/**
 * Snapshots the audience into recipient rows (batches of 1,000, unique per campaign, capped)
 * and returns the counts. Re-running is safe: existing rows stay as they are.
 */
export async function* resolveAudienceBatches(
  campaign: WhatsAppCampaignDoc,
  variants: VariantInfo[],
  now = new Date(),
): AsyncGenerator<
  { contact: ContactLite; variant: VariantInfo; skipReason: WaCampaignSkipReason | null }[]
> {
  const filter = await audienceFilter(campaign);
  const byKey = new Map(variants.map((v) => [v.key, v]));
  let total = 0;
  let lastId: Types.ObjectId | null = null;
  const consent = variants.some((v) => v.purpose === 'call_permission');
  for (;;) {
    const left = WA_CAMPAIGN_LIMITS.maxRecipients - total;
    if (left <= 0) break;
    const contacts: ContactLite[] = await ContactModel.find({
      ...filter,
      ...(lastId ? { _id: { ...(filter._id as object | undefined), $gt: lastId } } : {}),
    })
      .select({ phoneE164: 1, name: 1, variables: 1, dnd: 1, optedOutAt: 1, whatsapp: 1 })
      .sort({ _id: 1 })
      .limit(Math.min(WA_CAMPAIGN_LIMITS.snapshotBatch, left))
      .lean<ContactLite[]>();
    if (!contacts.length) break;
    lastId = contacts.at(-1)?._id ?? null;
    const ids = contacts.map((c) => c._id);
    const suppressed = await suppressedPhones(
      campaign.accountId,
      contacts.map((c) => c.phoneE164),
    );
    const recent = new Set<string>();
    if (campaign.excludeRecentDays > 0) {
      const rows = await MessageModel.find({
        accountId: campaign.accountId,
        contactId: { $in: ids },
        direction: 'out',
        status: { $in: ['accepted', 'sent', 'delivered', 'read'] },
        'template.templateId': { $in: variants.map((v) => v.templateId) },
        createdAt: { $gte: new Date(now.getTime() - campaign.excludeRecentDays * DAY_MS) },
      })
        .select({ contactId: 1, 'template.templateId': 1 })
        .lean<{ contactId: Types.ObjectId; template: { templateId: Types.ObjectId } }[]>();
      for (const r of rows)
        recent.add(`${r.contactId.toString()}:${r.template.templateId.toString()}`);
    }
    const perms = new Map<string, { status: string; at: Date | null; expiresAt?: Date | null }>();
    if (consent) {
      const rows = await WhatsAppCallPermissionModel.find({
        accountId: campaign.accountId,
        channelId: campaign.channelId,
        contactId: { $in: ids },
      })
        .select({ contactId: 1, status: 1, updatedAt: 1, expiresAt: 1 })
        .lean<
          { contactId: Types.ObjectId; status: string; updatedAt: Date; expiresAt?: Date | null }[]
        >();
      for (const r of rows)
        perms.set(r.contactId.toString(), {
          status: r.status,
          at: r.updatedAt,
          expiresAt: r.expiresAt,
        });
    }
    const docs = contacts.map((c) => {
      const key = variantFor(c._id, campaign.variants);
      const v = byKey.get(key) ?? variants[0];
      const reason = v
        ? skipFor(c, v, {
            suppressed: suppressed.has(c.phoneE164),
            sentRecently: recent.has(`${c._id.toString()}:${v.templateId.toString()}`),
            mapping: campaign.variables,
            permission: perms.get(c._id.toString()) ?? null,
            now,
          })
        : 'missing_variable';
      if (!v) throw new Error('Campaign variant is missing');
      return { contact: c, variant: v, skipReason: reason };
    });
    yield docs;
    total += contacts.length;
    if (contacts.length < WA_CAMPAIGN_LIMITS.snapshotBatch) break;
  }
}

/** The estimate and persisted snapshot use the same eligibility decisions. */
export const snapshotAudience = async (
  campaign: WhatsAppCampaignDoc,
  variants: VariantInfo[],
  now = new Date(),
) => {
  let total = 0;
  const skipped: Partial<Record<WaCampaignSkipReason, number>> = {};
  for await (const batch of resolveAudienceBatches(campaign, variants, now)) {
    total += batch.length;
    const docs: Partial<WhatsAppCampaignRecipientDoc>[] = batch.map(
      ({ contact, variant, skipReason }) => {
        if (skipReason) skipped[skipReason] = (skipped[skipReason] ?? 0) + 1;
        return {
          campaignId: campaign._id,
          accountId: campaign.accountId,
          contactId: contact._id,
          variant: variant.key,
          status: skipReason ? 'skipped' : 'pending',
          skipReason,
        };
      },
    );
    await WhatsAppCampaignRecipientModel.insertMany(docs, { ordered: false }).catch(
      (err: { code?: number; writeErrors?: { code?: number; err?: { code?: number } }[] }) => {
        if (
          err.writeErrors?.length
            ? err.writeErrors.some((e) => (e.code ?? e.err?.code) !== 11000)
            : err.code !== 11000
        )
          throw err;
      },
    );
  }
  return { total, skipped };
};

export const toObjectIds = (ids: readonly string[]): Types.ObjectId[] =>
  ids.map((id) => new Types.ObjectId(id));
