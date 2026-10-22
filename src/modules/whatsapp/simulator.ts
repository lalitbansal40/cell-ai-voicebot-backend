import { randomBytes } from 'node:crypto';

import type { Types } from 'mongoose';

import {
  metaAppSecret,
  signWebhook,
  type FakeMetaClient,
  type WebhookField,
} from '../../core/meta';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { NotFoundError } from '../../shared/errors/app-error';

import { openSecret, type WhatsAppContext } from './context';
import type { WhatsAppJobs } from './jobs';
import { receiveWebhook, type WebhookReceipt } from './webhooks.service';

/** Dev webhook simulator kinds (§1j) — Meta-shaped payloads, same pipeline as Meta's. */
export const SIMULATOR_KINDS = [
  'quality_downgrade',
  'quality_upgrade',
  'flagged',
  'name_approved',
  'name_rejected',
  'restricted',
  'unrestricted',
  'token_revoked',
  'inbound_text',
  'status_delivered',
  'echo_text',
  'history_chunk',
  'history_declined',
  'contacts_sync',
  'payment_method_added',
] as const;
export type SimulatorKind = (typeof SIMULATOR_KINDS)[number];

/** Test customer of every simulated message (never a real number). */
export const SIMULATED_CUSTOMER = '919000010101';

type SimChannel = Pick<
  WhatsAppChannelDoc,
  'wabaId' | 'phoneNumberId' | 'displayPhoneNumber' | 'verifiedName'
>;

const wamid = () => `wamid.SIM${randomBytes(12).toString('hex').toUpperCase()}`;

/** `{ object, entry: [{ id: WABA, time, changes: [{ field, value }] }] }` for one kind. */
export const buildSimulatorPayload = (
  kind: SimulatorKind,
  channel: SimChannel,
  nowSec = Math.floor(Date.now() / 1000),
): Record<string, unknown> => {
  const display = (channel.displayPhoneNumber ?? '').replace(/\D/g, '');
  const metadata = { display_phone_number: display, phone_number_id: channel.phoneNumberId ?? '' };
  // account updates name the number only when it has one
  const phoneField = display ? { phone_number: display } : {};
  const ts = String(nowSec);
  const change = ((): { field: WebhookField; value: Record<string, unknown> } => {
    switch (kind) {
      case 'quality_downgrade':
        return {
          field: 'phone_number_quality_update',
          value: {
            display_phone_number: display,
            event: 'DOWNGRADE',
            current_limit: 'TIER_250',
            old_limit: 'TIER_1K',
          },
        };
      case 'quality_upgrade':
        return {
          field: 'phone_number_quality_update',
          value: {
            display_phone_number: display,
            event: 'UPGRADE',
            current_limit: 'TIER_10K',
            old_limit: 'TIER_1K',
          },
        };
      case 'flagged':
        return {
          field: 'phone_number_quality_update',
          value: { display_phone_number: display, event: 'FLAGGED', current_limit: 'TIER_250' },
        };
      case 'name_approved':
      case 'name_rejected':
        return {
          field: 'phone_number_name_update',
          value: {
            display_phone_number: display,
            decision: kind === 'name_approved' ? 'APPROVED' : 'REJECTED',
            requested_verified_name: channel.verifiedName ?? 'Test Business',
            rejection_reason: kind === 'name_approved' ? 'NONE' : 'FORMATTING',
          },
        };
      case 'restricted':
        return {
          field: 'account_update',
          value: {
            ...phoneField,
            event: 'ACCOUNT_RESTRICTION',
            restriction_info: [
              {
                restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING',
                expiration: nowSec + 86_400,
              },
            ],
          },
        };
      case 'unrestricted':
        return {
          field: 'account_update',
          value: { ...phoneField, event: 'ACCOUNT_RESTRICTION', restriction_info: [] },
        };
      case 'token_revoked':
      case 'payment_method_added':
        // Meta sends no event for these; an account update makes the app re-check the number
        return {
          field: 'account_update',
          value: { ...phoneField, event: 'ACCOUNT_UPDATE' },
        };
      case 'inbound_text':
        return {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata,
            contacts: [{ profile: { name: 'Test Customer' }, wa_id: SIMULATED_CUSTOMER }],
            messages: [
              {
                from: SIMULATED_CUSTOMER,
                id: wamid(),
                timestamp: ts,
                type: 'text',
                text: { body: 'Test hello from the simulator' },
              },
            ],
          },
        };
      case 'status_delivered':
        return {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata,
            statuses: [
              { id: wamid(), status: 'delivered', timestamp: ts, recipient_id: SIMULATED_CUSTOMER },
            ],
          },
        };
      case 'echo_text':
        return {
          field: 'smb_message_echoes',
          value: {
            messaging_product: 'whatsapp',
            metadata,
            message_echoes: [
              {
                from: display,
                to: SIMULATED_CUSTOMER,
                id: wamid(),
                timestamp: ts,
                type: 'text',
                text: { body: 'Test reply from the business phone' },
              },
            ],
          },
        };
      case 'history_chunk':
        return {
          field: 'history',
          value: {
            messaging_product: 'whatsapp',
            metadata,
            history: [
              {
                metadata: { phase: 2, chunk_order: 1, progress: 100 },
                threads: [
                  {
                    id: SIMULATED_CUSTOMER,
                    messages: [
                      {
                        from: SIMULATED_CUSTOMER,
                        id: wamid(),
                        timestamp: String(nowSec - 86_400),
                        type: 'text',
                        text: { body: 'Test old message' },
                        history_context: { status: 'READ' },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        };
      case 'history_declined':
        return {
          field: 'history',
          value: {
            messaging_product: 'whatsapp',
            metadata,
            history: [
              {
                errors: [{ code: 2593109, title: 'History sharing is turned off by the business' }],
              },
            ],
          },
        };
      case 'contacts_sync':
        return {
          field: 'smb_app_state_sync',
          value: {
            messaging_product: 'whatsapp',
            metadata,
            state_sync: [
              {
                type: 'contact',
                contact: {
                  full_name: 'Test Customer',
                  first_name: 'Test',
                  phone_number: SIMULATED_CUSTOMER,
                },
                action: 'add',
                metadata: { timestamp: ts },
              },
            ],
          },
        };
    }
  })();
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: channel.wabaId, time: nowSec, changes: [change] }],
  };
};

/**
 * What the fake Meta should report afterwards (so the re-check after the event
 * agrees with it). `token` is the channel's opened token (token_revoked).
 */
export const applySimulatorEffects = async (
  fake: FakeMetaClient,
  kind: SimulatorKind,
  channel: SimChannel,
  token: string | null,
): Promise<void> => {
  const phone = channel.phoneNumberId ?? '';
  if (kind === 'quality_downgrade')
    await fake.patchPhone(phone, { quality_rating: 'YELLOW', messaging_limit_tier: 'TIER_250' });
  if (kind === 'flagged')
    await fake.patchPhone(phone, { quality_rating: 'RED', messaging_limit_tier: 'TIER_250' });
  if (kind === 'quality_upgrade')
    await fake.patchPhone(phone, { quality_rating: 'GREEN', messaging_limit_tier: 'TIER_10K' });
  if (kind === 'name_approved')
    await fake.patchPhone(phone, { name_status: 'APPROVED', new_name_status: 'NONE' });
  if (kind === 'name_rejected') await fake.patchPhone(phone, { new_name_status: 'DECLINED' });
  if (kind === 'token_revoked' && token) await fake.revokeToken(token);
  if (kind === 'payment_method_added') await fake.addPaymentMethod(channel.wabaId);
};

/**
 * One simulated Meta event (dev only): updates the fake Meta, builds the payload,
 * signs it with the app secret and hands it to the real webhook receiver — the
 * effect comes from the pipeline (signature → store → queue → worker).
 */
export const runSimulator = async (
  deps: { ctx: WhatsAppContext; jobs: WhatsAppJobs },
  channelId: Types.ObjectId,
  kind: SimulatorKind,
  /** Signing secret (default: the active app secret; tests pass a wrong one). */
  secret: string = metaAppSecret(deps.ctx.env),
): Promise<{ kind: SimulatorKind; field: string } & WebhookReceipt> => {
  const channel = await WhatsAppChannelModel.findById(channelId)
    .select('+tokenSealed')
    .lean<WhatsAppChannelDoc>();
  if (!channel) throw new NotFoundError('WhatsApp number not found');
  if (deps.ctx.meta.provider === 'fake') {
    let token: string | null = null;
    try {
      token = channel.tokenSealed ? openSecret(deps.ctx, channel.tokenSealed) : null;
    } catch {
      token = null;
    }
    await applySimulatorEffects(deps.ctx.meta as FakeMetaClient, kind, channel, token);
  }
  const payload = buildSimulatorPayload(kind, channel);
  const raw = Buffer.from(JSON.stringify(payload));
  const receipt = await receiveWebhook(deps.ctx, deps.jobs, raw, signWebhook(raw, secret));
  const field = (payload.entry as { changes: { field: string }[] }[])[0]?.changes[0]?.field ?? '';
  return { kind, field, ...receipt };
};
