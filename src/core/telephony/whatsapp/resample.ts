import { Resampler } from '../../voice/audio/resample';

import { OPUS_RATE } from './codec';

/** The runtime's call rate (`CALL_LIMITS.webSampleRate`); WhatsApp media runs at 48 kHz. */
export const LEG_RATE = 24_000;

/** Streaming 48 → 24 kHz (decoded Opus → the runtime) and 24 → 48 kHz (runtime → Opus). */
export const createLegResamplers = (): { down: Resampler; up: Resampler } => ({
  down: new Resampler(OPUS_RATE, LEG_RATE),
  up: new Resampler(LEG_RATE, OPUS_RATE),
});
