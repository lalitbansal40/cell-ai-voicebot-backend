import { randomBytes } from 'node:crypto';

import { Types } from 'mongoose';

import { INBOX_LIMITS } from '../../config/limits';
import { metaAppSecret, signWebhook, type FakeMetaClient } from '../../core/meta';
import type { StorageProvider } from '../../core/storage';
import { ConversationModel, type ConversationDoc } from '../../db/models/conversation.model';
import { MessageModel, type MessageDoc } from '../../db/models/message.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { NotFoundError } from '../../shared/errors/app-error';
import type { WhatsAppContext } from '../whatsapp/context';
import type { WhatsAppJobs } from '../whatsapp/jobs';
import { receiveWebhook, type WebhookReceipt } from '../whatsapp/webhooks.service';

import { DEV_MEDIA } from './dev-media';
import { emitConversation } from './events';
import { runInboxRetention } from './retention.job';
import { INBOX_SIMULATOR_KINDS, type InboxSimulatorKind } from './simulator-kinds';

export { INBOX_SIMULATOR_KINDS, type InboxSimulatorKind } from './simulator-kinds';

/** Default test customer (never a real number). */
export const SIM_CUSTOMER = '919000010101';
const DAY = 86_400_000;

export interface InboxSimulatorOptions {
  /** Customer number (digits / E.164); default `SIM_CUSTOMER`. */
  from?: string | undefined;
  text?: string | undefined;
  conversationId?: string | undefined;
  /** `age_messages`: days back (default 91). */
  days?: number | undefined;
}

const wamid = () => `wamid.SIM${randomBytes(12).toString('hex').toUpperCase()}`;
const digits = (v: string) => v.replace(/\D/g, '');

const lastOutgoing = (
  conversationId: Types.ObjectId | undefined,
  filter: Record<string, unknown> = {},
) =>
  conversationId
    ? MessageModel.findOne({
        conversationId,
        direction: 'out',
        waMessageId: { $type: 'string' },
        ...filter,
      })
        .sort({ at: -1, _id: -1 })
        .lean<MessageDoc>()
    : Promise.resolve(null);

/**
 * DEV / TEST ONLY — one simulated inbox event for a number (PHASE_10 §1o). Webhook
 * kinds are Meta-shaped, signed and handed to the real receiver; `window_expired`,
 * `age_messages` and `run_retention` change data directly so the closed-window and
 * retention states can be tried.
 */
export const runInboxSimulator = async (
  deps: {
    ctx: WhatsAppContext;
    jobs: WhatsAppJobs;
    storage?: StorageProvider | undefined;
    /** Tests: sign with another secret (the receiver must refuse it). */
    secret?: string | undefined;
  },
  channelId: Types.ObjectId,
  kind: InboxSimulatorKind,
  opts: InboxSimulatorOptions = {},
): Promise<{ kind: InboxSimulatorKind; field: string } & WebhookReceipt> => {
  const channel = await WhatsAppChannelModel.findById(channelId).lean<WhatsAppChannelDoc>();
  if (!channel) throw new NotFoundError('WhatsApp number not found');
  const conversation = opts.conversationId
    ? await ConversationModel.findOne({
        _id: new Types.ObjectId(opts.conversationId),
        channelId,
      }).lean<ConversationDoc>()
    : null;
  if (opts.conversationId && !conversation) throw new NotFoundError('Conversation not found');
  const from = conversation?.waId ?? (opts.from ? digits(opts.from) : SIM_CUSTOMER);
  const conv =
    conversation ??
    (await ConversationModel.findOne({ channelId, waId: from }).lean<ConversationDoc>());
  const none = { kind, field: '', received: 0, duplicates: 0, ignored: false };

  if (kind === 'window_expired') {
    if (!conv) throw new NotFoundError('Conversation not found');
    const at = new Date(Date.now() - 25 * 3_600_000);
    const updated = await ConversationModel.findOneAndUpdate(
      { _id: conv._id },
      {
        $set: {
          lastInboundAt: at,
          windowExpiresAt: new Date(at.getTime() + INBOX_LIMITS.windowMs),
        },
      },
      { returnDocument: 'after' },
    ).lean<ConversationDoc>();
    if (updated) emitConversation(updated);
    return none;
  }
  if (kind === 'age_messages') {
    if (!conv) throw new NotFoundError('Conversation not found');
    const shift = (opts.days ?? 91) * DAY;
    await MessageModel.updateMany(
      { conversationId: conv._id },
      [{ $set: { at: { $subtract: ['$at', shift] } } }],
      { updatePipeline: true },
    );
    return none;
  }
  if (kind === 'run_retention') {
    if (deps.storage) await runInboxRetention(deps.storage, deps.ctx.env.INBOX_RETENTION_DAYS);
    return none;
  }

  const fake = deps.ctx.meta.provider === 'fake' ? (deps.ctx.meta as FakeMetaClient) : null;
  const ts = String(Math.floor(Date.now() / 1000));
  const display = digits(channel.displayPhoneNumber ?? '');
  const metadata = { display_phone_number: display, phone_number_id: channel.phoneNumberId ?? '' };
  const base = { from, id: wamid(), timestamp: ts };
  const media = async (type: keyof typeof DEV_MEDIA, extra: Record<string, unknown> = {}) => {
    const m = DEV_MEDIA[type]();
    const id = fake
      ? await fake.putMedia(m.bytes, m.mime.split(';')[0] ?? m.mime, m.fileName)
      : `sim_media_${randomBytes(6).toString('hex')}`;
    const metaType = type === 'voice' ? 'audio' : type;
    return {
      ...base,
      type: metaType,
      [metaType]: {
        id,
        mime_type: m.mime,
        sha256: 'c2ltdWxhdGVk',
        ...(type === 'voice' ? { voice: true } : {}),
        ...(m.fileName ? { filename: m.fileName } : {}),
        ...extra,
      },
    };
  };
  const text = (body: string, extra: Record<string, unknown> = {}) => ({
    ...base,
    type: 'text',
    text: { body },
    ...extra,
  });
  const context = async (filter: Record<string, unknown> = {}) => {
    const target = await lastOutgoing(conv?._id, filter);
    return target?.waMessageId ? { context: { from: display, id: target.waMessageId } } : {};
  };

  let message: Record<string, unknown> | null = null;
  let statuses: Record<string, unknown>[] | null = null;
  switch (kind) {
    case 'inbound_text':
      message = text(opts.text ?? 'Test hello from the simulator');
      break;
    case 'inbound_image':
      message = await media('image', { caption: opts.text ?? 'Test photo' });
      break;
    case 'inbound_video':
      message = await media('video', opts.text ? { caption: opts.text } : {});
      break;
    case 'inbound_audio':
      message = await media('audio', { voice: false });
      break;
    case 'inbound_voice':
      message = await media('voice');
      break;
    case 'inbound_document':
      message = await media('document', opts.text ? { caption: opts.text } : {});
      break;
    case 'inbound_sticker':
      message = await media('sticker', { animated: false });
      break;
    case 'inbound_location':
      message = {
        ...base,
        type: 'location',
        location: {
          latitude: 26.9124,
          longitude: 75.7873,
          name: opts.text ?? 'Test Office',
          address: 'Test Road, Jaipur',
        },
      };
      break;
    case 'inbound_contacts':
      message = {
        ...base,
        type: 'contacts',
        contacts: [
          {
            name: { formatted_name: opts.text ?? 'Test Friend' },
            phones: [{ phone: '+91 90000 00202', type: 'CELL', wa_id: '919000000202' }],
          },
        ],
      };
      break;
    case 'inbound_button_reply': {
      const asked = await lastOutgoing(conv?._id, {
        type: 'interactive',
        'interactive.kind': 'button',
      });
      const button = asked?.interactive?.buttons[0];
      message = {
        ...base,
        type: 'interactive',
        ...(asked?.waMessageId ? { context: { from: display, id: asked.waMessageId } } : {}),
        interactive: {
          type: 'button_reply',
          button_reply: { id: button?.id ?? 'yes', title: opts.text ?? button?.title ?? 'Yes' },
        },
      };
      break;
    }
    case 'inbound_list_reply': {
      const asked = await lastOutgoing(conv?._id, {
        type: 'interactive',
        'interactive.kind': 'list',
      });
      const row = asked?.interactive?.sections[0]?.rows[0];
      message = {
        ...base,
        type: 'interactive',
        ...(asked?.waMessageId ? { context: { from: display, id: asked.waMessageId } } : {}),
        interactive: {
          type: 'list_reply',
          list_reply: {
            id: row?.id ?? 'row_1',
            title: row?.title ?? 'Option 1',
            description: row?.description ?? null,
          },
        },
      };
      break;
    }
    case 'inbound_template_button':
      message = {
        ...base,
        type: 'button',
        ...(await context()),
        button: { payload: 'SIM_PAYLOAD', text: opts.text ?? 'Remind me later' },
      };
      break;
    case 'inbound_reaction': {
      const target = await lastOutgoing(conv?._id, { type: { $nin: ['reaction', 'note'] } });
      message = {
        ...base,
        type: 'reaction',
        reaction: { message_id: target?.waMessageId ?? wamid(), emoji: opts.text ?? '👍' },
      };
      break;
    }
    case 'inbound_reply':
      message = text(
        opts.text ?? 'Test reply to your message',
        await context({ type: { $nin: ['reaction', 'note'] } }),
      );
      break;
    case 'inbound_forwarded':
      message = text(opts.text ?? 'Test forwarded text', {
        context: { forwarded: true, frequently_forwarded: true },
      });
      break;
    case 'inbound_ad_referral':
      message = text(opts.text ?? 'Hi, I saw your ad', {
        referral: {
          source_url: 'https://fb.me/test-ad',
          source_id: '120000000000001',
          source_type: 'ad',
          headline: 'Test ad headline',
          body: 'Test ad body',
          ctwa_clid: 'sim-clid',
        },
      });
      break;
    case 'inbound_order':
      message = {
        ...base,
        type: 'order',
        order: {
          catalog_id: 'sim-catalog',
          text: opts.text ?? null,
          product_items: [
            { product_retailer_id: 'sku-1', quantity: 2, item_price: 250, currency: 'INR' },
          ],
        },
      };
      break;
    case 'inbound_nfm_reply':
      message = {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'nfm_reply',
          nfm_reply: {
            response_json: '{"flow_token":"sim","choice":"A"}',
            body: 'Sent',
            name: 'flow',
          },
        },
      };
      break;
    case 'inbound_unsupported':
      message = {
        ...base,
        type: 'unsupported',
        errors: [{ code: 131051, title: 'Message type unknown', message: 'Message type unknown' }],
      };
      break;
    case 'inbound_number_changed':
      message = {
        ...base,
        type: 'system',
        system: {
          body: 'The customer changed their number',
          new_wa_id: '919000000909',
          type: 'user_changed_number',
        },
      };
      break;
    case 'inbound_stop':
      message = text('STOP');
      break;
    case 'inbound_start':
      message = text('START');
      break;
    case 'inbound_stop_hinglish':
      message = text('band karo');
      break;
    case 'inbound_stop_hindi':
      message = text('बंद करो');
      break;
    case 'inbound_deleted': {
      const target = conv
        ? await MessageModel.findOne({
            conversationId: conv._id,
            direction: 'in',
            origin: 'customer',
            status: 'received',
          })
            .sort({ at: -1 })
            .lean<MessageDoc>()
        : null;
      statuses = [
        {
          id: target?.waMessageId ?? wamid(),
          status: 'deleted',
          timestamp: ts,
          recipient_id: from,
        },
      ];
      break;
    }
    case 'status_failed': {
      const target = await lastOutgoing(conv?._id, {
        status: { $in: ['accepted', 'sent', 'delivered'] },
      });
      statuses = [
        {
          id: target?.waMessageId ?? wamid(),
          status: 'failed',
          timestamp: ts,
          recipient_id: from,
          errors: [
            { code: 131026, title: 'Message undeliverable', message: 'Message undeliverable' },
          ],
        },
      ];
      break;
    }
  }
  const value = {
    messaging_product: 'whatsapp',
    metadata,
    ...(message
      ? { contacts: [{ profile: { name: 'Test Customer' }, wa_id: from }], messages: [message] }
      : {}),
    ...(statuses ? { statuses } : {}),
  };
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ id: channel.wabaId, time: Number(ts), changes: [{ field: 'messages', value }] }],
  };
  const raw = Buffer.from(JSON.stringify(payload));
  const receipt = await receiveWebhook(
    deps.ctx,
    deps.jobs,
    raw,
    signWebhook(raw, deps.secret ?? metaAppSecret(deps.ctx.env)),
  );
  return { kind, field: 'messages', ...receipt };
};

export const isInboxSimulatorKind = (kind: string): kind is InboxSimulatorKind =>
  (INBOX_SIMULATOR_KINDS as readonly string[]).includes(kind);
