import { META_CALL_DIAG } from '../../config/limits';
import { MetaCallErrorModel } from '../../db/models/meta-call-error.model';
import type { WhatsAppChannelDoc } from '../../db/models/whatsapp-channel.model';
import { getLogger } from '../../shared/logger';
import type { WhatsAppContext, CallingVia } from '../whatsapp/context';

import { metaCallErrorOf, type MetaCallOperation } from './errors';

/** Best-effort diagnostic storage. A failed call must never fail again because logging did. */
export const recordMetaCallError = async (
  ctx: Pick<WhatsAppContext, 'redis'>,
  input: {
    channel: Pick<WhatsAppChannelDoc, '_id' | 'accountId'>;
    callId?: string | null;
    op: MetaCallOperation;
    err: unknown;
    via: CallingVia;
  },
): Promise<ReturnType<typeof metaCallErrorOf>> => {
  const shape = metaCallErrorOf(input.err, input.op);
  const redisCode = shape.metaCode ?? 'unknown';
  const key = `wa:metaerr:${input.channel._id.toString()}:${input.op}:${String(redisCode)}`;
  try {
    const claimed = await ctx.redis.set(key, '1', 'EX', META_CALL_DIAG.throttleSec, 'NX');
    if (claimed === 'OK') {
      await MetaCallErrorModel.create({
        accountId: input.channel.accountId,
        channelId: input.channel._id,
        callId: input.callId ?? null,
        op: shape.op,
        metaCode: shape.metaCode,
        metaSubcode: shape.metaSubcode,
        type: shape.type,
        message: shape.message.slice(0, 300),
        fbtraceId: shape.fbtraceId,
        httpStatus: shape.httpStatus,
        via: input.via,
        at: shape.at,
      });
    }
  } catch (err) {
    try {
      getLogger().warn(
        { op: input.op, channelId: input.channel._id.toString(), errName: (err as Error).name },
        'whatsapp call: could not record Meta error',
      );
    } catch {
      // Diagnostic writes are always best effort.
    }
  }
  return shape;
};
