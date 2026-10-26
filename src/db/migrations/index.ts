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
];
