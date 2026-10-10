import type { NodeHandler } from '../runtime';

/** Records the call outcome (last one wins). */
export const setDispositionNode: NodeHandler<'set_disposition'> = {
  enter: (node, rt) => {
    rt.state.outcome.disposition = node.config.disposition;
    rt.state.outcome.dispositionNote = node.config.note
      ? rt.render(node.config.note, node.id)
      : null;
    rt.setVar('disposition', node.config.disposition);
    return Promise.resolve({ exit: 'next' });
  },
};
