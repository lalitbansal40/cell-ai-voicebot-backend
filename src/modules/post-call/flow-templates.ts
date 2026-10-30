import type { Types } from 'mongoose';

import type { FlowGraph } from '../../core/engine/schema';
import type { Issue } from '../../core/engine/validate';
import {
  WA_ACTIVE_STATUSES,
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { WhatsAppTemplateModel } from '../../db/models/whatsapp-template.model';

/**
 * Publish-time warnings for "Send WhatsApp" steps (Phase 15, never blocking): no
 * connected number, or the template isn't approved on the chosen / only number.
 * The step still runs; the message is skipped after the call with a reason.
 */
export const whatsappStepIssues = async (
  accountId: Types.ObjectId,
  graph: FlowGraph,
): Promise<Issue[]> => {
  const steps = graph.nodes.filter((n) => n.type === 'send_whatsapp');
  if (!steps.length) return [];
  const channels = await WhatsAppChannelModel.find({
    accountId,
    status: { $in: WA_ACTIVE_STATUSES },
  })
    .select({ _id: 1, wabaId: 1 })
    .lean<Pick<WhatsAppChannelDoc, '_id' | 'wabaId'>[]>();
  const issues: Issue[] = [];
  for (const node of steps) {
    const config = node.config as {
      templateName: string;
      language: string;
      channelId?: string | null;
    };
    const label = node.label ?? 'Send WhatsApp';
    const channel = config.channelId
      ? channels.find((c) => c._id.toString() === config.channelId)
      : channels.length === 1
        ? channels[0]
        : undefined;
    if (!channel) {
      issues.push({
        severity: 'warning',
        code: 'template_not_approved',
        nodeId: node.id,
        field: 'config.channelId',
        message: channels.length
          ? `"${label}": choose the WhatsApp number to send from.`
          : `"${label}": connect a WhatsApp number — until then the message is skipped.`,
      });
      continue;
    }
    const approved = await WhatsAppTemplateModel.exists({
      accountId,
      wabaId: channel.wabaId,
      name: config.templateName,
      language: config.language,
      status: 'APPROVED',
      deletedAt: null,
    });
    if (!approved) {
      issues.push({
        severity: 'warning',
        code: 'template_not_approved',
        nodeId: node.id,
        field: 'config.templateName',
        message: `"${label}": template ${config.templateName} (${config.language}) isn't approved on this number — the message is skipped until it is.`,
      });
    }
  }
  return issues;
};
