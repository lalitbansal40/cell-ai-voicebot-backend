import type { NodeHandler } from '../runtime';

/** In-call pause: waits for the host's `timer` input. */
export const waitNode: NodeHandler<'wait'> = {
  enter: (node, rt) => {
    rt.push({ type: 'pause', nodeId: node.id, seconds: node.config.seconds });
    return Promise.resolve({
      wait: { kind: 'timer', nodeId: node.id, seconds: node.config.seconds },
    });
  },
  input: (node, input, rt) =>
    Promise.resolve(
      input.kind === 'timer' ? { exit: 'next' } : rt.fail(node.id, 'unexpected input'),
    ),
};
