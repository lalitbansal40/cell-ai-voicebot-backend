import { Types } from 'mongoose';

import { reapWhatsAppHolds } from '../../core/billing/whatsapp-reaper';
import { metaAppSecret, signWebhook, type FakeMetaClient } from '../../core/meta';
import type { StorageProvider } from '../../core/storage';
import { MessageModel, type MessageDoc } from '../../db/models/message.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import {
  WhatsAppTemplateModel,
  type WhatsAppTemplateDoc,
} from '../../db/models/whatsapp-template.model';
import { NotFoundError, ValidationError } from '../../shared/errors/app-error';
import type { WhatsAppContext } from '../whatsapp/context';
import type { WhatsAppJobs } from '../whatsapp/jobs';
import { receiveWebhook, type WebhookReceipt } from '../whatsapp/webhooks.service';
import { runWhatsAppReconcile } from '../whatsapp-billing/reconcile';

import { unavailableTemplateJobs } from './jobs';
import type { TemplateSimulatorKind } from './simulator-kinds';
import { syncTemplates } from './template.service';

const SIM_CUSTOMER = '919000010101';

export interface TemplateSimulatorOptions {
  templateId?: string | undefined;
  messageId?: string | undefined;
  from?: string | undefined;
}

type Result = { kind: TemplateSimulatorKind; field: string } & Partial<WebhookReceipt> & {
    result?: unknown;
  };

const envelope = (wabaId: string, field: string, value: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: wabaId, time: Math.floor(Date.now() / 1000), changes: [{ field, value }] }],
});

/**
 * Runs one kind on a number: template / preference / tier events are Meta-shaped,
 * signed and handed to the real receiver (the fake's state is changed first); the
 * `run_*` kinds run the job directly; `late_billable_status` sends a billable status
 * for one of our messages (after its hold was released → late charge).
 */
export const runTemplateSimulator = async (
  deps: {
    ctx: WhatsAppContext;
    jobs: WhatsAppJobs;
    storage?: StorageProvider | undefined;
    secret?: string | undefined;
  },
  channelId: Types.ObjectId,
  kind: TemplateSimulatorKind,
  opts: TemplateSimulatorOptions = {},
): Promise<Result> => {
  const channel = await WhatsAppChannelModel.findById(channelId).lean<WhatsAppChannelDoc>();
  if (!channel) throw new NotFoundError('WhatsApp number not found');
  const fake = deps.ctx.meta.provider === 'fake' ? (deps.ctx.meta as FakeMetaClient) : null;
  const deliver = async (field: string, value: Record<string, unknown>): Promise<Result> => {
    const raw = Buffer.from(JSON.stringify(envelope(channel.wabaId, field, value)));
    const receipt = await receiveWebhook(
      deps.ctx,
      deps.jobs,
      raw,
      signWebhook(raw, deps.secret ?? metaAppSecret(deps.ctx.env)),
    );
    return { kind, field, ...receipt };
  };

  if (kind.startsWith('template_')) {
    if (!opts.templateId || !Types.ObjectId.isValid(opts.templateId)) {
      throw new ValidationError([{ path: 'templateId', message: 'Choose a template' }]);
    }
    const t = await WhatsAppTemplateModel.findOne({
      _id: opts.templateId,
      accountId: channel.accountId,
      wabaId: channel.wabaId,
    }).lean<WhatsAppTemplateDoc>();
    if (!t?.metaTemplateId) throw new NotFoundError('Template not found (submit it first)');
    const ref = {
      message_template_id: t.metaTemplateId,
      message_template_name: t.name,
      message_template_language: t.language,
    };
    const status = (event: string, extra: Record<string, unknown> = {}) => ({
      event,
      ...ref,
      message_template_category: t.category,
      reason: 'NONE',
      ...extra,
    });
    const patch = async (p: Record<string, unknown>) => {
      if (fake) await fake.patchTemplate(channel.wabaId, t.metaTemplateId ?? '', p);
    };
    switch (kind) {
      case 'template_approved':
        await patch({ status: 'APPROVED' });
        return deliver('message_template_status_update', status('APPROVED'));
      case 'template_rejected':
        await patch({ status: 'REJECTED', rejected_reason: 'INVALID_FORMAT' });
        return deliver(
          'message_template_status_update',
          status('REJECTED', {
            reason: 'INVALID_FORMAT',
            rejection_info: {
              reason: 'Invalid format (simulated)',
              recommendation: 'Check the variables and their examples',
            },
          }),
        );
      case 'template_paused':
        await patch({ status: 'PAUSED' });
        return deliver(
          'message_template_status_update',
          status('PAUSED', {
            other_info: { title: 'FIRST_PAUSE', description: 'Paused for low quality (simulated)' },
          }),
        );
      case 'template_disabled':
        await patch({ status: 'DISABLED' });
        return deliver(
          'message_template_status_update',
          status('DISABLED', { disable_info: { disable_date: Math.floor(Date.now() / 1000) } }),
        );
      case 'template_quality_red':
        await patch({ quality_score: { score: 'RED' } });
        return deliver('message_template_quality_update', {
          ...ref,
          previous_quality_score: 'GREEN',
          new_quality_score: 'RED',
        });
      case 'template_category_changed': {
        const next = t.category === 'MARKETING' ? 'UTILITY' : 'MARKETING';
        await patch({ category: next });
        return deliver('template_category_update', {
          ...ref,
          previous_category: t.category,
          new_category: next,
        });
      }
      default:
        return deliver('message_template_components_update', {
          ...ref,
          message_template_element: 'Updated in WhatsApp Manager (simulated)',
        });
    }
  }

  const from = (opts.from ?? SIM_CUSTOMER).replace(/\D/g, '');
  const metadata = {
    display_phone_number: (channel.displayPhoneNumber ?? '').replace(/\D/g, ''),
    phone_number_id: channel.phoneNumberId ?? '',
  };
  switch (kind) {
    case 'user_stopped_marketing':
    case 'user_resumed_marketing':
      return deliver('user_preferences', {
        messaging_product: 'whatsapp',
        metadata,
        contacts: [{ wa_id: from }],
        user_preferences: [
          {
            wa_id: from,
            detail: 'Simulated preference change',
            category: 'marketing_messages',
            value: kind === 'user_stopped_marketing' ? 'stop' : 'resume',
            timestamp: Math.floor(Date.now() / 1000),
          },
        ],
      });
    case 'pricing_tier_update':
      return deliver('account_update', {
        event: 'VOLUME_BASED_PRICING_TIER_UPDATE',
        volume_tier_info: {
          tier_update_time: Math.floor(Date.now() / 1000),
          pricing_category: 'UTILITY',
          tier: '25000001:50000000',
          effective_month: new Date().toISOString().slice(0, 7),
          region: 'India',
        },
      });
    case 'run_template_sync':
      return {
        kind,
        field: '',
        result: await syncTemplates(
          {
            wa: deps.ctx,
            jobs: unavailableTemplateJobs,
            ...(deps.storage ? { storage: deps.storage } : {}),
          },
          channel._id,
          'manual',
        ),
      };
    case 'run_hold_reaper':
      // as if the 72 hours had passed — this account's holds only
      return {
        kind,
        field: '',
        result: await reapWhatsAppHolds(new Date(Date.now() + 73 * 3_600_000), {
          accountId: channel.accountId,
        }),
      };
    case 'run_whatsapp_reconcile':
      return { kind, field: '', result: await runWhatsAppReconcile(deps.ctx) };
    default: {
      if (!opts.messageId || !Types.ObjectId.isValid(opts.messageId)) {
        throw new ValidationError([{ path: 'messageId', message: 'Choose a sent message' }]);
      }
      const m = await MessageModel.findOne({
        _id: opts.messageId,
        channelId: channel._id,
        direction: 'out',
      }).lean<MessageDoc>();
      if (!m?.waMessageId) throw new NotFoundError('Message not found (not sent yet)');
      const conversation = m.billing?.category ?? 'service';
      return deliver('messages', {
        messaging_product: 'whatsapp',
        metadata,
        statuses: [
          {
            id: m.waMessageId,
            status: 'read',
            timestamp: String(Math.floor(Date.now() / 1000)),
            recipient_id: from,
            pricing: {
              billable: true,
              pricing_model: 'PMP',
              category: conversation,
              type: 'regular',
            },
          },
        ],
      });
    }
  }
};
