import { playPrompt, retryOrExit, saveAs } from '../gather';
import { matchIntent } from '../intents';
import type { NodeHandler, NodeRuntime, Step } from '../runtime';
import type { TypedNode } from '../schema';

type Node = TypedNode<'gather_speech'>;

const language = (node: Node, rt: NodeRuntime) =>
  node.config.language === 'flow' ? rt.settings.language : node.config.language;

const wait = (node: Node, rt: NodeRuntime): Step => {
  rt.push({
    type: 'listen_speech',
    nodeId: node.id,
    timeoutSec: node.config.timeoutSec,
    language: language(node, rt),
  });
  return { wait: { kind: 'speech', nodeId: node.id, timeoutSec: node.config.timeoutSec } };
};

/** Intent by keywords, or by the AI classifier (falls back to keywords on failure). */
const findIntent = async (node: Node, text: string, rt: NodeRuntime): Promise<string | null> => {
  const { intents, matchMode } = node.config;
  if (matchMode === 'ai') {
    try {
      return await rt.effects.classifyIntent({
        nodeId: node.id,
        text,
        intents,
        inputId: rt.inputId,
      });
    } catch {
      rt.note(node.id, 'AI intent check failed — matched by keywords');
    }
  }
  return matchIntent(text, intents);
};

/** Saves what the customer said; optional intents pick the exit. */
export const gatherSpeechNode: NodeHandler<'gather_speech'> = {
  enter: async (node, rt) => {
    rt.state.retries = 0;
    const lang = language(node, rt);
    if (!(await playPrompt(node.id, node.config.prompt, lang, rt))) {
      return rt.fail(node.id, 'prompt audio missing');
    }
    return wait(node, rt);
  },
  input: async (node, input, rt) => {
    const c = node.config;
    const retry = (apology: string, exhausted: string) =>
      retryOrExit(node.id, c, apology, exhausted, language(node, rt), () => wait(node, rt), rt);
    const text = input.kind === 'speech' ? input.text.trim() : '';
    if (!text) return retry(c.noInputText, 'no_input');
    rt.setVar('last_speech', text);
    saveAs(c.saveAs, text, rt, node.id);
    if (!c.intents.length) return { exit: 'next' };
    const intent = await findIntent(node, text, rt);
    if (!intent || !c.intents.some((i) => i.id === intent)) return retry(c.invalidText, 'no_match');
    rt.setVar('last_intent', intent);
    return { exit: `intent_${intent}` };
  },
};
