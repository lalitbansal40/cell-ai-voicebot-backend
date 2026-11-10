import type { Types } from 'mongoose';

import { getEnv } from '../../../config/env';
import { effectiveRateCard } from '../../../core/billing/rates';
import { pulsesFor, toReceiver10, VOICE_API_RETRY_INTERVALS } from '../../../core/voice-api/types';
import type { CallingWindow } from '../../../db/models/account.model';
import type {
  CampaignDoc,
  CampaignVoiceApi,
  CampaignWindow,
  SkipReason,
} from '../../../db/models/campaign.model';
import { FlowAudioModel, type FlowAudioDoc } from '../../../db/models/flow-audio.model';
import { AppError, type ErrorDetail } from '../../../shared/errors/app-error';
import { accountIvrs, accountVoiceApi, requireVoiceApi } from '../../voice-api/voice-api.service';
import { effectiveWindow, toMinutes } from '../window';

/**
 * VAPI: recorded-voice / IVR campaigns. Cell24x7 plays the audio itself; our settings are
 * the content (account audio or an assigned IVR), its retries, and the number rules.
 */

/** Cell24x7's limits on an uploaded audio. */
export const VOICE_AUDIO_MAX_MS = 120_000;
export const VOICE_AUDIO_MAX_BYTES = 10 * 1024 * 1024;
/** Ring and wrap-up seconds added per number for the ETA. */
export const VOICE_RING_SEC = 30;

/** What a draft holds (content may still be missing before validation). */
export type VoiceSettings = CampaignVoiceApi;

export const emptyVoiceApi = (): VoiceSettings => ({
  content: null,
  audioSec: 0,
  retries: 0,
  retryIntervalMin: 30,
  nextBatchNo: 1,
  batches: [],
  lastError: null,
});

/** A copy for a new draft / recurring run: same content, no batches. */
export const freshVoiceApi = (v: VoiceSettings | null | undefined): VoiceSettings | null =>
  v ? { ...v, nextBatchNo: 1, batches: [], lastError: null } : null;

/** Why a contact can't get a Cell24x7 call (10-digit Indian mobiles only). */
export const voiceSkipReason = (phoneE164: string): SkipReason | null =>
  toReceiver10(phoneE164) ? null : 'not_indian_mobile';

const audioOf = (accountId: Types.ObjectId, id: Types.ObjectId) =>
  FlowAudioModel.findOne({ _id: id, accountId }).lean<FlowAudioDoc>();

/** The minutes of a window (0 when empty). */
const windowMinutes = (w: CampaignWindow | null): number =>
  w ? Math.max(0, toMinutes(w.end) - toMinutes(w.start)) : 0;

/**
 * Problems of a voice campaign's settings (422 details). Fills `audioSec` and the IVR name.
 * Throws `VOICE_API_NOT_ENABLED` when the account may not use recorded voice.
 */
export const voiceSettingsProblems = async (
  accountId: Types.ObjectId,
  s: { voiceApi?: VoiceSettings | null; window: CampaignWindow },
  accountWindow: CallingWindow,
): Promise<ErrorDetail[]> => {
  const settings = await requireVoiceApi(accountId);
  const v = s.voiceApi;
  if (!v?.content) return [{ path: 'voiceApi.content', message: 'Choose the audio or an IVR' }];
  const details: ErrorDetail[] = [];
  if (v.content.kind === 'audio') {
    const audio = await audioOf(accountId, v.content.flowAudioId);
    if (!audio || audio.deletedAt) {
      details.push({ path: 'voiceApi.content.flowAudioId', message: 'Audio not found' });
    } else if (audio.durationMs > VOICE_AUDIO_MAX_MS || audio.bytes > VOICE_AUDIO_MAX_BYTES) {
      details.push({
        path: 'voiceApi.content.flowAudioId',
        message: 'The audio must be at most 120 seconds and 10 MB',
      });
    } else v.audioSec = Math.max(1, Math.ceil(audio.durationMs / 1000));
  } else {
    const ivrId = v.content.ivrId;
    const ivr = (await accountIvrs(accountId)).find((i) => i.id === ivrId);
    if (!ivr) {
      details.push({
        path: 'voiceApi.content.ivrId',
        message: 'This IVR is not available for this account',
      });
    } else {
      v.content = { kind: 'ivr', ivrId, ivrName: ivr.name };
      v.audioSec = settings.ivrEstimateSec;
    }
  }
  if (!Number.isInteger(v.retries) || v.retries < 0 || v.retries > 3) {
    details.push({ path: 'voiceApi.retries', message: 'From 0 to 3' });
  }
  if (!(VOICE_API_RETRY_INTERVALS as readonly number[]).includes(v.retryIntervalMin)) {
    details.push({
      path: 'voiceApi.retryIntervalMin',
      message: 'Choose 5, 10, 30, 60, 180 or 300',
    });
  }
  const window = effectiveWindow({
    account: accountWindow,
    campaign: s.window,
    live: true,
    recovery: false,
  });
  if (v.retries > 0 && v.retries * v.retryIntervalMin >= windowMinutes(window)) {
    details.push({
      path: 'voiceApi.retryIntervalMin',
      message: 'The redials would run past the calling window; use fewer retries or a shorter gap',
    });
  }
  return details;
};

/**
 * Why a running / starting voice campaign can't go on (audio deleted, IVR unassigned,
 * recorded voice turned off) — empty when it can.
 */
export const voiceRunProblems = async (campaign: CampaignDoc): Promise<ErrorDetail[]> => {
  const settings = await accountVoiceApi(campaign.accountId);
  if (!settings.enabled)
    return [{ path: 'voiceApi', message: 'Recorded voice is turned off for this account' }];
  const content = campaign.voiceApi?.content;
  if (!content) return [{ path: 'voiceApi.content', message: 'Choose the audio or an IVR' }];
  if (content.kind === 'audio') {
    const audio = await audioOf(campaign.accountId, content.flowAudioId);
    return audio && !audio.deletedAt
      ? []
      : [{ path: 'voiceApi.content.flowAudioId', message: 'The audio was deleted' }];
  }
  return (await accountIvrs(campaign.accountId)).some((i) => i.id === content.ivrId)
    ? []
    : [
        {
          path: 'voiceApi.content.ivrId',
          message: 'This IVR is no longer assigned to the account',
        },
      ];
};

export interface VoicePrice {
  pulsesPerNumber: number;
  perNumberMicros: number;
  /** The rate card has no recorded-voice price (start is refused). */
  notPriced: boolean;
}

/** Selling price per number: started 15 s pulses × the account's pulse price. */
export const voicePrice = async (
  accountId: Types.ObjectId,
  audioSec: number,
): Promise<VoicePrice> => {
  const card = await effectiveRateCard(accountId);
  const pulse = card.voiceApiPulseMicros;
  const pulsesPerNumber = pulsesFor(audioSec);
  return { pulsesPerNumber, perNumberMicros: pulse * pulsesPerNumber, notPriced: pulse <= 0 };
};

/** Rough dialing time on the gateway's lines (`VOICE_API_LINES`), seconds. */
export const voiceEtaSec = (numbers: number, audioSec: number): number =>
  Math.ceil(numbers / getEnv().VOICE_API_LINES) * (audioSec + VOICE_RING_SEC);

/** Start refusal with the exact code (direct start; a scheduled start fails the campaign). */
export const assertVoicePriced = (price: VoicePrice): void => {
  if (price.notPriced) throw new AppError('VOICE_API_NOT_PRICED');
};
