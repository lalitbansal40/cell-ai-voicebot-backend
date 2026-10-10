import type { NodeHandler } from '../runtime';

/** Where every run begins. */
export const startNode: NodeHandler<'start'> = {
  enter: () => Promise.resolve({ exit: 'next' }),
};
