import type { HangupCause } from '../../core/telephony/types';
import type { CallEndReason, CallStatus } from '../../db/models/call.model';

/** Allowed status moves (PHASE_7_PLAN §1e); final statuses have none. */
export const CALL_TRANSITIONS: Record<CallStatus, readonly CallStatus[]> = {
  queued: ['ringing', 'canceled', 'failed'],
  ringing: ['in_progress', 'busy', 'no_answer', 'canceled', 'failed'],
  in_progress: ['completed', 'failed'],
  completed: [],
  failed: [],
  busy: [],
  no_answer: [],
  canceled: [],
};

export const canMove = (from: CallStatus, to: CallStatus): boolean =>
  CALL_TRANSITIONS[from].includes(to);

export const isFinal = (status: CallStatus): boolean => CALL_TRANSITIONS[status].length === 0;

/** Answered calls that ended because something broke. */
const BROKEN: readonly CallEndReason[] = ['engine_error', 'media_error', 'server_shutdown'];

/** Status of a call when it ends for `reason`. */
export const finalStatus = (reason: CallEndReason, answered: boolean): CallStatus => {
  if (!answered) {
    if (reason === 'busy' || reason === 'no_answer') return reason;
    // an answering machine took the call: for retries it counts as not answered
    if (reason === 'machine') return 'no_answer';
    return reason === 'canceled' || reason === 'customer_hangup' || reason === 'campaign_canceled'
      ? 'canceled'
      : 'failed';
  }
  return BROKEN.includes(reason) ? 'failed' : 'completed';
};

const BY_CAUSE: Record<HangupCause, CallEndReason> = {
  normal: 'customer_hangup',
  customer_hangup: 'customer_hangup',
  media_timeout: 'media_timeout',
  media_error: 'media_error',
  server_shutdown: 'server_shutdown',
  limit: 'limit',
  busy: 'busy',
  no_answer: 'no_answer',
  // a person declined the call (SIP 603): not retried (Phase 18)
  rejected: 'rejected_by_customer',
  invalid_number: 'invalid_number',
  machine: 'machine',
};

export const endReasonFor = (cause: HangupCause | undefined): CallEndReason =>
  BY_CAUSE[cause ?? 'customer_hangup'];
