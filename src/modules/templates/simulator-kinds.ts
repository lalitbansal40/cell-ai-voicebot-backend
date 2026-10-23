/** DEV / TEST ONLY — template + billing simulator kinds (PHASE_11_PROMPT §1, 14 kinds). */
export const TEMPLATE_SIMULATOR_KINDS = [
  'template_approved',
  'template_rejected',
  'template_paused',
  'template_disabled',
  'template_quality_red',
  'template_category_changed',
  'template_components_changed',
  'user_stopped_marketing',
  'user_resumed_marketing',
  'pricing_tier_update',
  'run_template_sync',
  'run_hold_reaper',
  'run_whatsapp_reconcile',
  'late_billable_status',
] as const;
export type TemplateSimulatorKind = (typeof TEMPLATE_SIMULATOR_KINDS)[number];

export const isTemplateSimulatorKind = (kind: string): kind is TemplateSimulatorKind =>
  (TEMPLATE_SIMULATOR_KINDS as readonly string[]).includes(kind);

/** Which permission a kind needs (template kinds manage templates; customer kinds reply). */
export const templateSimulatorPermission = (
  kind: TemplateSimulatorKind,
): 'templates.manage' | 'inbox.reply' | 'whatsapp.manage' =>
  kind.startsWith('template_') || kind === 'run_template_sync'
    ? 'templates.manage'
    : kind.startsWith('user_') || kind === 'late_billable_status'
      ? 'inbox.reply'
      : 'whatsapp.manage';
