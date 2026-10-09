import type { Migration } from '../migrate';

import { baseline } from './0001-baseline';
import { platformAccount } from './0002-platform-account';
import { syncSystemRolesMigration } from './0003-sync-system-roles';
import { dndManagePermission } from './0004-dnd-manage-permission';
import { walletsMigration } from './0005-wallets';
import { aiAgentsMigration } from './0006-ai-agents';

/** Ordered migration registry. Add new files here (no fs globbing — keeps builds simple). */
export const MIGRATIONS: Migration[] = [
  baseline,
  platformAccount,
  syncSystemRolesMigration,
  dndManagePermission,
  walletsMigration,
  aiAgentsMigration,
];
