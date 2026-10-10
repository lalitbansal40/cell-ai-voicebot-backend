import type { NodeHandler } from '../runtime';

/** Says a text (TTS in Phase 7, a bubble in the simulator). */
export const speakNode: NodeHandler<'speak'> = {
  enter: (node, rt) => {
    rt.say(node.id, rt.render(node.config.text, node.id), {
      language: node.config.language,
      interruptible: node.config.interruptible,
    });
    return Promise.resolve({ exit: 'next' });
  },
};
