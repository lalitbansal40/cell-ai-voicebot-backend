import { Types } from 'mongoose';

import { META_CALL_DIAG } from '../../config/limits';
import { FAKE_META_APP_ID, graphError, REQUIRED_META_SCOPES } from '../../core/meta';
import { AccountModel } from '../../db/models/account.model';
import { MetaCallErrorModel } from '../../db/models/meta-call-error.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { AppError, NotFoundError } from '../../shared/errors/app-error';
import { recordAudit, type AuditActorInput } from '../audit/audit.service';
import { callingClientFor, type WhatsAppContext } from '../whatsapp/context';

import { LOW_TIERS } from './availability';
import { metaCallErrorOf } from './errors';
import { recordMetaCallError } from './meta-errors';

export interface CallingDiagnoseStep {
  key: 'token' | 'phone' | 'settings' | 'webhook' | 'send' | 'permission';
  ok: boolean;
  detail: string;
  metaCode: number | null;
}

/** A call id that never exists: the "send" probe of Test calling API places nothing. */
export const SEND_PROBE_CALL_ID = 'wacid.notifynow-permission-probe';

/** Meta's "you may not send on behalf of this WABA" family (code 10 / 200). */
export const isSendPermissionError = (metaCode: number | null): boolean =>
  metaCode === 10 || metaCode === 200;

export const SEND_PERMISSION_HINT =
  "our Meta app may read this WhatsApp account but not place / answer calls on it. Check that the app's whatsapp_business_messaging permission has Advanced access (App Review) and, for a number billed on a partner's credit line, that our app and the partner are in one Multi-Partner Solution for this WABA.";

export const createCallingDiagnose = (
  ctx: WhatsAppContext,
  tokenFor: (
    channelId: Types.ObjectId | string,
  ) => Promise<{ channel: WhatsAppChannelDoc; token: string }>,
) => ({
  async diagnose(
    accountId: Types.ObjectId,
    channelId: string,
    actor: AuditActorInput,
    input: { contactPhone?: string },
  ) {
    if (!Types.ObjectId.isValid(channelId)) throw new NotFoundError('WhatsApp number not found');
    const rl = `wa:diagnose:${channelId}`;
    const count = await ctx.redis.incr(rl);
    if (count === 1) await ctx.redis.expire(rl, 600);
    if (count > META_CALL_DIAG.diagnosePer10Min) {
      throw new AppError(
        'RATE_LIMITED',
        'Too many checks for this number. Try again in 10 minutes.',
      );
    }
    const { channel, token: businessToken } = await tokenFor(channelId);
    if (!channel.accountId.equals(accountId)) throw new NotFoundError('WhatsApp number not found');
    const { api, token, via } = callingClientFor(ctx, channel, businessToken);
    const steps: CallingDiagnoseStep[] = [];
    const run = async (
      key: CallingDiagnoseStep['key'],
      op: Parameters<typeof metaCallErrorOf>[1],
      task: () => Promise<{ ok: boolean; detail: string; metaCode?: number | null }>,
    ) => {
      try {
        const out = await task();
        steps.push({ key, ok: out.ok, detail: out.detail, metaCode: out.metaCode ?? null });
      } catch (err) {
        const diag = metaCallErrorOf(err, op);
        await recordMetaCallError(ctx, { channel, op, err, via });
        steps.push({
          key,
          ok: false,
          detail: diag.message.slice(0, 300),
          metaCode: diag.metaCode,
        });
      }
    };

    if (api.provider === 'pinnacle') {
      const unsupported: CallingDiagnoseStep['key'][] = [
        'token',
        'phone',
        'settings',
        'webhook',
        'send',
      ];
      if (input.contactPhone) unsupported.push('permission');
      for (const key of unsupported)
        steps.push({ key, ok: false, detail: 'provider_unsupported', metaCode: null });
    } else {
      await run('token', 'settings.get', async () => {
        const debug = await api.debugToken(token);
        const scopesOk = REQUIRED_META_SCOPES.every((scope) => debug.scopes.includes(scope));
        const wabaOk =
          !debug.grantedWabaIds.length || debug.grantedWabaIds.includes(channel.wabaId);
        const ok = debug.isValid && scopesOk && wabaOk;
        if (!debug.isValid) {
          const invalidToken = graphError(401, {
            error: {
              code: 190,
              type: 'OAuthException',
              message: 'The calling token is invalid.',
            },
          });
          await recordMetaCallError(ctx, { channel, op: 'settings.get', err: invalidToken, via });
        }
        return {
          ok,
          metaCode: debug.isValid ? null : 190,
          detail: ok
            ? 'Token valid; required scopes and WABA access are present.'
            : 'Token is invalid or missing required scopes / WABA access.',
        };
      });
      await run('phone', 'settings.get', async () => {
        const phone = await api.getPhoneCallingFacts(token, channel.phoneNumberId ?? '');
        await WhatsAppChannelModel.updateOne(
          { _id: channel._id, accountId },
          {
            $set: {
              messagingLimitTier: phone.messagingLimitTier,
              qualityRating: phone.qualityRating,
              platformType: phone.platformType,
            },
          },
        );
        const lowTier = Boolean(
          phone.messagingLimitTier && LOW_TIERS.has(phone.messagingLimitTier),
        );
        const ok =
          !lowTier && (!phone.platformType || phone.platformType.toUpperCase() === 'CLOUD_API');
        return {
          ok,
          detail: lowTier
            ? `Messaging limit ${phone.messagingLimitTier} is below the 2,000/day threshold Meta requires for calling.`
            : `Tier ${phone.messagingLimitTier ?? 'unknown'} · quality ${phone.qualityRating} · platform ${phone.platformType ?? 'unknown'} · name ${phone.nameStatus ?? 'unknown'}.`,
        };
      });
      await run('settings', 'settings.get', async () => {
        const settings = await api.getPhoneSettings(token, channel.phoneNumberId ?? '');
        const restrictions = settings.restrictions ?? [];
        const ok = settings.status === 'ENABLED' && restrictions.length === 0;
        return {
          ok,
          detail: `Calling ${settings.status ?? 'unknown'}; ${restrictions.length} active restriction(s).`,
        };
      });
      await run('webhook', 'settings.get', async () => {
        const [appSubs, wabaApps] = await Promise.all([
          api.getAppSubscriptions(),
          api.getSubscribedApps(token, channel.wabaId),
        ]);
        const app = appSubs.find((s) => s.object === 'whatsapp_business_account');
        const callsField = Boolean(app?.fields.includes('calls'));
        const expectedAppId = api.provider === 'fake' ? FAKE_META_APP_ID : ctx.env.META_APP_ID;
        const subscribed = wabaApps.some((s) => s.appId === expectedAppId);
        return {
          ok: callsField && subscribed,
          detail: `App subscribed: ${subscribed ? 'yes' : 'no'}; calls webhook field: ${callsField ? 'yes' : 'no'}.`,
        };
      });
      // WCF: may our app act on calls of this WABA? A terminate of a call id that doesn't exist
      // places nothing: Meta answers a permission error (10 / 200) when our app may not "send on
      // behalf" of the WABA, any other error (unknown call) when it may.
      await run('send', 'calls.terminate', async () => {
        try {
          await api.terminateCall(token, channel.phoneNumberId ?? '', SEND_PROBE_CALL_ID);
          return { ok: true, detail: 'Meta accepts call actions from our app on this number.' };
        } catch (err) {
          const diag = metaCallErrorOf(err, 'calls.terminate');
          if (isSendPermissionError(diag.metaCode)) {
            await recordMetaCallError(ctx, { channel, op: 'calls.terminate', err, via });
            return {
              ok: false,
              metaCode: diag.metaCode,
              detail: `${diag.message.slice(0, 200)} — ${SEND_PERMISSION_HINT}`,
            };
          }
          if (diag.metaCode === 190) {
            return {
              ok: false,
              metaCode: 190,
              detail: 'The calling token is invalid — Calls via Meta direct → Check / Fix.',
            };
          }
          return {
            ok: true,
            metaCode: diag.metaCode,
            detail: 'Meta accepts call actions from our app on this number (test call id unknown).',
          };
        }
      });
      if (input.contactPhone) {
        const waId = input.contactPhone.replace(/\D/g, '');
        await run('permission', 'permissions.get', async () => {
          const permission = await api.getCallPermissions(token, channel.phoneNumberId ?? '', waId);
          return {
            ok: permission.status !== 'no_permission',
            detail: `Customer permission: ${permission.status.replace(/_/g, ' ')}.`,
          };
        });
      }
    }
    const failedKeys = steps.filter((step) => !step.ok).map((step) => step.key);
    await recordAudit({
      accountId,
      actor,
      action: 'whatsapp.calling_diagnosed',
      target: { type: 'whatsapp_channel', id: channelId },
      meta: { ok: failedKeys.length === 0, failedKeys },
    });
    return { channelId, steps, checkedAt: new Date().toISOString() };
  },
});

export const listMetaCallErrors = async (input: {
  accountId?: string;
  channelId?: string;
  limit?: number;
}) => {
  const filter: Record<string, unknown> = {};
  if (input.accountId && Types.ObjectId.isValid(input.accountId))
    filter.accountId = new Types.ObjectId(input.accountId);
  if (input.channelId && Types.ObjectId.isValid(input.channelId))
    filter.channelId = new Types.ObjectId(input.channelId);
  const rows = await MetaCallErrorModel.find(filter)
    .sort({ at: -1 })
    .limit(Math.min(input.limit ?? META_CALL_DIAG.listLimit, META_CALL_DIAG.listLimit))
    .lean();
  const accounts = [...new Set(rows.map((row) => row.accountId.toString()))].map(
    (id) => new Types.ObjectId(id),
  );
  const channels = [...new Set(rows.map((row) => row.channelId.toString()))].map(
    (id) => new Types.ObjectId(id),
  );
  const [accountRows, channelRows] = await Promise.all([
    AccountModel.find({ _id: { $in: accounts } })
      .select({ name: 1 })
      .lean(),
    WhatsAppChannelModel.find({ _id: { $in: channels } })
      .select({ displayPhoneNumber: 1, phoneNumberId: 1 })
      .lean(),
  ]);
  const names = new Map(accountRows.map((row) => [row._id.toString(), row.name]));
  const numbers = new Map(
    channelRows.map((row) => [
      row._id.toString(),
      row.displayPhoneNumber ?? row.phoneNumberId ?? '',
    ]),
  );
  return rows.map((row) => ({
    id: row._id.toString(),
    accountId: row.accountId.toString(),
    accountName: names.get(row.accountId.toString()) ?? 'Deleted account',
    channelId: row.channelId.toString(),
    numberLast4: (numbers.get(row.channelId.toString()) ?? '').replace(/\D/g, '').slice(-4),
    callId: row.callId?.toString() ?? null,
    op: row.op,
    metaCode: row.metaCode,
    metaSubcode: row.metaSubcode,
    type: row.type,
    message: row.message,
    fbtraceId: row.fbtraceId,
    httpStatus: row.httpStatus,
    via: row.via,
    at: row.at.toISOString(),
  }));
};
