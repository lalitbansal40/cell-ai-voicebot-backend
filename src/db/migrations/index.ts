import type { Migration } from '../migrate';

import { baseline } from './0001-baseline';

/** Ordered migration registry. Add new files here (no fs globbing — keeps builds simple). */
export const MIGRATIONS: Migration[] = [baseline];
