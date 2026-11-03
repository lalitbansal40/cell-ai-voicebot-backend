import type { AccountVoiceLine } from '../../db/models/account.model';

/**
 * Which phone line a campaign or single call uses (Phase 18, ADR 0050): the SIP trunk
 * only when this install has it (`TELEPHONY_PROVIDER=sip`) **and** a superadmin moved
 * the account to it; everything else stays on the simulated test line.
 */
export const effectiveLine = (
  account: { voiceLine?: AccountVoiceLine | null } | null | undefined,
  env: { TELEPHONY_PROVIDER: 'dryrun' | 'sip' },
): 'sip' | 'dryrun' =>
  env.TELEPHONY_PROVIDER === 'sip' && account?.voiceLine === 'sip' ? 'sip' : 'dryrun';
