import type { NodeHandler } from '../runtime';

/** Goodbye line, a disposition when none is set yet, then the end. */
export const hangupNode: NodeHandler<'hangup'> = {
  enter: (node, rt) => {
    if (node.config.text) rt.say(node.id, rt.render(node.config.text, node.id));
    if (node.config.disposition && !rt.state.outcome.disposition) {
      rt.state.outcome.disposition = node.config.disposition;
      rt.setVar('disposition', node.config.disposition);
    }
    return Promise.resolve({ end: 'hangup_node' as const });
  },
};
