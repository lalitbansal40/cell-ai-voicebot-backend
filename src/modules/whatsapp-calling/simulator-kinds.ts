/**
 * DEV / TEST ONLY — WhatsApp calling simulator kinds (PHASE_12_PLAN §1p, 12 kinds). The
 * customer side runs on the fake Meta (its webhooks go through the real receiver);
 * Meta-side events are signed webhooks through the same pipeline as Meta's.
 */
export const CALLING_SIMULATOR_KINDS = [
  'user_call',
  'user_hangup',
  'user_dtmf',
  'permission_reply_accept',
  'permission_reply_permanent',
  'permission_reply_reject',
  'permission_expire',
  'calling_restricted',
  'calling_unrestricted',
  'settings_changed',
  'call_tier_update',
  'run_permission_sweep',
] as const;
export type CallingSimulatorKind = (typeof CALLING_SIMULATOR_KINDS)[number];

export const isCallingSimulatorKind = (kind: string): kind is CallingSimulatorKind =>
  (CALLING_SIMULATOR_KINDS as readonly string[]).includes(kind);

/** Customer actions need `inbox.reply`; number events `whatsapp.manage`. */
export const callingSimulatorPermission = (
  kind: CallingSimulatorKind,
): 'inbox.reply' | 'whatsapp.manage' =>
  kind.startsWith('user_') || kind.startsWith('permission_reply_')
    ? 'inbox.reply'
    : 'whatsapp.manage';
