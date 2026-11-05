import type { Request } from 'express';
import type { Types } from 'mongoose';

import type { LocalStorage } from '../../src/core/storage';
import { AccountModel } from '../../src/db/models/account.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { FlowAudioModel } from '../../src/db/models/flow-audio.model';
import { DEFAULT_RATE_CARD, RateCardModel } from '../../src/db/models/rate-card.model';
import { createCampaign } from '../../src/modules/campaigns/campaigns.service';

import { createTestAccount } from './auth';
import { fund } from './calls';
import { ALL_DAY } from './campaigns';

/** VAPI test world: recorded voice on, priced, funded, an audio file and contacts. */
export const reqFor = (accountId: Types.ObjectId, userId: Types.ObjectId) =>
  ({
    auth: {
      kind: 'user',
      accountId: accountId.toString(),
      userId: userId.toString(),
      roleKey: 'owner',
      permissions: new Set<string>(),
      account: {
        id: accountId.toString(),
        status: 'active',
        timezone: 'Asia/Kolkata',
        isPlatform: false,
      },
    },
    ip: '127.0.0.1',
  }) as unknown as Request;

export interface World {
  accountId: Types.ObjectId;
  req: Request;
  audioId: string;
  contactIds: string[];
}

let phoneN = 0;
/** An account with recorded voice on, a price, money, audio and contacts (last digits pick results). */
export const voiceWorld = async (
  storage: LocalStorage,
  opts: { priced?: boolean; enabled?: boolean; endings?: number[] } = {},
): Promise<World> => {
  const t = await createTestAccount();
  const owner = await t.addUser('owner');
  const accountId = t.account._id;
  await AccountModel.updateOne(
    { _id: accountId },
    {
      $set: {
        'settings.callingWindow': ALL_DAY,
        voiceApi: { enabled: opts.enabled ?? true, ivrIds: [101], ivrEstimateSec: 60 },
      },
    },
  );
  if (opts.priced ?? true) {
    await RateCardModel.create({
      accountId,
      ...DEFAULT_RATE_CARD,
      voiceApiPulseMicros: 500_000,
      effectiveFrom: new Date(0),
    });
  }
  await fund(accountId, 100_000_000);
  const fileKey = `accounts/${accountId.toString()}/flow-audio/reminder.wav`;
  await storage.put(fileKey, Buffer.from('RIFF-fake-wav'), { contentType: 'audio/wav' });
  const audio = await FlowAudioModel.create({
    accountId,
    name: 'Reminder',
    fileKey,
    format: 'wav',
    bytes: 13,
    durationMs: 24_000,
    sampleRate: 8000,
    channels: 1,
  });
  const contactIds: string[] = [];
  for (const end of opts.endings ?? [1, 6, 8, 9, 2]) {
    phoneN += 1;
    const c = await ContactModel.create({
      accountId,
      name: `Person ${String(phoneN)}`,
      phoneE164: `+9190083${String(phoneN).padStart(4, '0')}${String(end)}`,
      source: { type: 'manual' },
    });
    contactIds.push(c._id.toString());
  }
  // a landline: Cell24x7 calls 10-digit mobiles only
  phoneN += 1;
  const landline = await ContactModel.create({
    accountId,
    name: 'Office',
    phoneE164: `+91141${String(phoneN).padStart(7, '0')}`,
    source: { type: 'manual' },
  });
  contactIds.push(landline._id.toString());
  return {
    accountId,
    req: reqFor(accountId, owner.user._id),
    audioId: audio._id.toString(),
    contactIds,
  };
};

export const createVoiceCampaign = async (w: World, name: string, retries = 0) =>
  createCampaign(w.req, {
    name,
    mode: 'dry_run',
    line: 'voice_api',
    voiceApi: { content: { kind: 'audio', flowAudioId: w.audioId }, retries, retryIntervalMin: 30 },
    audience: { contactIds: w.contactIds },
    window: ALL_DAY,
  });
