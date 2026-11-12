import type { Migration } from '../migrate';

import { baseline } from './0001-baseline';
import { platformAccount } from './0002-platform-account';
import { syncSystemRolesMigration } from './0003-sync-system-roles';
import { dndManagePermission } from './0004-dnd-manage-permission';
import { walletsMigration } from './0005-wallets';
import { aiAgentsMigration } from './0006-ai-agents';
import { flowsMigration } from './0007-flows';
import { callsMigration } from './0008-calls';
import { campaignsMigration } from './0009-campaigns';
import { whatsappMigration } from './0010-whatsapp';
import { inboxMigration } from './0011-inbox';
import { templatesBillingMigration } from './0012-templates-billing';
import { whatsappCallingMigration } from './0013-whatsapp-calling';
import { meta2026Migration } from './0014-meta-2026';
import { analyticsMigration } from './0015-analytics';
import { insightsMigration } from './0016-insights';
import { integrationsMigration } from './0017-integrations';
import { securityPrivacyMigration } from './0018-security-privacy';
import { sipLinesMigration } from './0019-sip-lines';
import { callPermissionRunsMigration } from './0020-call-permission-runs';
import { accountsResellersMigration } from './0021-accounts-resellers';
import { whatsappCampaignsMigration } from './0022-whatsapp-campaigns';
import { waCampaignRunsMigration } from './0023-wa-campaign-runs';
import { whatsappCallCampaignsMigration } from './0024-whatsapp-call-campaigns';
import { voiceApiMigration } from './0025-voice-api';
import { inboundSipMigration } from './0026-inbound-sip';
import { callModesMigration } from './0027-call-modes';
import { pinnacleProviderMigration } from './0028-pinnacle-provider';

/** Ordered migration registry. Add new files here (no fs globbing — keeps builds simple). */
export const MIGRATIONS: Migration[] = [
  baseline,
  platformAccount,
  syncSystemRolesMigration,
  dndManagePermission,
  walletsMigration,
  aiAgentsMigration,
  flowsMigration,
  callsMigration,
  campaignsMigration,
  whatsappMigration,
  inboxMigration,
  templatesBillingMigration,
  whatsappCallingMigration,
  meta2026Migration,
  analyticsMigration,
  insightsMigration,
  integrationsMigration,
  securityPrivacyMigration,
  sipLinesMigration,
  callPermissionRunsMigration,
  accountsResellersMigration,
  whatsappCampaignsMigration,
  waCampaignRunsMigration,
  whatsappCallCampaignsMigration,
  voiceApiMigration,
  inboundSipMigration,
  callModesMigration,
  pinnacleProviderMigration,
];
