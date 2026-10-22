/**
 * DEV / TEST ONLY — inbox simulator kinds (PHASE_10 §1o). `inbound_text` is also a
 * Phase 9 kind; the inbox runner handles it (it honours `from` / `text`).
 */
export const INBOX_SIMULATOR_KINDS = [
  'inbound_text',
  'inbound_image',
  'inbound_video',
  'inbound_audio',
  'inbound_voice',
  'inbound_document',
  'inbound_sticker',
  'inbound_location',
  'inbound_contacts',
  'inbound_button_reply',
  'inbound_list_reply',
  'inbound_template_button',
  'inbound_reaction',
  'inbound_reply',
  'inbound_forwarded',
  'inbound_ad_referral',
  'inbound_order',
  'inbound_nfm_reply',
  'inbound_unsupported',
  'inbound_number_changed',
  'inbound_deleted',
  'inbound_stop',
  'inbound_start',
  'inbound_stop_hinglish',
  'inbound_stop_hindi',
  'status_failed',
  'window_expired',
  'age_messages',
  'run_retention',
] as const;
export type InboxSimulatorKind = (typeof INBOX_SIMULATOR_KINDS)[number];
