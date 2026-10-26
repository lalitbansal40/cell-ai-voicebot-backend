/**
 * Reports (Phase 14, PHASE_14_PLAN §1e): every tab reads the daily rollups and computes
 * ratios / quantiles on read (docs/analytics/METRICS.md). One response shape:
 * KPIs (+ previous period), day series, one table.
 */
import { Types } from 'mongoose';

import { DURATION_BUCKETS_SEC, REPORT_LIMITS, RESPONSE_BUCKETS_SEC } from '../../config/limits';
import { AiAgentModel } from '../../db/models/ai-agent.model';
import { CampaignModel } from '../../db/models/campaign.model';
import { FlowNodeStatsModel } from '../../db/models/flow-node-stats.model';
import { FlowVersionModel } from '../../db/models/flow-version.model';
import { FlowModel } from '../../db/models/flow.model';
import type { StatsChannel, StatsKind } from '../../db/models/stats-daily.model';
import { UserModel } from '../../db/models/user.model';
import { WhatsAppChannelModel } from '../../db/models/whatsapp-channel.model';
import { WhatsAppTemplateModel } from '../../db/models/whatsapp-template.model';
import { AppError, ValidationError } from '../../shared/errors/app-error';
import { addDays, ymdInZone } from '../../shared/time';
import { accountTimezone } from '../wallet/wallet.service';

import type { ReportQueryInput, ReportTab } from './reports.schema';
import {
  avg,
  bucketQuantile,
  daysOf,
  keyed,
  loadStats,
  pct,
  sum,
  type Counters,
  type StatsRow,
} from './stats';

type Unit = 'count' | 'percent' | 'seconds' | 'micros';

export interface ReportContext {
  accountId: Types.ObjectId;
  timezone: string;
  from: string;
  to: string;
  previous: { from: string; to: string } | null;
  slice: { kind: StatsKind; refId: Types.ObjectId | null };
  callChannels: StatsChannel[];
  includeTest: boolean;
  campaignIds: Types.ObjectId[];
}

const SLICES: [keyof ReportQueryInput, StatsKind][] = [
  ['campaignId', 'campaign'],
  ['flowId', 'flow'],
  ['agentId', 'agent'],
  ['userId', 'user'],
  ['channelId', 'number'],
];

export const reportContext = async (
  accountId: Types.ObjectId,
  q: ReportQueryInput,
  now: Date = new Date(),
): Promise<ReportContext> => {
  const timezone = await accountTimezone(accountId);
  const to = q.to ?? ymdInZone(now, timezone);
  const from = q.from ?? addDays(to, -6);
  const length = daysOf(from, to).length;
  if (from > to || length > REPORT_LIMITS.maxRangeDays) throw new AppError('REPORT_RANGE_INVALID');
  const chosen = SLICES.filter(([field]) => q[field]);
  if (chosen.length > 1)
    throw new ValidationError(
      chosen.map(([field]) => ({
        path: field,
        message: 'Filter by one of campaign, flow, agent, team member or number at a time',
      })),
    );
  const [field, kind] = chosen[0] ?? [null, 'all'];
  return {
    accountId,
    timezone,
    from,
    to,
    previous: q.compare ? { from: addDays(from, -length), to: addDays(from, -1) } : null,
    slice: { kind, refId: field ? new Types.ObjectId(q[field] as string) : null },
    callChannels: q.channel ? [q.channel] : ['voice', 'whatsapp'],
    includeTest: q.includeTest ?? false,
    campaignIds: (q.campaignIds?.split(',') ?? []).map((id) => new Types.ObjectId(id)),
  };
};

interface Parts {
  calls: Counters;
  messages: Counters;
  money: Counters;
}

const split = (ctx: ReportContext, rows: StatsRow[]): Parts => ({
  calls: sum(rows.filter((r) => ctx.callChannels.includes(r.channel))),
  messages: sum(rows.filter((r) => r.channel === 'whatsapp')),
  money: sum(rows.filter((r) => r.channel === 'money')),
});

const ALL_CHANNELS: StatsChannel[] = ['voice', 'whatsapp', 'money'];

/** Rows of the chosen slice (or a given kind) for a range. */
const rowsFor = (ctx: ReportContext, range: { from: string; to: string }) =>
  loadStats({
    accountId: ctx.accountId,
    from: range.from,
    to: range.to,
    kind: ctx.slice.kind,
    refId: ctx.slice.refId,
    channels: ALL_CHANNELS,
    includeTest: ctx.includeTest,
  });

type KpiDef = [key: string, unit: Unit, value: (p: Parts) => number | null];

const callKpis: KpiDef[] = [
  ['calls_attempted', 'count', (p) => p.calls.calls_attempted ?? 0],
  ['calls_answered', 'count', (p) => p.calls.calls_answered ?? 0],
  ['answer_rate', 'percent', (p) => pct(p.calls.calls_answered, p.calls.calls_attempted)],
  ['talk_time', 'seconds', (p) => p.calls.calls_talk_sec ?? 0],
  ['avg_duration', 'seconds', (p) => avg(p.calls.calls_talk_sec, p.calls.calls_answered)],
  ['ptp_count', 'count', (p) => p.calls.ptp_count ?? 0],
  ['ptp_amount', 'micros', (p) => p.calls.ptp_micros ?? 0],
];

const messageKpis: KpiDef[] = [
  ['messages_sent', 'count', (p) => p.messages.msg_sent ?? 0],
  ['delivered_rate', 'percent', (p) => pct(p.messages.msg_delivered, p.messages.msg_sent)],
  ['read_rate', 'percent', (p) => pct(p.messages.msg_read, p.messages.msg_sent)],
  ['reply_rate', 'percent', (p) => pct(p.messages.msg_replied, p.messages.msg_tpl_sent)],
];

const spendKpi: KpiDef = ['spend', 'micros', (p) => p.money.spend_total ?? 0];

const KPIS: Record<ReportTab, KpiDef[]> = {
  overview: [
    ...callKpis.filter(([k]) => k !== 'calls_answered' && k !== 'avg_duration'),
    ...messageKpis,
    spendKpi,
  ],
  calls: [
    ...callKpis,
    [
      'median_duration',
      'seconds',
      (p) => bucketQuantile(p.calls, 'dur_b', DURATION_BUCKETS_SEC, 0.5),
    ],
    ['p90_duration', 'seconds', (p) => bucketQuantile(p.calls, 'dur_b', DURATION_BUCKETS_SEC, 0.9)],
    ['calls_inbound', 'count', (p) => p.calls.calls_inbound ?? 0],
    ['calls_outbound', 'count', (p) => p.calls.calls_outbound ?? 0],
    ['calls_ai', 'count', (p) => p.calls.calls_ai ?? 0],
    ['calls_human', 'count', (p) => p.calls.calls_human ?? 0],
    ['sentiment_positive', 'count', (p) => p.calls.sentiment_positive ?? 0],
    ['sentiment_neutral', 'count', (p) => p.calls.sentiment_neutral ?? 0],
    ['sentiment_negative', 'count', (p) => p.calls.sentiment_negative ?? 0],
    spendKpi,
  ],
  whatsapp: [
    ...messageKpis,
    ['messages_failed', 'count', (p) => p.messages.msg_failed ?? 0],
    ['templates_sent', 'count', (p) => p.messages.msg_tpl_sent ?? 0],
    ['messages_inbound', 'count', (p) => p.messages.msg_inbound ?? 0],
    ['responses', 'count', (p) => p.messages.resp_count ?? 0],
    [
      'first_response_median',
      'seconds',
      (p) => bucketQuantile(p.messages, 'resp_b', RESPONSE_BUCKETS_SEC, 0.5),
    ],
    [
      'first_response_p90',
      'seconds',
      (p) => bucketQuantile(p.messages, 'resp_b', RESPONSE_BUCKETS_SEC, 0.9),
    ],
    spendKpi,
  ],
  templates: [
    ['templates_sent', 'count', (p) => p.messages.msg_tpl_sent ?? 0],
    ['reply_rate', 'percent', (p) => pct(p.messages.msg_replied, p.messages.msg_tpl_sent)],
  ],
  campaigns: [...callKpis, spendKpi],
  flows: [...callKpis, spendKpi],
  agents: [...callKpis, spendKpi],
  team: [
    ['calls_answered', 'count', (p) => p.calls.calls_answered ?? 0],
    ['talk_time', 'seconds', (p) => p.calls.calls_talk_sec ?? 0],
    ['messages_sent', 'count', (p) => p.messages.msg_sent ?? 0],
    ['responses', 'count', (p) => p.messages.resp_count ?? 0],
    [
      'first_response_median',
      'seconds',
      (p) => bucketQuantile(p.messages, 'resp_b', RESPONSE_BUCKETS_SEC, 0.5),
    ],
  ],
};

type SeriesDef = [key: string, unit: Unit, value: (p: Parts) => number | null];

const SERIES: Record<ReportTab, SeriesDef[]> = {
  overview: [
    ['calls_attempted', 'count', (p) => p.calls.calls_attempted ?? 0],
    ['calls_answered', 'count', (p) => p.calls.calls_answered ?? 0],
    ['messages_sent', 'count', (p) => p.messages.msg_sent ?? 0],
    ['messages_read', 'count', (p) => p.messages.msg_read ?? 0],
    ['spend', 'micros', (p) => p.money.spend_total ?? 0],
  ],
  calls: [
    ['calls_attempted', 'count', (p) => p.calls.calls_attempted ?? 0],
    ['calls_answered', 'count', (p) => p.calls.calls_answered ?? 0],
    ['answer_rate', 'percent', (p) => pct(p.calls.calls_answered, p.calls.calls_attempted)],
    ['talk_time', 'seconds', (p) => p.calls.calls_talk_sec ?? 0],
  ],
  whatsapp: [
    ['messages_sent', 'count', (p) => p.messages.msg_sent ?? 0],
    ['messages_delivered', 'count', (p) => p.messages.msg_delivered ?? 0],
    ['messages_read', 'count', (p) => p.messages.msg_read ?? 0],
    ['messages_inbound', 'count', (p) => p.messages.msg_inbound ?? 0],
  ],
  templates: [
    ['templates_sent', 'count', (p) => p.messages.msg_tpl_sent ?? 0],
    ['replied', 'count', (p) => p.messages.msg_replied ?? 0],
  ],
  campaigns: [
    ['calls_attempted', 'count', (p) => p.calls.calls_attempted ?? 0],
    ['calls_answered', 'count', (p) => p.calls.calls_answered ?? 0],
  ],
  flows: [
    ['calls_attempted', 'count', (p) => p.calls.calls_attempted ?? 0],
    ['calls_answered', 'count', (p) => p.calls.calls_answered ?? 0],
  ],
  agents: [
    ['calls_attempted', 'count', (p) => p.calls.calls_attempted ?? 0],
    ['calls_answered', 'count', (p) => p.calls.calls_answered ?? 0],
  ],
  team: [
    ['calls_answered', 'count', (p) => p.calls.calls_answered ?? 0],
    ['messages_sent', 'count', (p) => p.messages.msg_sent ?? 0],
  ],
};

interface Table {
  columns: { key: string; unit: Unit }[];
  rows: { id: string | null; label: string; values: Record<string, number | null> }[];
}

const EMPTY_TABLE: Table = { columns: [], rows: [] };

const callColumns: KpiDef[] = [
  ['calls_attempted', 'count', (p) => p.calls.calls_attempted ?? 0],
  ['calls_answered', 'count', (p) => p.calls.calls_answered ?? 0],
  ['answer_rate', 'percent', (p) => pct(p.calls.calls_answered, p.calls.calls_attempted)],
  ['talk_time', 'seconds', (p) => p.calls.calls_talk_sec ?? 0],
  ['ptp_count', 'count', (p) => p.calls.ptp_count ?? 0],
  ['ptp_amount', 'micros', (p) => p.calls.ptp_micros ?? 0],
  ['spend', 'micros', (p) => p.money.spend_total ?? 0],
  ['cost_per_answered', 'micros', (p) => avg(p.money.spend_total, p.calls.calls_answered)],
];

const tableOf = (
  defs: KpiDef[],
  groups: { id: string | null; label: string; parts: Parts }[],
): Table => ({
  columns: defs.map(([key, unit]) => ({ key, unit })),
  rows: groups.map((g) => ({
    id: g.id,
    label: g.label,
    values: Object.fromEntries(defs.map(([key, , fn]) => [key, fn(g.parts)])),
  })),
});

const namesOf = async (
  kind: StatsKind,
  accountId: Types.ObjectId,
  ids: string[],
): Promise<Map<string, string>> => {
  if (!ids.length) return new Map();
  const _id = { $in: ids.map((id) => new Types.ObjectId(id)) };
  const rows: { _id: Types.ObjectId; label: string }[] =
    kind === 'campaign'
      ? (
          await CampaignModel.find({ accountId, _id })
            .select({ name: 1 })
            .lean<{ _id: Types.ObjectId; name: string }[]>()
        ).map((r) => ({ _id: r._id, label: r.name }))
      : kind === 'flow'
        ? (
            await FlowModel.find({ accountId, _id })
              .select({ name: 1 })
              .lean<{ _id: Types.ObjectId; name: string }[]>()
          ).map((r) => ({ _id: r._id, label: r.name }))
        : kind === 'agent'
          ? (
              await AiAgentModel.find({ accountId, _id })
                .select({ name: 1 })
                .lean<{ _id: Types.ObjectId; name: string }[]>()
            ).map((r) => ({ _id: r._id, label: r.name }))
          : kind === 'user'
            ? (
                await UserModel.find({ accountId, _id })
                  .select({ name: 1 })
                  .lean<{ _id: Types.ObjectId; name: string }[]>()
              ).map((r) => ({ _id: r._id, label: r.name }))
            : kind === 'template'
              ? (
                  await WhatsAppTemplateModel.find({ accountId, _id })
                    .select({ name: 1, language: 1 })
                    .lean<{ _id: Types.ObjectId; name: string; language: string }[]>()
                ).map((r) => ({ _id: r._id, label: `${r.name} (${r.language})` }))
              : (
                  await WhatsAppChannelModel.find({ accountId, _id })
                    .select({ label: 1, displayPhoneNumber: 1 })
                    .lean<
                      { _id: Types.ObjectId; label: string; displayPhoneNumber: string | null }[]
                    >()
                ).map((r) => ({ _id: r._id, label: r.label }));
  return new Map(rows.map((r) => [r._id.toString(), r.label]));
};

const DELETED: Record<StatsKind, string> = {
  all: 'All',
  campaign: 'Deleted campaign',
  flow: 'Deleted flow',
  agent: 'Deleted AI agent',
  user: 'Former team member',
  template: 'Deleted template',
  number: 'Removed number',
};

/** One table row per slice id of `kind` in the range (sorted by `sortKey`, ≤ `tableMaxRows`). */
const sliceTable = async (
  ctx: ReportContext,
  kind: StatsKind,
  defs: KpiDef[],
  options: { only?: Types.ObjectId[]; sortKey: string; limit?: number },
): Promise<Table> => {
  // every id of the kind (`refId` left out of the query)
  const rows = await loadStats({
    accountId: ctx.accountId,
    from: ctx.from,
    to: ctx.to,
    kind,
    channels: ALL_CHANNELS,
    includeTest: ctx.includeTest,
  });
  const grouped = new Map<string, StatsRow[]>();
  for (const r of rows) {
    if (!r.refId) continue;
    const key = r.refId.toString();
    if (options.only?.length && !options.only.some((id) => id.toString() === key)) continue;
    grouped.set(key, [...(grouped.get(key) ?? []), r]);
  }
  const groups = [...grouped].map(([id, list]) => ({ id, parts: split(ctx, list) }));
  const sorted = groups
    .map((g) => ({ ...g, sortBy: defs.find(([k]) => k === options.sortKey)?.[2](g.parts) ?? 0 }))
    .sort((a, b) => (b.sortBy ?? 0) - (a.sortBy ?? 0))
    .slice(0, options.limit ?? REPORT_LIMITS.tableMaxRows);
  const names = await namesOf(
    kind,
    ctx.accountId,
    sorted.map((g) => g.id),
  );
  return tableOf(
    defs,
    sorted.map((g) => ({ id: g.id, label: names.get(g.id) ?? DELETED[kind], parts: g.parts })),
  );
};

const outcomesTable = (parts: Parts): Table => {
  const answered = parts.calls.calls_answered ?? 0;
  const rows: Table['rows'] = keyed(parts.calls, 'outcome_').map(([key, n]) => ({
    id: key,
    label: key,
    values: { calls: n, share: pct(n, answered) },
  }));
  const none = parts.calls.calls_no_outcome ?? 0;
  if (none)
    rows.push({
      id: null,
      label: 'No outcome',
      values: { calls: none, share: pct(none, answered) },
    });
  return {
    columns: [
      { key: 'calls', unit: 'count' },
      { key: 'share', unit: 'percent' },
    ],
    rows,
  };
};

const flowFunnel = async (ctx: ReportContext, flowId: Types.ObjectId): Promise<Table> => {
  const stats = await FlowNodeStatsModel.find({
    accountId: ctx.accountId,
    flowId,
    mode: 'call',
    day: { $gte: ctx.from, $lte: ctx.to },
  })
    .select({ nodeId: 1, entered: 1, errorCount: 1, totalMs: 1, exits: 1 })
    .lean<
      {
        nodeId: string;
        entered: number;
        errorCount: number;
        totalMs: number;
        exits: Record<string, number>;
      }[]
    >();
  const nodes = new Map<
    string,
    { entered: number; errors: number; totalMs: number; exits: number }
  >();
  for (const s of stats) {
    const n = nodes.get(s.nodeId) ?? { entered: 0, errors: 0, totalMs: 0, exits: 0 };
    n.entered += s.entered;
    n.errors += s.errorCount;
    n.totalMs += s.totalMs;
    n.exits += Object.values(s.exits ?? {}).reduce((a, b) => a + b, 0);
    nodes.set(s.nodeId, n);
  }
  const version = await FlowVersionModel.findOne({ accountId: ctx.accountId, flowId })
    .sort({ version: -1 })
    .select({ graph: 1 })
    .lean<{ graph: { nodes?: { id: string; label?: string; type: string }[] } }>();
  const labels = new Map((version?.graph.nodes ?? []).map((n) => [n.id, n.label || n.type]));
  return {
    columns: [
      { key: 'entered', unit: 'count' },
      { key: 'errors', unit: 'count' },
      { key: 'avg_time', unit: 'seconds' },
    ],
    rows: [...nodes]
      .sort((a, b) => b[1].entered - a[1].entered)
      .map(([id, n]) => ({
        id,
        label: labels.get(id) ?? id,
        values: {
          entered: n.entered,
          errors: n.errors,
          avg_time: n.exits ? Math.round(n.totalMs / n.exits / 1000) : null,
        },
      })),
  };
};

const messageColumns: KpiDef[] = [
  ['messages_sent', 'count', (p) => p.messages.msg_sent ?? 0],
  ['delivered_rate', 'percent', (p) => pct(p.messages.msg_delivered, p.messages.msg_sent)],
  ['read_rate', 'percent', (p) => pct(p.messages.msg_read, p.messages.msg_sent)],
  ['messages_failed', 'count', (p) => p.messages.msg_failed ?? 0],
  ['messages_inbound', 'count', (p) => p.messages.msg_inbound ?? 0],
  ['calls_attempted', 'count', (p) => p.calls.calls_attempted ?? 0],
  ['calls_answered', 'count', (p) => p.calls.calls_answered ?? 0],
];

const templateColumns: KpiDef[] = [
  ['messages_sent', 'count', (p) => p.messages.msg_sent ?? 0],
  ['delivered_rate', 'percent', (p) => pct(p.messages.msg_delivered, p.messages.msg_sent)],
  ['read_rate', 'percent', (p) => pct(p.messages.msg_read, p.messages.msg_sent)],
  ['replied', 'count', (p) => p.messages.msg_replied ?? 0],
  ['reply_rate', 'percent', (p) => pct(p.messages.msg_replied, p.messages.msg_sent)],
  ['messages_failed', 'count', (p) => p.messages.msg_failed ?? 0],
  ['spend', 'micros', (p) => p.money.spend_total ?? 0],
];

const teamColumns: KpiDef[] = [
  ['calls_answered', 'count', (p) => p.calls.calls_answered ?? 0],
  ['talk_time', 'seconds', (p) => p.calls.calls_talk_sec ?? 0],
  ['avg_duration', 'seconds', (p) => avg(p.calls.calls_talk_sec, p.calls.calls_answered)],
  ['messages_sent', 'count', (p) => p.messages.msg_sent ?? 0],
  ['responses', 'count', (p) => p.messages.resp_count ?? 0],
  [
    'first_response_median',
    'seconds',
    (p) => bucketQuantile(p.messages, 'resp_b', RESPONSE_BUCKETS_SEC, 0.5),
  ],
];

const tableFor = async (tab: ReportTab, ctx: ReportContext, current: Parts): Promise<Table> => {
  switch (tab) {
    case 'overview':
      return EMPTY_TABLE;
    case 'calls':
      return outcomesTable(current);
    case 'whatsapp':
      return sliceTable(ctx, 'number', messageColumns, { sortKey: 'messages_sent' });
    case 'templates':
      return sliceTable(ctx, 'template', templateColumns, { sortKey: 'messages_sent' });
    case 'campaigns':
      return sliceTable(ctx, 'campaign', callColumns, {
        only: ctx.campaignIds,
        sortKey: 'calls_attempted',
        limit: ctx.campaignIds.length || 10,
      });
    case 'flows':
      return ctx.slice.kind === 'flow' && ctx.slice.refId
        ? flowFunnel(ctx, ctx.slice.refId)
        : sliceTable(ctx, 'flow', callColumns, { sortKey: 'calls_attempted' });
    case 'agents':
      return sliceTable(ctx, 'agent', callColumns, { sortKey: 'calls_attempted' });
    case 'team':
      return sliceTable(ctx, 'user', teamColumns, { sortKey: 'calls_answered' });
  }
};

export const buildReport = async (tab: ReportTab, ctx: ReportContext, now: Date = new Date()) => {
  const rows = await rowsFor(ctx, ctx);
  const current = split(ctx, rows);
  const previous = ctx.previous ? split(ctx, await rowsFor(ctx, ctx.previous)) : null;
  const byDayRows = new Map<string, StatsRow[]>();
  for (const r of rows) byDayRows.set(r.day, [...(byDayRows.get(r.day) ?? []), r]);
  const perDay = new Map<string, Parts>();
  for (const d of daysOf(ctx.from, ctx.to)) perDay.set(d, split(ctx, byDayRows.get(d) ?? []));
  return {
    tab,
    range: { from: ctx.from, to: ctx.to, timezone: ctx.timezone },
    compareRange: ctx.previous,
    kpis: KPIS[tab].map(([key, unit, fn]) => ({
      key,
      value: fn(current),
      ...(previous ? { previous: fn(previous) } : {}),
      unit,
    })),
    series: SERIES[tab].map(([key, unit, fn]) => ({
      key,
      unit,
      points: [...perDay].map(([day, parts]) => ({ day, value: fn(parts) })),
    })),
    table: await tableFor(tab, ctx, current),
    updatedAt: now.toISOString(),
  };
};

export type Report = Awaited<ReturnType<typeof buildReport>>;
