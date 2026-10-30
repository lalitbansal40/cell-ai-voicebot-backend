import type { Types } from 'mongoose';

import { AccountModel, type CallingWindow } from '../../db/models/account.model';
import { CallInsightModel, type CallInsightDoc } from '../../db/models/call-insight.model';
import { CallModel, type CallDoc } from '../../db/models/call.model';
import {
  OutcomeRuleModel,
  type OutcomeRuleDoc,
  type RuleParam,
} from '../../db/models/outcome-rule.model';
import {
  WhatsAppTemplateModel,
  type WhatsAppTemplateDoc,
} from '../../db/models/whatsapp-template.model';
import { getLogger } from '../../shared/logger';
import { formatInr } from '../../shared/money';
import { contactVariables } from '../ai-agents/variables';

import { channelFor, schedulePostCall, variablesFor } from './collect';
import { scheduledAtFor } from './timing';

type Insight = Pick<CallInsightDoc, 'output'> | null;

/** Does the rule's "when" match this call? (Every set condition must hold.) */
export const ruleMatches = async (
  rule: Pick<OutcomeRuleDoc, 'when'>,
  call: Pick<
    CallDoc,
    | 'provider'
    | 'disposition'
    | 'contactId'
    | 'accountId'
    | 'campaignId'
    | 'source'
    | 'createdAt'
    | 'insights'
  >,
): Promise<boolean> => {
  const w = rule.when;
  if (w.dispositions.length && !w.dispositions.includes(call.disposition ?? '')) return false;
  if (w.sentiment.length && !w.sentiment.includes(call.insights?.sentiment ?? ('' as never)))
    return false;
  if (w.hasPromise !== null && Boolean(call.insights?.hasPromise) !== w.hasPromise) return false;
  const kind = call.provider === 'whatsapp' ? 'whatsapp' : 'phone';
  if (w.callKinds.length && !w.callKinds.includes(kind)) return false;
  if (w.flowIds.length && !w.flowIds.some((id) => id.equals(call.source.flowId ?? '')))
    return false;
  if (w.campaignIds.length && !w.campaignIds.some((id) => id.equals(call.campaignId ?? '')))
    return false;
  if (w.notAnsweredInARow) {
    if (!call.contactId) return false;
    const last = await CallModel.find({
      accountId: call.accountId,
      contactId: call.contactId,
      createdAt: { $lte: call.createdAt },
    })
      .sort({ createdAt: -1 })
      .limit(w.notAnsweredInARow)
      .select({ 'timestamps.answeredAt': 1 })
      .lean<Pick<CallDoc, 'timestamps'>[]>();
    if (last.length < w.notAnsweredInARow || last.some((c) => c.timestamps.answeredAt))
      return false;
  }
  return true;
};

/** Values for the template's variables, in order, from the rule's mapping. */
export const ruleValues = async (
  params: RuleParam[],
  call: Pick<CallDoc, 'accountId' | 'contactId' | 'variables' | 'disposition' | 'durationSec'>,
  insight: Insight,
): Promise<string[]> => {
  const contactKeys = params
    .filter((p) => p.from === 'contact' && p.key)
    .map((p) => p.key as string);
  const contact =
    contactKeys.length && call.contactId
      ? (await contactVariables(call.accountId, call.contactId, contactKeys).catch(() => null))
          ?.values
      : undefined;
  const key = insight?.output?.keyInfo;
  return params.map((p) => {
    if (p.from === 'text') return p.value ?? '';
    const k = p.key ?? '';
    if (p.from === 'contact') return contact?.[k] ?? '';
    if (p.from === 'call') {
      if (k === 'disposition') return call.disposition ?? '';
      if (k === 'duration_sec') return String(call.durationSec);
      return call.variables[k] ?? '';
    }
    if (k === 'promise_date') return key?.promiseDate ?? '';
    if (k === 'promise_amount')
      return key?.promiseAmountMicros !== null && key?.promiseAmountMicros !== undefined
        ? formatInr(key.promiseAmountMicros).replace(/\.00$/, '')
        : '';
    if (k === 'callback_at') return key?.callbackAt ?? '';
    return '';
  });
};

/**
 * After a call's insights finished (done / skipped / failed — also "insights off" and
 * unanswered calls, which the sweep marks skipped): every active rule in order that
 * matches schedules its template once per call (`rule:<ruleId>`). Never throws.
 */
export const evaluateOutcomeRules = async (
  callId: Types.ObjectId | string,
  now = new Date(),
): Promise<number> => {
  try {
    const call = await CallModel.findById(callId).lean<CallDoc>();
    if (!call?.timestamps.endedAt) return 0;
    const rules = await OutcomeRuleModel.find({ accountId: call.accountId, active: true })
      .sort({ order: 1, createdAt: 1 })
      .lean<OutcomeRuleDoc[]>();
    if (!rules.length) return 0;
    const account = await AccountModel.findById(call.accountId)
      .select({ timezone: 1, 'settings.callingWindow': 1 })
      .lean<{ timezone: string; settings: { callingWindow: CallingWindow } }>();
    const insight = call.insights?.version
      ? await CallInsightModel.findOne({
          accountId: call.accountId,
          callId: call._id,
          version: call.insights.version,
        })
          .select({ output: 1 })
          .lean<Insight>()
      : null;
    let scheduled = 0;
    for (const rule of rules) {
      if (!(await ruleMatches(rule, call))) continue;
      const template = await WhatsAppTemplateModel.findOne({
        _id: rule.send.templateId,
        accountId: call.accountId,
      })
        .select({ _id: 1, name: 1, language: 1, variables: 1, wabaId: 1 })
        .lean<Pick<WhatsAppTemplateDoc, '_id' | 'name' | 'language' | 'variables' | 'wabaId'>>();
      const channel = await channelFor(call.accountId, rule.send.channelId);
      const values = await ruleValues(rule.send.params, call, insight);
      if (
        await schedulePostCall({
          accountId: call.accountId,
          callId: call._id,
          contactId: call.contactId,
          source: `rule:${rule._id.toString()}`,
          ruleId: rule._id,
          channelId: channel?._id ?? null,
          templateId: template?._id ?? null,
          templateName: template?.name ?? '',
          language: template?.language ?? '',
          variables: variablesFor(template, values),
          scheduledAt: scheduledAtFor(
            rule.timing,
            now,
            account?.settings.callingWindow ?? {
              start: '09:00',
              end: '19:00',
              days: [1, 2, 3, 4, 5, 6],
            },
            account?.timezone ?? 'Asia/Kolkata',
          ),
          now,
        })
      )
        scheduled += 1;
    }
    return scheduled;
  } catch (err) {
    getLogger().error({ err, callId: String(callId) }, 'post-call: rules not evaluated');
    return 0;
  }
};
