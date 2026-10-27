/**
 * E-mailed reports (Phase 14, PHASE_14_PLAN §1g): each person subscribes for themself
 * (daily / weekly / monthly, at an account-local hour). `reports-email` (maintenance,
 * hourly at :05) sends what is due — yesterday, last Monday–Sunday (on Mondays), last
 * month (on the 1st) — once per period, only while the person is active and can read
 * reports. Numbers only: no names, phones or message texts. One-click unsubscribe with
 * a signed 90-day token.
 */
import type { Request } from 'express';
import { Types } from 'mongoose';

import { REPORT_LIMITS } from '../../config/limits';
import { getEmail } from '../../core/email';
import type { ReportDigestVars } from '../../core/email/templates/report';
import { isDuplicateKeyError } from '../../db/errors';
import { AccountModel } from '../../db/models/account.model';
import {
  ReportSubscriptionModel,
  type EmailReportTab,
  type ReportFrequency,
  type ReportSubscriptionDoc,
} from '../../db/models/report-subscription.model';
import { RoleModel } from '../../db/models/role.model';
import { UserModel } from '../../db/models/user.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter, toObjectId } from '../../shared/auth/tenant';
import { AppError, NotFoundError, ValidationError } from '../../shared/errors/app-error';
import type { Logger } from '../../shared/logger';
import { formatInr } from '../../shared/money';
import { addDays, hourInZone, ymdInZone } from '../../shared/time';
import { auditRequest } from '../audit/audit.service';
import { hmacToken, safeEqualHex } from '../auth/hmac';
import { buildReport, type ReportContext } from '../reports/reports.service';

const DAY_MS = 86_400_000;
const TOKEN_DAYS = 90;

export const subscriptionView = (s: ReportSubscriptionDoc) => ({
  id: s._id.toString(),
  frequency: s.frequency,
  tabs: [...s.tabs],
  hour: s.hour,
  active: s.active,
  lastSentPeriod: s.lastSentPeriod,
  createdAt: s.createdAt.toISOString(),
});

const own = (req: Request) => {
  const auth = requireAuth(req);
  return { ...tenantFilter(req), userId: new Types.ObjectId(auth.userId) };
};

export const listSubscriptions = async (req: Request) =>
  (
    await ReportSubscriptionModel.find(own(req))
      .sort({ createdAt: 1 })
      .lean<ReportSubscriptionDoc[]>()
  ).map(subscriptionView);

export const createSubscription = async (
  req: Request,
  body: { frequency: ReportFrequency; tabs: EmailReportTab[]; hour: number },
) => {
  const scope = own(req);
  let doc;
  for (let slot = 0; slot < REPORT_LIMITS.subscriptionsPerUser; slot += 1) {
    if ((await ReportSubscriptionModel.countDocuments(scope)) >= REPORT_LIMITS.subscriptionsPerUser)
      break;
    try {
      doc = await ReportSubscriptionModel.create({
        ...scope,
        ...body,
        tabs: [...new Set(body.tabs)],
        slot,
      });
      break;
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
    }
  }
  if (!doc) throw new AppError('REPORT_SUBSCRIPTION_LIMIT');
  await auditRequest(req, 'report_subscription.created', {
    target: { type: 'report_subscription', id: doc._id.toString() },
    meta: { frequency: body.frequency, tabs: body.tabs, hour: body.hour },
  });
  return subscriptionView(doc.toObject({ transform: false }));
};

export const updateSubscription = async (
  req: Request,
  id: string,
  body: Partial<{
    frequency: ReportFrequency;
    tabs: EmailReportTab[];
    hour: number;
    active: boolean;
  }>,
) => {
  const _id = toObjectId(id);
  const doc = _id
    ? await ReportSubscriptionModel.findOneAndUpdate(
        { _id, ...own(req) },
        { $set: { ...body, ...(body.tabs ? { tabs: [...new Set(body.tabs)] } : {}) } },
        { returnDocument: 'after' },
      ).lean<ReportSubscriptionDoc>()
    : null;
  if (!doc) throw new NotFoundError('Report e-mail not found');
  await auditRequest(req, 'report_subscription.updated', {
    target: { type: 'report_subscription', id },
    meta: body,
  });
  return subscriptionView(doc);
};

export const deleteSubscription = async (req: Request, id: string) => {
  const _id = toObjectId(id);
  const res = _id
    ? await ReportSubscriptionModel.deleteOne({ _id, ...own(req) })
    : { deletedCount: 0 };
  if (!res.deletedCount) throw new NotFoundError('Report e-mail not found');
  await auditRequest(req, 'report_subscription.deleted', {
    target: { type: 'report_subscription', id },
  });
};

// ── Unsubscribe tokens ──────────────────────────────────────────────────────

const sign = (id: string, until: number) => hmacToken(`report-unsubscribe:${id}.${String(until)}`);

export const unsubscribeToken = (id: string, now: Date = new Date()): string => {
  const until = Math.floor(now.getTime() / DAY_MS) + TOKEN_DAYS;
  return `${id}.${String(until)}.${sign(id, until)}`;
};

/** `POST /report-unsubscribe { token }` — no login; a bad / old token → 422. */
export const unsubscribe = async (token: string, now: Date = new Date()): Promise<void> => {
  const parts = token.split('.');
  const [id = '', untilText = '', mac = ''] = parts;
  const until = Number(untilText);
  const _id = toObjectId(id);
  const valid =
    parts.length === 3 &&
    _id &&
    Number.isInteger(until) &&
    until >= Math.floor(now.getTime() / DAY_MS) &&
    /^[a-f0-9]{64}$/.test(mac) &&
    safeEqualHex(mac, sign(id, until));
  if (!valid)
    throw new ValidationError([{ path: 'token', message: 'This link is not valid any more.' }]);
  await ReportSubscriptionModel.updateOne({ _id }, { $set: { active: false } });
};

// ── Sending ─────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pretty = (ymd: string) =>
  `${String(Number(ymd.slice(8)))} ${MONTHS[Number(ymd.slice(5, 7)) - 1] ?? ''} ${ymd.slice(0, 4)}`;
const weekday = (ymd: string) => new Date(`${ymd}T00:00:00Z`).getUTCDay();

export interface DuePeriod {
  key: string;
  from: string;
  to: string;
  previous: { from: string; to: string };
  label: string;
}

/** What a subscription would send `today` (account-local), or `null` when nothing is due today. */
export const duePeriod = (frequency: ReportFrequency, today: string): DuePeriod | null => {
  if (frequency === 'daily') {
    const day = addDays(today, -1);
    return {
      key: day,
      from: day,
      to: day,
      previous: { from: addDays(day, -1), to: addDays(day, -1) },
      label: `Yesterday (${pretty(day)})`,
    };
  }
  if (frequency === 'weekly') {
    if (weekday(today) !== 1) return null;
    const from = addDays(today, -7);
    const to = addDays(today, -1);
    return {
      key: `W-${from}`,
      from,
      to,
      previous: { from: addDays(from, -7), to: addDays(from, -1) },
      label: `Last week (${pretty(from)} – ${pretty(to)})`,
    };
  }
  if (today.slice(8) !== '01') return null;
  const to = addDays(today, -1);
  const from = `${to.slice(0, 7)}-01`;
  const prevTo = addDays(from, -1);
  return {
    key: to.slice(0, 7),
    from,
    to,
    previous: { from: `${prevTo.slice(0, 7)}-01`, to: prevTo },
    label: `Last month (${MONTHS[Number(to.slice(5, 7)) - 1] ?? ''} ${to.slice(0, 4)})`,
  };
};

const TAB_TITLES: Record<EmailReportTab, string> = {
  overview: 'Overview',
  calls: 'Calls',
  whatsapp: 'WhatsApp',
  campaigns: 'Campaigns',
  team: 'Team',
};
const LABELS: Record<string, string> = {
  calls_attempted: 'Calls',
  calls_answered: 'Answered',
  answer_rate: 'Answer rate',
  talk_time: 'Talk time',
  avg_duration: 'Average length',
  ptp_count: 'Promises to pay',
  ptp_amount: 'Promised amount',
  messages_sent: 'Messages sent',
  delivered_rate: 'Delivered',
  read_rate: 'Read rate',
  reply_rate: 'Reply rate',
  messages_failed: 'Failed messages',
  templates_sent: 'Templates sent',
  messages_inbound: 'Customer messages',
  responses: 'Answered chats',
  first_response_median: 'Typical reply time',
  spend: 'Spend',
};

const duration = (sec: number) =>
  sec < 60
    ? `${String(Math.round(sec))}s`
    : `${String(Math.floor(sec / 60))}m ${String(Math.round(sec % 60))}s`;

export const formatKpi = (value: number | null | undefined, unit: string): string => {
  if (value === null || value === undefined) return '—';
  if (unit === 'micros') return formatInr(value);
  if (unit === 'percent') return `${String(value)}%`;
  if (unit === 'seconds') return duration(value);
  return value.toLocaleString('en-IN');
};

const canReadReports = async (accountId: Types.ObjectId, userId: Types.ObjectId) => {
  const user = await UserModel.findOne({ _id: userId, accountId, status: 'active' })
    .select({ email: 1, roleId: 1 })
    .lean<{ email: string; roleId: Types.ObjectId }>();
  if (!user) return null;
  const role = await RoleModel.findOne({ _id: user.roleId, accountId })
    .select({ permissions: 1 })
    .lean<{ permissions: string[] }>();
  return role?.permissions.includes('reports.read') ? user.email : null;
};

/** A queued digest may outlive the subscription, role or account that allowed it. */
export const mayDeliverReport = async (id: string): Promise<boolean> => {
  const _id = toObjectId(id);
  if (!_id) return false;
  const sub = await ReportSubscriptionModel.findOne({
    _id,
    active: true,
  }).lean<ReportSubscriptionDoc>();
  if (!sub || !(await AccountModel.exists({ _id: sub.accountId, status: 'active' }))) return false;
  return Boolean(await canReadReports(sub.accountId, sub.userId));
};

export interface ReportEmailDeps {
  /** Web app (links in the mail). */
  appUrl: string;
  /** API base (the one-click `List-Unsubscribe` target). */
  apiUrl: string;
  logger: Pick<Logger, 'warn' | 'info'>;
  now?: () => Date;
}

/** `reports-email`: sends every subscription due this hour (account-local). */
export const sendDueReports = async (deps: ReportEmailDeps): Promise<Record<string, number>> => {
  const now = deps.now?.() ?? new Date();
  const subs = await ReportSubscriptionModel.find({ active: true }).lean<ReportSubscriptionDoc[]>();
  const accounts = new Map<string, { name: string; timezone: string } | null>();
  let sent = 0;
  let skipped = 0;
  for (const s of subs) {
    const key = s.accountId.toString();
    if (!accounts.has(key)) {
      const a = await AccountModel.findOne({ _id: s.accountId, status: 'active' })
        .select({ name: 1, timezone: 1 })
        .lean<{ name: string; timezone: string }>();
      accounts.set(key, a);
    }
    const account = accounts.get(key);
    if (!account) continue;
    if (hourInZone(now, account.timezone) !== s.hour) continue;
    const period = duePeriod(s.frequency, ymdInZone(now, account.timezone));
    if (!period || s.lastSentPeriod === period.key) continue;
    const email = await canReadReports(s.accountId, s.userId);
    if (!email) {
      skipped += 1;
      continue;
    }
    const ctx: ReportContext = {
      accountId: s.accountId,
      timezone: account.timezone,
      from: period.from,
      to: period.to,
      previous: period.previous,
      slice: { kind: 'all', refId: null },
      callChannels: ['voice', 'whatsapp'],
      includeTest: false,
      campaignIds: [],
    };
    const sections: ReportDigestVars['sections'] = [];
    for (const tab of s.tabs) {
      const report = await buildReport(tab, ctx, now);
      sections.push({
        title: TAB_TITLES[tab],
        rows: report.kpis
          .filter((k) => LABELS[k.key])
          .map((k) => ({
            label: LABELS[k.key] ?? k.key,
            value: formatKpi(k.value, k.unit),
            previous: formatKpi(k.previous, k.unit),
          })),
      });
    }
    const token = encodeURIComponent(unsubscribeToken(s._id.toString(), now));
    const range = new URLSearchParams({
      range: 'custom',
      from: period.from,
      to: period.to,
      compare: '1',
    });
    await getEmail().enqueue(
      'reports.digest',
      email,
      {
        subscriptionId: s._id.toString(),
        accountName: account.name,
        periodLabel: period.label,
        sections,
        reportUrl: `${deps.appUrl}/reports?${range.toString()}`,
        unsubscribeUrl: `${deps.appUrl}/report-emails/unsubscribe?token=${token}`,
        oneClickUrl: `${deps.apiUrl}/api/v1/report-unsubscribe?token=${token}`,
      },
      { dedupeKey: `report-${s._id.toString()}-${period.key}` },
    );
    // A failed enqueue must remain due on retry. The queue's period-specific
    // deduplication also covers a crash between enqueue and this checkpoint.
    await ReportSubscriptionModel.updateOne(
      { _id: s._id, lastSentPeriod: s.lastSentPeriod },
      { $set: { lastSentPeriod: period.key } },
    );
    sent += 1;
  }
  return { subscriptions: subs.length, sent, skipped };
};
