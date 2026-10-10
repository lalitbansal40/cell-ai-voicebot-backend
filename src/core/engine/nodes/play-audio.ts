import type { NodeHandler } from '../runtime';

/** Plays an uploaded file; a missing file says the fallback text or errors. */
export const playAudioNode: NodeHandler<'play_audio'> = {
  enter: async (node, rt) => {
    const audio = await rt.effects.loadAudio(node.config.audioId);
    if (audio) {
      rt.push({ type: 'play', nodeId: node.id, audioId: audio.id, audioName: audio.name });
      return { exit: 'next' };
    }
    if (node.config.fallbackText) {
      rt.say(node.id, rt.render(node.config.fallbackText, node.id));
      return { exit: 'next' };
    }
    return rt.fail(node.id, 'audio file missing');
  },
};
