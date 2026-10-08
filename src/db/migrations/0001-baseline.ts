import type { Migration } from '../migrate';

/** Marks the starting point of the migration history. */
export const baseline: Migration = {
  name: '0001-baseline',
  up: async () => {},
  down: async () => {},
};
