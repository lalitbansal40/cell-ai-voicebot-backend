import type { Migration } from '../migrate';

import { baseline } from './0001-baseline';
import { platformAccount } from './0002-platform-account';
import { syncSystemRolesMigration } from './0003-sync-system-roles';

/** Ordered migration registry. Add new files here (no fs globbing — keeps builds simple). */
export const MIGRATIONS: Migration[] = [baseline, platformAccount, syncSystemRolesMigration];
