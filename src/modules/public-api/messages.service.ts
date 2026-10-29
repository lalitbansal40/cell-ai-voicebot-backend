import type { Request } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';

import type { MessageDoc } from '../../db/models/message.model';
import {
  WA_ACTIVE_STATUSES,
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { WhatsAppTemplateModel } from '../../db/models/whatsapp-template.model';
import { actingUserId, requireAuth } from '../../shared/auth/auth-context';
import { AppError, NotFoundError, ValidationError } from '../../shared/errors/app-error';
import { IDEMPOTENCY_HEADER } from '../../shared/middlewares/idempotency';
import { sha256Hex } from '../auth/hmac';
import type { InboxContext } from '../inbox/context';
import { findMessage, startConversation, type InboxActor } from '../inbox/conversations.service';
import { sendMessage } from '../inbox/outbound.service';

import { findOrCreateByPhone } from './contacts-upsert.service';
import type { SendTemplateApiBody, SendTextApiBody } from './messages.schema';

type Recipient = {
  to?: string | undefined;
  contactId?: string | undefined;
  channelId?: string | undefined;
};

/** A key acts for its creator; the audit names the key (same as the dashboard otherwise). */
const actorOf = (req: Request): InboxActor => {
  const auth = requireAuth(req);
  const userId = new Types.ObjectId(actingUserId(auth));
  return {
    accountId: new Types.ObjectId(auth.accountId),
    userId,
    type: auth.kind === 'api_key' ? 'api_key' : 'user',
    id: auth.kind === 'api_key' ? new Types.ObjectId(auth.apiKeyId) : userId,
    impersonatorId: auth.impersonatorId ?? null,
    ip: req.ip ?? null,
  };
};

/** The chosen number, or the account's only connected one. */
const channelFor = async (accountId: Types.ObjectId, channelId?: string) => {
  const channels = await WhatsAppChannelModel.find({
    accountId,
    status: { $in: WA_ACTIVE_STATUSES },
    ...(channelId ? { _id: new Types.ObjectId(channelId) } : {}),
  })
    .limit(2)
    .lean<WhatsAppChannelDoc[]>();
  if (!channels.length) throw new NotFoundError('WhatsApp number not found');
  if (channels.length > 1) {
    throw new ValidationError([
      { path: 'channelId', message: 'This account has more than one WhatsApp number — choose one' },
    ]);
  }
  return channels[0] as WhatsAppChannelDoc;
};

/** Keys send as `api`; a person using the same route sends as `agent` (like the inbox). */
const originOf = (req: Request): 'api' | 'agent' =>
  requireAuth(req).kind === 'api_key' ? 'api' : 'agent';

/** Same Idempotency-Key → same client id → `sendMessage` returns the first message. */
const clientIdOf = (req: Request, accountId: Types.ObjectId): string => {
  const key = req.get(IDEMPOTENCY_HEADER) ?? new Types.ObjectId().toString();
  return `api-${sha256Hex(`${accountId.toString()}:${key}`).slice(0, 40)}`;
};

const conversationFor = async (ix: InboxContext, req: Request, body: Recipient) => {
  const actor = actorOf(req);
  const channel = await channelFor(actor.accountId, body.channelId);
  const contactId = body.contactId ?? (await findOrCreateByPhone(req, body.to ?? ''));
  const conv = await startConversation(ix, actor, {
    channelId: channel._id.toString(),
    contactId,
  });
  return { actor, channel, conversationId: conv.id };
};

/** What the public API shows of a message (never texts, phones or media). */
export const apiMessageView = (m: MessageDoc) => ({
  id: m._id.toString(),
  conversationId: m.conversationId.toString(),
  contactId: m.contactId.toString(),
  channelId: m.channelId.toString(),
  direction: m.direction,
  type: m.type,
  origin: m.origin,
  status: m.status,
  statusHistory: (m.statusHistory ?? []).map((h) => ({ status: h.status, at: h.at.toISOString() })),
  error: m.error ? { code: m.error.code, reason: m.error.reason } : null,
  charge: m.billing
    ? { category: m.billing.category, priceMicros: m.billing.priceMicros, status: m.billing.status }
    : null,
  template: m.template ? { name: m.template.name, language: m.template.language } : null,
  externalRef: m.externalRef ?? null,
  at: m.at.toISOString(),
});

/**
 * `POST /messages/template` (PHASE_15_PLAN §1b): contact + chat created if needed,
 * then the dashboard's template send (approved template, variables, marketing limit,
 * opt-out, DND, wallet hold) with `origin: 'api'`.
 */
export const sendTemplateMessage = async (
  ix: InboxContext,
  req: Request,
  body: z.infer<typeof SendTemplateApiBody>,
) => {
  const { actor, channel, conversationId } = await conversationFor(ix, req, body);
  const template = await WhatsAppTemplateModel.findOne({
    accountId: actor.accountId,
    wabaId: channel.wabaId,
    name: body.template.name,
    language: body.template.language,
    deletedAt: null,
  })
    .select({ _id: 1 })
    .lean();
  if (!template) throw new AppError('TEMPLATE_NOT_FOUND');
  const r = await sendMessage(
    ix,
    actor,
    conversationId,
    {
      type: 'template',
      templateId: template._id.toString(),
      clientId: clientIdOf(req, actor.accountId),
      ...(body.variables ? { variables: body.variables } : {}),
      ...(body.header ? { header: body.header } : {}),
    },
    { origin: originOf(req), externalRef: body.externalRef ?? null },
  );
  return { message: apiMessageView(r.message), created: r.created };
};

/** `POST /messages/text` — inside the 24-hour window only (409 WHATSAPP_WINDOW_CLOSED). */
export const sendTextMessage = async (
  ix: InboxContext,
  req: Request,
  body: z.infer<typeof SendTextApiBody>,
) => {
  const { actor, conversationId } = await conversationFor(ix, req, body);
  const r = await sendMessage(
    ix,
    actor,
    conversationId,
    { type: 'text', text: body.text, clientId: clientIdOf(req, actor.accountId) },
    { origin: originOf(req), externalRef: body.externalRef ?? null },
  );
  return { message: apiMessageView(r.message), created: r.created };
};

/** `GET /messages/:id` — any message of the account. */
export const getApiMessage = async (req: Request, id: string) =>
  apiMessageView(
    await findMessage({ accountId: new Types.ObjectId(requireAuth(req).accountId) }, id),
  );
