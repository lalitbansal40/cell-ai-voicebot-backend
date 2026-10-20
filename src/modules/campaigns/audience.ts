import { Types } from 'mongoose';

import { CAMPAIGN_LIMITS } from '../../config/limits';
import { templateTokens } from '../../core/templating/tokens';
import { AiAgentModel } from '../../db/models/ai-agent.model';
import {
  CampaignContactModel,
  FINAL_CONTACT_STATUSES,
} from '../../db/models/campaign-contact.model';
import type { CampaignAudience, SkipReason } from '../../db/models/campaign.model';
import { ContactModel } from '../../db/models/contact.model';
import { accountVariables, formatVariable, type VariableInfo } from '../ai-agents/variables';
import { segmentQuery } from '../contacts/contacts.service';
import { compileContext, loadContactContext } from '../contacts/context';
import { compileOrThrow } from '../contacts/filter/compile';

import { isValidPhone } from './dial-guard';

/** Contact fields a campaign snapshots: the ones the flow (or its agents) use, + name. */
export type UsedField = Pick<VariableInfo, 'name' | 'label' | 'type'>;

/** Skip reasons decided while taking the audience (in this order). */
export const AUDIENCE_SKIPS = [
  'dnd',
  'opted_out',
  'invalid_phone',
  'duplicate_phone',
  'in_active_campaign',
  'missing_values',
] as const satisfies readonly SkipReason[];

/**
 * The audience as one Mongo query (PHASE_8_PLAN §1f): the union of lists, a
 * saved segment, an inline filter and picked contacts — live contacts of the
 * account only. `null` when no source is set.
 */
export const audienceQuery = async (
  accountId: Types.ObjectId,
  audience: Pick<CampaignAudience, 'listIds' | 'segmentId' | 'filter' | 'contactIds'>,
): Promise<Record<string, unknown> | null> => {
  const sources: Record<string, unknown>[] = [];
  if (audience.listIds.length) sources.push({ listIds: { $in: audience.listIds } });
  if (audience.contactIds.length) sources.push({ _id: { $in: audience.contactIds } });
  if (audience.segmentId || audience.filter) {
    const ctx = await loadContactContext(accountId);
    if (audience.segmentId) sources.push(await segmentQuery(ctx, audience.segmentId.toString()));
    if (audience.filter) {
      sources.push(
        compileOrThrow(accountId, audience.filter, compileContext(ctx), 'audience.filter'),
      );
    }
  }
  if (!sources.length) return null;
  return { accountId, deletedAt: null, $or: sources };
};

/** Fields the version's texts (`{{amount}}`) or its agents (allowed variables) use, + name. */
export const usedFields = async (
  accountId: Types.ObjectId,
  graph: unknown,
  agentIds: readonly Types.ObjectId[],
): Promise<UsedField[]> => {
  const tokens = new Set(
    templateTokens(JSON.stringify(graph)).map((t) => t.replace(/^contact\./, '')),
  );
  const agents = agentIds.length
    ? await AiAgentModel.find({ _id: { $in: agentIds }, accountId })
        .select({ allowedVariables: 1 })
        .lean<{ allowedVariables: string[] }[]>()
    : [];
  const allowed = new Set(agents.flatMap((a) => a.allowedVariables));
  return (await accountVariables(accountId))
    .filter((v) => v.name === 'name' || tokens.has(v.name) || allowed.has(v.name))
    .map((v) => ({ name: v.name, label: v.label, type: v.type }));
};

export interface AudienceRow {
  _id: Types.ObjectId;
  phoneE164: string;
  name?: string | null;
  dnd?: boolean;
  optedOutAt?: Date | null;
  variables?: Record<string, unknown>;
}

export const AUDIENCE_FIELDS = {
  phoneE164: 1,
  name: 1,
  dnd: 1,
  optedOutAt: 1,
  variables: 1,
} as const;

/** Display values of the used fields (what the call shows / says). */
export const displayValues = (row: AudienceRow, used: readonly UsedField[]) => {
  const values: Record<string, string> = {};
  const vars = row.variables ?? {};
  for (const f of used) {
    if (f.name === 'name') values.name = row.name ?? '';
    else if (f.name === 'phone_last4') values.phone_last4 = row.phoneE164.slice(-4);
    else values[f.name] = formatVariable(f.type, vars[f.name]);
  }
  return values;
};

/** Used fields without a value (the last-4 digits always exist). */
export const missingFields = (row: AudienceRow, used: readonly UsedField[]): string[] => {
  const values = displayValues(row, used);
  return used.filter((f) => f.name !== 'phone_last4' && !values[f.name]).map((f) => f.name);
};

export interface ClassifyContext {
  seenPhones: Set<string>;
  activeContactIds: Set<string>;
  used: readonly UsedField[];
  skipIfMissing: ReadonlySet<string>;
}

/** Why a contact is not called (first reason wins), or `null`; plus its empty used fields. */
export const classifyRow = (
  row: AudienceRow,
  ctx: ClassifyContext,
): { skip: SkipReason | null; missing: string[] } => {
  const missing = missingFields(row, ctx.used);
  if (row.dnd) return { skip: 'dnd', missing };
  if (row.optedOutAt) return { skip: 'opted_out', missing };
  if (!isValidPhone(row.phoneE164)) return { skip: 'invalid_phone', missing };
  if (ctx.seenPhones.has(row.phoneE164)) return { skip: 'duplicate_phone', missing };
  ctx.seenPhones.add(row.phoneE164);
  if (ctx.activeContactIds.has(row._id.toString())) return { skip: 'in_active_campaign', missing };
  if (missing.some((f) => ctx.skipIfMissing.has(f))) return { skip: 'missing_values', missing };
  return { skip: null, missing };
};

/** Contacts of the batch that wait in another campaign that can still call them. */
export const activeElsewhere = async (
  accountId: Types.ObjectId,
  contactIds: readonly Types.ObjectId[],
  exceptCampaignId: Types.ObjectId | null,
): Promise<Set<string>> => {
  const ids = await CampaignContactModel.distinct('contactId', {
    accountId,
    contactId: { $in: contactIds },
    status: { $nin: FINAL_CONTACT_STATUSES },
    ...(exceptCampaignId ? { campaignId: { $ne: exceptCampaignId } } : {}),
  });
  return new Set(ids.map((id) => String(id)));
};

/** Live contacts of the audience in `_id` order, in batches (resumable after `afterId`). */
export async function* audienceBatches(
  query: Record<string, unknown>,
  afterId: Types.ObjectId | null = null,
  size: number = CAMPAIGN_LIMITS.snapshotBatch,
): AsyncGenerator<AudienceRow[]> {
  const cursor = ContactModel.find(afterId ? { $and: [query, { _id: { $gt: afterId } }] } : query)
    .sort({ _id: 1 })
    .select(AUDIENCE_FIELDS)
    .lean<AudienceRow[]>()
    .cursor();
  let batch: AudienceRow[] = [];
  for await (const row of cursor) {
    batch.push(row);
    if (batch.length >= size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}

export interface AudiencePreview {
  total: number;
  willCall: number;
  tooMany: boolean;
  excluded: Record<(typeof AUDIENCE_SKIPS)[number], number>;
  missing: { field: string; label: string; count: number }[];
  samples: { name: string | null; phoneLast4: string }[];
}

const zeroSkips = () =>
  Object.fromEntries(AUDIENCE_SKIPS.map((k) => [k, 0])) as AudiencePreview['excluded'];

/**
 * Who would be called (PHASE_8_PLAN §1f preview): counts by exclusion, empty
 * used fields per field, 20 samples (names + last 4 digits only).
 */
export const previewAudience = async (input: {
  accountId: Types.ObjectId;
  audience: CampaignAudience;
  used: readonly UsedField[];
  campaignId?: Types.ObjectId | null;
}): Promise<AudiencePreview> => {
  const preview: AudiencePreview = {
    total: 0,
    willCall: 0,
    tooMany: false,
    excluded: zeroSkips(),
    missing: [],
    samples: [],
  };
  const query = await audienceQuery(input.accountId, input.audience);
  if (!query) return preview;
  const missingBy = new Map<string, number>();
  const ctx: ClassifyContext = {
    seenPhones: new Set(),
    activeContactIds: new Set(),
    used: input.used,
    skipIfMissing: new Set(input.audience.skipIfMissing),
  };
  for await (const batch of audienceBatches(query)) {
    ctx.activeContactIds = input.audience.excludeActiveCampaigns
      ? await activeElsewhere(
          input.accountId,
          batch.map((r) => r._id),
          input.campaignId ?? null,
        )
      : new Set();
    for (const row of batch) {
      preview.total += 1;
      const { skip, missing } = classifyRow(row, ctx);
      for (const f of missing) missingBy.set(f, (missingBy.get(f) ?? 0) + 1);
      if (skip) {
        preview.excluded[skip as keyof AudiencePreview['excluded']] += 1;
        continue;
      }
      preview.willCall += 1;
      if (preview.samples.length < CAMPAIGN_LIMITS.previewSampleRows) {
        preview.samples.push({ name: row.name ?? null, phoneLast4: row.phoneE164.slice(-4) });
      }
    }
  }
  preview.tooMany = preview.total > CAMPAIGN_LIMITS.maxContacts;
  preview.missing = input.used
    .filter((f) => missingBy.has(f.name))
    .map((f) => ({ field: f.name, label: f.label, count: missingBy.get(f.name) ?? 0 }));
  return preview;
};

/** `listIds` etc. from request strings. */
export const toAudience = (
  input: {
    listIds?: string[] | undefined;
    segmentId?: string | null | undefined;
    filter?: unknown;
    contactIds?: string[] | undefined;
    excludeActiveCampaigns?: boolean | undefined;
    skipIfMissing?: string[] | undefined;
  },
  base: CampaignAudience,
): CampaignAudience => ({
  listIds: input.listIds ? input.listIds.map((id) => new Types.ObjectId(id)) : base.listIds,
  segmentId:
    input.segmentId === undefined
      ? base.segmentId
      : input.segmentId
        ? new Types.ObjectId(input.segmentId)
        : null,
  filter:
    input.filter === undefined ? base.filter : (input.filter as Record<string, unknown> | null),
  contactIds: input.contactIds
    ? input.contactIds.map((id) => new Types.ObjectId(id))
    : base.contactIds,
  excludeActiveCampaigns: input.excludeActiveCampaigns ?? base.excludeActiveCampaigns,
  skipIfMissing: input.skipIfMissing ?? base.skipIfMissing,
});
