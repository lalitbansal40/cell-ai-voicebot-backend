import type { HangupCause } from '../types';

/**
 * How a SIP call ended, from what Asterisk tells us (ADR 0050): the Q.850 cause of the
 * channel, the dial status of the attempt, whether it was answered and who hung up.
 */
export interface SipEnd {
  q850: number | null;
  /** ARI `Dial` status: ANSWER, BUSY, NOANSWER, CANCEL, CONGESTION, CHANUNAVAIL, … */
  dialStatus: string | null;
  answered: boolean;
  /** We asked for the hangup (bot ended the call, transfer done, shutdown). */
  ourHangup: boolean;
  /** Asterisk's AMD result for this call, if it ran. */
  amd: string | null;
}

const Q850_BEFORE_ANSWER: Record<number, HangupCause> = {
  1: 'invalid_number', // unallocated number (404)
  3: 'invalid_number', // no route to destination
  17: 'busy', // user busy (486)
  18: 'no_answer', // no user responding (408)
  19: 'no_answer', // no answer (480, ring timeout)
  20: 'no_answer', // subscriber absent (switched off)
  21: 'rejected', // call rejected (603, 403)
  22: 'invalid_number', // number changed (410)
  27: 'media_error', // destination out of order
  28: 'invalid_number', // invalid number format (484)
  34: 'media_error', // no circuit available (503)
  38: 'media_error', // network out of order (502)
  41: 'media_error', // temporary failure (500)
  42: 'media_error', // congestion
};

const DIAL_STATUS: Record<string, HangupCause> = {
  BUSY: 'busy',
  NOANSWER: 'no_answer',
  CANCEL: 'no_answer',
  CONGESTION: 'media_error',
  CHANUNAVAIL: 'media_error',
};

export const toHangupCause = (end: SipEnd): HangupCause => {
  if (end.amd === 'MACHINE') return 'machine';
  if (end.answered) {
    if (end.ourHangup) return 'normal';
    // normal clearing (16) or anything else after the answer: the far end hung up
    return end.q850 === 16 || end.q850 === 31 || end.q850 === null
      ? 'customer_hangup'
      : 'media_error';
  }
  if (end.q850 !== null) {
    const byCause = Q850_BEFORE_ANSWER[end.q850];
    if (byCause) return byCause;
  }
  if (end.dialStatus) {
    const byDial = DIAL_STATUS[end.dialStatus];
    if (byDial) return byDial;
  }
  // 16 before the answer: the attempt ended without an answer (ring timeout on some trunks)
  if (end.q850 === 16) return end.ourHangup ? 'normal' : 'no_answer';
  return 'media_error';
};

/** Plain words for support and the call page (T18.16). */
export const Q850_TEXT: Record<number, string> = {
  1: 'Number not in service',
  3: 'No route to the number',
  16: 'Call ended normally',
  17: 'Busy',
  18: 'No response',
  19: 'Not answered',
  20: 'Phone switched off or out of coverage',
  21: 'Call rejected',
  22: 'Number changed',
  27: 'Phone out of order',
  28: 'Number incomplete',
  31: 'Call ended',
  34: 'No line free at the carrier',
  38: 'Carrier network down',
  41: 'Carrier temporary failure',
  42: 'Carrier congested',
};
