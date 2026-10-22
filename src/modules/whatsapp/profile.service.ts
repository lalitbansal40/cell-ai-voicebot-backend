import { Types } from 'mongoose';

import {
  isMetaApiError,
  type MetaBusinessProfile,
  type MetaBusinessProfileUpdate,
} from '../../core/meta';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { AppError, NotFoundError, ValidationError } from '../../shared/errors/app-error';

import { auditChannel, markNeedsReconnect, type WaActor } from './channel-status';
import { openSecret, type WhatsAppContext } from './context';

const CACHE_SEC = 300;
const cacheKey = (channelId: string) => `wa-profile-${channelId}`;

const access = async (ctx: WhatsAppContext, accountId: Types.ObjectId, channelId: string) => {
  const channel = await WhatsAppChannelModel.findOne({
    _id: new Types.ObjectId(channelId),
    accountId,
  })
    .select('+tokenSealed')
    .lean<WhatsAppChannelDoc>();
  if (!channel) throw new NotFoundError('WhatsApp number not found');
  if (
    !channel.tokenSealed ||
    !channel.phoneNumberId ||
    !['connected', 'restricted'].includes(channel.status)
  ) {
    throw new AppError('WHATSAPP_CHANNEL_NOT_READY');
  }
  return {
    channel,
    token: openSecret(ctx, channel.tokenSealed),
    phoneNumberId: channel.phoneNumberId,
  };
};

const metaCall = async <T>(
  ctx: WhatsAppContext,
  channel: WhatsAppChannelDoc,
  fn: () => Promise<T>,
) => {
  try {
    return await fn();
  } catch (err) {
    if (isMetaApiError(err)) {
      if (err.tokenInvalid) await markNeedsReconnect(ctx, channel);
      throw new AppError('META_API_ERROR', undefined, [
        { path: 'meta', message: `code ${String(err.code)}` },
      ]);
    }
    throw err;
  }
};

/** Business profile of a number (cached 5 min). */
export const getBusinessProfile = async (
  ctx: WhatsAppContext,
  accountId: Types.ObjectId,
  channelId: string,
): Promise<MetaBusinessProfile> => {
  const cached = await ctx.redis.get(cacheKey(channelId));
  const { channel, token, phoneNumberId } = await access(ctx, accountId, channelId);
  if (cached) return JSON.parse(cached) as MetaBusinessProfile;
  const profile = await metaCall(ctx, channel, () =>
    ctx.meta.getBusinessProfile(token, phoneNumberId),
  );
  await ctx.redis.set(cacheKey(channelId), JSON.stringify(profile), 'EX', CACHE_SEC);
  return profile;
};

/** Updates the profile (owners / admins); audit names the changed fields only. */
export const updateBusinessProfile = async (
  ctx: WhatsAppContext,
  accountId: Types.ObjectId,
  channelId: string,
  fields: MetaBusinessProfileUpdate,
  actor: WaActor,
): Promise<MetaBusinessProfile> => {
  const { channel, token, phoneNumberId } = await access(ctx, accountId, channelId);
  await metaCall(ctx, channel, () => ctx.meta.updateBusinessProfile(token, phoneNumberId, fields));
  await ctx.redis.del(cacheKey(channelId));
  await auditChannel(channel, 'whatsapp.profile_updated', actor, {
    fields: Object.keys(fields).filter((k) => k !== 'profilePictureHandle'),
    photo: Boolean(fields.profilePictureHandle),
  });
  return getBusinessProfile(ctx, accountId, channelId);
};

/** Width × height from a JPEG (SOF marker) or PNG (IHDR) header; null when unreadable. */
export const imageSize = (b: Buffer): { width: number; height: number } | null => {
  if (b.length > 24 && b.toString('latin1', 1, 4) === 'PNG') {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let pos = 2;
  while (pos + 9 < b.length) {
    if (b[pos] !== 0xff) return null;
    const marker = b[pos + 1] as number;
    const len = b.readUInt16BE(pos + 2);
    // SOF0–SOF15 except DHT (C4), JPG (C8), DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: b.readUInt16BE(pos + 5), width: b.readUInt16BE(pos + 7) };
    }
    pos += 2 + len;
  }
  return null;
};

export const PROFILE_PHOTO = { maxBytes: 5 * 1024 * 1024, minPx: 192, maxPx: 640 } as const;

/** New profile photo: JPEG / PNG, square 192–640 px, ≤ 5 MB → Meta upload handle → profile. */
export const updateProfilePhoto = async (
  ctx: WhatsAppContext,
  accountId: Types.ObjectId,
  channelId: string,
  bytes: Buffer,
  actor: WaActor,
): Promise<MetaBusinessProfile> => {
  if (bytes.length > PROFILE_PHOTO.maxBytes) {
    throw new AppError('WHATSAPP_MEDIA_TOO_LARGE', undefined, [
      { path: 'file', message: `At most ${String(PROFILE_PHOTO.maxBytes)} bytes` },
    ]);
  }
  const png = bytes.toString('latin1', 1, 4) === 'PNG';
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const size = png || jpeg ? imageSize(bytes) : null;
  if (!size) {
    throw new AppError('WHATSAPP_MEDIA_INVALID', undefined, [
      { path: 'file', message: 'not_allowed' },
    ]);
  }
  if (
    size.width !== size.height ||
    size.width < PROFILE_PHOTO.minPx ||
    size.width > PROFILE_PHOTO.maxPx
  ) {
    throw new ValidationError([
      {
        path: 'file',
        message: `The photo must be square, ${String(PROFILE_PHOTO.minPx)}–${String(PROFILE_PHOTO.maxPx)} px`,
      },
    ]);
  }
  const { channel, token } = await access(ctx, accountId, channelId);
  const handle = await metaCall(ctx, channel, () =>
    ctx.meta.uploadProfilePhoto(token, bytes, png ? 'image/png' : 'image/jpeg'),
  );
  return updateBusinessProfile(ctx, accountId, channelId, { profilePictureHandle: handle }, actor);
};
