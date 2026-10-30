import type { Request } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';

import { POSTCALL_LIMITS } from '../../config/limits';
import { MessageModel } from '../../db/models/message.model';
import { OutcomeRuleModel, type OutcomeRuleDoc } from '../../db/models/outcome-rule.model';
import {
  PostCallMessageModel,
  type PostCallMessageDoc,
} from '../../db/models/post-call-message.model';
import { WhatsAppChannelModel } from '../../db/models/whatsapp-channel.model';
import {
  WhatsAppTemplateModel,
  type WhatsAppTemplateDoc,
} from '../../db/models/whatsapp-template.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter, toObjectId } from '../../shared/auth/tenant';
import { AppError, NotFoundError, ValidationError } from '../../shared/errors/app-error';
import { auditRequest } from '../audit/audit.service';
import { findCall } from '../calls/calls.service';

import type { CreateRuleBody, UpdateRuleBody } from './rules.schema';

type TemplateInfo = Pick<WhatsAppTemplateDoc, '_id' | 'name' | 'language' | 'status' | 'variables'>;

export const ruleView = (r: OutcomeRuleDoc, templates: Map<string, TemplateInfo>) => {
  const t = templates.get(r.send.templateId.toString());
  return {
    id: r._id.toString(),
    name: r.name,
    active: r.active,
    order: r.order,
    when: {
      dispositions: [...r.when.dispositions],
      sentiment: [...r.when.sentiment],
      hasPromise: r.when.hasPromise,
      notAnsweredInARow: r.when.notAnsweredInARow,
      callKinds: [...r.when.callKinds],
      flowIds: r.when.flowIds.map(String),
      campaignIds: r.when.campaignIds.map(String),
    },
    send: {
      channelId: r.send.channelId ? r.send.channelId.toString() : null,
      templateId: r.send.templateId.toString(),
      template: t ? { name: t.name, language: t.language, status: t.status } : null,
      params: r.send.params.map((p) => ({ from: p.from, key: p.key, value: p.value })),
    },
    timing: { mode: r.timing.mode, delayMinutes: r.timing.delayMinutes },
    createdAt: r.createdAt.toISOString(),
  };
};

const templatesOf = async (accountId: Types.ObjectId, ids: Types.ObjectId[]) =>
  new Map(
    (
      await WhatsAppTemplateModel.find({ accountId, _id: { $in: ids } })
        .select({ _id: 1, name: 1, language: 1, status: 1, variables: 1 })
        .lean<TemplateInfo[]>()
    ).map((t) => [t._id.toString(), t]),
  );

/** The template and number must be this account's; params can't exceed the variables. */
const checkSend = async (
  accountId: Types.ObjectId,
  send: { channelId: string | null; templateId: string; params: unknown[] },
) => {
  const template = await WhatsAppTemplateModel.findOne({
    _id: new Types.ObjectId(send.templateId),
    accountId,
    deletedAt: null,
  })
    .select({ variables: 1 })
    .lean<Pick<WhatsAppTemplateDoc, 'variables'>>();
  if (!template)
    throw new ValidationError([{ path: 'send.templateId', message: 'Template not found' }]);
  if (send.params.length > Math.max(template.variables.length, 0) && template.variables.length)
    throw new ValidationError([
      {
        path: 'send.params',
        message: `The template has ${String(template.variables.length)} variables`,
      },
    ]);
  if (
    send.channelId &&
    !(await WhatsAppChannelModel.exists({ _id: new Types.ObjectId(send.channelId), accountId }))
  )
    throw new ValidationError([{ path: 'send.channelId', message: 'WhatsApp number not found' }]);
};

const toDoc = (body: Partial<z.infer<typeof CreateRuleBody>>) => ({
  ...(body.name !== undefined ? { name: body.name } : {}),
  ...(body.active !== undefined ? { active: body.active } : {}),
  ...(body.order !== undefined ? { order: body.order } : {}),
  ...(body.when
    ? {
        when: {
          ...body.when,
          flowIds: body.when.flowIds.map((id) => new Types.ObjectId(id)),
          campaignIds: body.when.campaignIds.map((id) => new Types.ObjectId(id)),
        },
      }
    : {}),
  ...(body.send
    ? {
        send: {
          channelId: body.send.channelId ? new Types.ObjectId(body.send.channelId) : null,
          templateId: new Types.ObjectId(body.send.templateId),
          params: body.send.params,
        },
      }
    : {}),
  ...(body.timing ? { timing: body.timing } : {}),
});

export const listRules = async (req: Request) => {
  const { accountId } = tenantFilter(req);
  const rules = await OutcomeRuleModel.find({ accountId })
    .sort({ order: 1, createdAt: 1 })
    .lean<OutcomeRuleDoc[]>();
  const templates = await templatesOf(
    accountId,
    rules.map((r) => r.send.templateId),
  );
  return rules.map((r) => ruleView(r, templates));
};

export const createRule = async (req: Request, body: z.infer<typeof CreateRuleBody>) => {
  const { accountId } = tenantFilter(req);
  if ((await OutcomeRuleModel.countDocuments({ accountId })) >= POSTCALL_LIMITS.rulesPerAccount)
    throw new AppError('OUTCOME_RULE_LIMIT');
  await checkSend(accountId, body.send);
  const auth = requireAuth(req);
  const created = await OutcomeRuleModel.create({
    accountId,
    ...toDoc(body),
    createdBy: auth.userId ? new Types.ObjectId(auth.userId) : null,
  });
  const rule = created.toObject({ transform: false }) as OutcomeRuleDoc;
  await auditRequest(req, 'outcome_rule.created', {
    target: { type: 'outcome_rule', id: rule._id.toString() },
    meta: { name: rule.name, timing: rule.timing.mode, templateId: body.send.templateId },
  });
  return ruleView(rule, await templatesOf(accountId, [rule.send.templateId]));
};

const findRule = async (req: Request, id: string) => {
  const _id = toObjectId(id);
  const rule = _id
    ? await OutcomeRuleModel.findOne({ _id, ...tenantFilter(req) }).lean<OutcomeRuleDoc>()
    : null;
  if (!rule) throw new NotFoundError('Rule not found');
  return rule;
};

export const updateRule = async (
  req: Request,
  id: string,
  body: z.infer<typeof UpdateRuleBody>,
) => {
  const rule = await findRule(req, id);
  if (body.send) await checkSend(rule.accountId, body.send);
  const updated = await OutcomeRuleModel.findOneAndUpdate(
    { _id: rule._id, accountId: rule.accountId },
    { $set: toDoc(body) },
    { new: true },
  ).lean<OutcomeRuleDoc>();
  await auditRequest(req, 'outcome_rule.updated', {
    target: { type: 'outcome_rule', id },
    meta: {
      changed: Object.keys(body),
      ...(body.active !== undefined ? { active: body.active } : {}),
    },
  });
  const r = updated as OutcomeRuleDoc;
  return ruleView(r, await templatesOf(rule.accountId, [r.send.templateId]));
};

export const deleteRule = async (req: Request, id: string) => {
  const rule = await findRule(req, id);
  await OutcomeRuleModel.deleteOne({ _id: rule._id, accountId: rule.accountId });
  await auditRequest(req, 'outcome_rule.deleted', {
    target: { type: 'outcome_rule', id },
    meta: { name: rule.name },
  });
};

/** The "After the call" rows of a call (the call page and `GET /calls/:id/after-call`). */
export const afterCallRows = async (accountId: Types.ObjectId, callId: Types.ObjectId) => {
  const rows = await PostCallMessageModel.find({ accountId, callId })
    .sort({ scheduledAt: 1, _id: 1 })
    .lean<PostCallMessageDoc[]>();
  if (!rows.length) return [];
  const ruleIds = rows.flatMap((r) => (r.ruleId ? [r.ruleId] : []));
  const rules = new Map(
    (
      await OutcomeRuleModel.find({ accountId, _id: { $in: ruleIds } })
        .select({ name: 1 })
        .lean<{ _id: Types.ObjectId; name: string }[]>()
    ).map((r) => [r._id.toString(), r.name]),
  );
  const messageIds = rows.flatMap((r) => (r.messageId ? [r.messageId] : []));
  const convs = new Map(
    (
      await MessageModel.find({ accountId, _id: { $in: messageIds } })
        .select({ conversationId: 1 })
        .lean<{ _id: Types.ObjectId; conversationId: Types.ObjectId }[]>()
    ).map((m) => [m._id.toString(), m.conversationId.toString()]),
  );
  return rows.map((r) => {
    const flow = r.source.startsWith('flow:');
    return {
      id: r._id.toString(),
      source: flow ? ('flow' as const) : ('rule' as const),
      nodeId: flow ? r.source.slice(5) : null,
      ruleId: r.ruleId ? r.ruleId.toString() : null,
      ruleName: r.ruleId ? (rules.get(r.ruleId.toString()) ?? null) : null,
      templateName: r.templateName,
      language: r.language,
      status: r.status,
      reason: r.reason,
      scheduledAt: r.scheduledAt.toISOString(),
      sentAt: r.sentAt ? r.sentAt.toISOString() : null,
      messageId: r.messageId ? r.messageId.toString() : null,
      conversationId: r.messageId ? (convs.get(r.messageId.toString()) ?? null) : null,
    };
  });
};

export const getAfterCall = async (req: Request, callId: string) => {
  const call = await findCall(tenantFilter(req).accountId, callId);
  return afterCallRows(call.accountId, call._id);
};
