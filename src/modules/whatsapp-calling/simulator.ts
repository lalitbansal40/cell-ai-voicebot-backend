import { Types } from 'mongoose';

import { metaAppSecret, signWebhook, type FakeMetaClient } from '../../core/meta';
import { ContactModel } from '../../db/models/contact.model';
import { WhatsAppCallPermissionModel } from '../../db/models/whatsapp-call-permission.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors/app-error';
import { openSecret, type WhatsAppContext } from '../whatsapp/context';
import type { WhatsAppJobs } from '../whatsapp/jobs';
import { SIMULATED_CUSTOMER } from '../whatsapp/simulator';
import { receiveWebhook } from '../whatsapp/webhooks.service';

import type { CallingRuntime } from './runtime';
import type { CallingSimulatorKind } from './simulator-kinds';

export interface CallingSimulatorDeps {
  ctx: WhatsAppContext;
  jobs: WhatsAppJobs;
  calling?: CallingRuntime | undefined;
}

export interface CallingSimulatorInput {
  /** The customer (default the simulator's test number). */
  from?: string | undefined;
  /** `user_hangup` / `user_dtmf`: the call (default the newest live one of the number). */
  waCallId?: string | undefined;
  /** `user_dtmf` keys (default `1`). */
  digits?: string | undefined;
}

const digitsOf = (v: string) => v.replace(/\D/g, '');

export const runCallingSimulator = async (
  deps: CallingSimulatorDeps,
  channelId: Types.ObjectId,
  kind: CallingSimulatorKind,
  input: CallingSimulatorInput = {},
): Promise<Record<string, unknown>> => {
  if (deps.ctx.meta.provider !== 'fake') {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'The calling simulator needs the fake Meta.');
  }
  const fake = deps.ctx.meta as FakeMetaClient;
  const channel = await WhatsAppChannelModel.findById(channelId)
    .select('+tokenSealed')
    .lean<WhatsAppChannelDoc>();
  if (!channel?.phoneNumberId) throw new NotFoundError('WhatsApp number not found');
  const pnid = channel.phoneNumberId;
  const from = digitsOf(input.from ?? SIMULATED_CUSTOMER);
  const runtime = (): CallingRuntime => {
    if (!deps.calling) throw new ConflictError('CONFLICT_INVALID_STATE', 'Calling is not running.');
    return deps.calling;
  };
  const deliver = async (field: string, value: Record<string, unknown>) => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        { id: channel.wabaId, time: Math.floor(Date.now() / 1000), changes: [{ field, value }] },
      ],
    };
    const raw = Buffer.from(JSON.stringify(payload));
    return receiveWebhook(deps.ctx, deps.jobs, raw, signWebhook(raw, metaAppSecret(deps.ctx.env)));
  };
  const liveCall = async (): Promise<string> => {
    if (input.waCallId) return input.waCallId;
    const live = (await fake.fakeCalls(pnid)).find((c) => c.state !== 'ended');
    if (!live) throw new ValidationError([{ path: 'waCallId', message: 'No live call' }]);
    return live.waCallId;
  };
  const display = digitsOf(channel.displayPhoneNumber ?? '');

  switch (kind) {
    case 'user_call': {
      const { waCallId } = await fake.userCall(pnid, from);
      return { kind, waCallId };
    }
    case 'user_hangup': {
      const waCallId = await liveCall();
      return { kind, waCallId, ok: await fake.userHangup(waCallId) };
    }
    case 'user_dtmf': {
      const waCallId = await liveCall();
      const keys = input.digits ?? '1';
      if (!/^[0-9*#]{1,20}$/.test(keys)) {
        throw new ValidationError([{ path: 'digits', message: 'Keys 0-9, * and #' }]);
      }
      return { kind, waCallId, ok: await fake.userDtmf(waCallId, keys) };
    }
    case 'permission_reply_accept':
    case 'permission_reply_permanent':
    case 'permission_reply_reject':
      await fake.userPermissionReply(
        pnid,
        from,
        kind === 'permission_reply_accept'
          ? 'accept'
          : kind === 'permission_reply_permanent'
            ? 'permanent'
            : 'reject',
      );
      return { kind };
    case 'permission_expire': {
      // Meta sends no webhook: the time passes at Meta and on our row, then the sweep runs
      const past = new Date(Date.now() - 1_000);
      await fake.setCallPermission(pnid, from, 'temporary', past);
      const contact = await ContactModel.findOne({
        accountId: channel.accountId,
        phoneE164: `+${from}`,
        deletedAt: null,
      })
        .select({ _id: 1 })
        .lean<{ _id: Types.ObjectId }>();
      if (contact) {
        await WhatsAppCallPermissionModel.updateMany(
          {
            accountId: channel.accountId,
            channelId: channel._id,
            contactId: contact._id,
            status: 'temporary',
          },
          { $set: { expiresAt: past } },
        );
      }
      return { kind, ...(await runtime().permissions.sweep()) };
    }
    case 'calling_restricted': {
      const expiresAt = new Date(Date.now() + 86_400_000);
      await fake.setCallingRestriction(pnid, {
        type: 'RESTRICTED_BUSINESS_INITIATED_CALLING',
        expiresAt,
      });
      return {
        kind,
        ...(await deliver('account_update', {
          ...(display ? { phone_number: display } : {}),
          event: 'ACCOUNT_RESTRICTION',
          restriction_info: [
            {
              restriction_type: 'RESTRICTED_BUSINESS_INITIATED_CALLING',
              expiration: Math.floor(expiresAt.getTime() / 1000),
            },
          ],
        })),
      };
    }
    case 'calling_unrestricted':
      // Meta lifts a calling pause in its settings (no account_update): re-read them
      await fake.setCallingRestriction(pnid, null);
      await runtime().settings.syncNow(channel.accountId, channel._id.toString());
      return { kind };
    case 'settings_changed': {
      // the customer-facing setting flips at Meta → Meta's `account_settings_update`
      const token = channel.tokenSealed ? openSecret(deps.ctx, channel.tokenSealed) : '';
      const now = await fake.getPhoneSettings(token, pnid);
      await fake.updateCallingSettings(token, pnid, {
        callbackPermissionStatus:
          now.callbackPermissionStatus === 'ENABLED' ? 'DISABLED' : 'ENABLED',
      });
      return { kind };
    }
    case 'call_tier_update':
      // messaging limit 2,000 — calling becomes available on a number that had 1,000
      return {
        kind,
        ...(await deliver('phone_number_quality_update', {
          display_phone_number: display,
          event: 'UPGRADE',
          current_limit: 'TIER_2K',
          old_limit: 'TIER_1K',
        })),
      };
    case 'run_permission_sweep':
      return { kind, ...(await runtime().permissions.sweep()) };
  }
};

/** Ids for `POST /dev/meta/calls/user-call` (a customer calls the number). */
export const simulateUserCall = (
  deps: CallingSimulatorDeps,
  channelId: string,
  from?: string,
): Promise<Record<string, unknown>> =>
  runCallingSimulator(deps, new Types.ObjectId(channelId), 'user_call', { from });
